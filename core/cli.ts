/**
 * herdr-split CLI. Its commands and options are documented in ./help.ts, which also renders
 * `herdr-split help` (and `--help`, `help --json`); keep OPTIONS in line with that table.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { helpJson, helpText, slashUsage, usageLine } from "./help.ts";
import { readSession, type SourceKind } from "./sessions.ts";
import { checkName, listRoles, resolveTarget, sourceAgentFor, type Role } from "./roles.ts";
import {
	listAgents,
	openSplitPane,
	prepareTarget,
	shellQuote,
	splitNotice,
	UsageError,
	waitAndNotify,
	type Agent,
	type Herdr,
} from "./split.ts";

const CLI = fileURLToPath(import.meta.url);

export const herdr: Herdr = (args) =>
	new Promise((resolve) => {
		const bin = process.env.HERDR_SPLIT_HERDR || "herdr";
		const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (c) => (stdout += c));
		child.stderr.on("data", (c) => (stderr += c));
		child.on("error", (e) => resolve({ code: 127, stdout, stderr: String(e) }));
		child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
	});

function configFile(file = "agents.json"): string {
	const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
	return join(base, "herdr-split", file);
}

/** The agent, role and name a command was asked for; every config and name error surfaces here, before any pane operation. */
function target(values: Values): { agent?: Agent; role?: Role; name?: string } {
	const name = checkName(values.name);
	const { agent, role } = resolveTarget({ agent: values.agent, role: values.role }, configFile(), configFile("roles.json"));
	return { agent, role, name: name ?? role?.name };
}

function outDir(): string {
	return join(process.env.TMPDIR || tmpdir(), "herdr-split");
}

function sourceKind(value: string | undefined): SourceKind {
	if (value === "pi" || value === "claude") return value;
	throw new UsageError(`--source-kind must be pi or claude, got "${value ?? ""}"`);
}

function sourcePane(value: string | undefined): string {
	const pane = value || process.env.HERDR_PANE_ID;
	if (!pane || process.env.HERDR_ENV !== "1") throw new UsageError("herdr-split must run inside a Herdr pane (HERDR_ENV=1)");
	return pane;
}

/** Find a Claude Code transcript by session id under ~/.claude/projects/<project>/<id>.jsonl. */
export function findClaudeSession(id: string): string {
	const root = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
	for (const project of existsSync(root) ? readdirSync(root) : []) {
		const file = join(root, project, `${id}.jsonl`);
		if (existsSync(file)) return file;
	}
	throw new UsageError(`No Claude Code session ${id} under ${root}`);
}

export const OPTIONS = {
	agent: { type: "string" },
	role: { type: "string" },
	name: { type: "string" },
	"source-kind": { type: "string" },
	session: { type: "string" },
	"session-id": { type: "string" },
	cut: { type: "string" },
	branched: { type: "string" },
	"source-agent": { type: "string" },
	"source-pane": { type: "string" },
	ratio: { type: "string", default: "0.5" },
	"no-focus": { type: "boolean", default: false },
	pane: { type: "string" },
	"notice-file": { type: "string" },
	timeout: { type: "string", default: "120000" },
	json: { type: "boolean", default: false },
	slash: { type: "boolean", default: false },
	help: { type: "boolean", short: "h", default: false },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>["values"];

function required(values: Values, name: keyof Values): string {
	const v = values[name];
	if (typeof v !== "string" || !v) throw new UsageError(`--${String(name)} is required`);
	return v;
}

function ratio(values: Values): number {
	const r = Number(values.ratio);
	if (!(r > 0 && r < 1)) throw new UsageError(`--ratio must be between 0 and 1, got "${values.ratio}"`);
	return r;
}

/** The agent Herdr sees in the source pane (e.g. "gentle-shell"), unless given explicitly. */
async function sourceAgent(values: Values, pane: string, kind: SourceKind): Promise<string> {
	if (values["source-agent"]) return values["source-agent"];
	const res = await herdr(["agent", "get", pane]);
	try {
		const name = JSON.parse(res.stdout)?.result?.agent?.agent;
		if (res.code === 0 && typeof name === "string" && name) return name;
	} catch {
		// fall back to the session kind
	}
	return kind;
}

/** Start `notify` detached so the caller returns at once; its output goes to a log file. */
function spawnNotify(pane: string, notice: string, name?: string): string {
	mkdirSync(outDir(), { recursive: true });
	const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
	const noticeFile = join(outDir(), `${stamp}-notice.txt`);
	const log = join(outDir(), `${stamp}-notify.log`);
	writeFileSync(noticeFile, notice);
	const fd = openSync(log, "a");
	spawn(process.execPath, [CLI, "notify", "--pane", pane, "--notice-file", noticeFile, ...(name ? ["--name", name] : [])], {
		detached: true,
		stdio: ["ignore", fd, fd],
		env: process.env,
	}).unref();
	return log;
}

async function launch(values: Values): Promise<void> {
	const { agent: resolved, role, name } = target(values);
	const kind = sourceKind(values["source-kind"]);
	const src = sourcePane(values["source-pane"]);
	const session = readSession(kind, required(values, "session"));
	const cutId = required(values, "cut");
	const cwd = session.cwd || process.cwd();
	let source = resolved ? undefined : await sourceAgent(values, src, kind);
	const agent = resolved ?? sourceAgentFor(source!, kind, configFile());
	const plan = prepareTarget({ agent, session, cutId, branched: values.branched, outDir: outDir() });
	const pane = await openSplitPane(herdr, { sourcePane: src, cwd, command: plan.command, ratio: ratio(values), focus: !values["no-focus"], name });
	source ??= await sourceAgent(values, src, kind);
	const notice = splitNotice({ sourcePane: src, sourceAgent: source, cwd, transcript: plan.transcript, name, role });
	const log = spawnNotify(pane, notice, name);
	console.log(JSON.stringify({ pane, agent: agent.name, command: plan.command, transcript: plan.transcript ?? null, log }));
}

async function split(values: Values): Promise<void> {
	const { agent: resolved, role, name } = target(values);
	const kind = sourceKind(values["source-kind"]);
	const src = sourcePane(values["source-pane"]);
	const file = values.session || (kind === "claude" && values["session-id"] ? findClaudeSession(values["session-id"]) : undefined);
	if (!file) throw new UsageError("--session or --session-id is required");
	const session = readSession(kind, file);
	if (session.turns.length === 0) throw new UsageError("The conversation has no messages to branch from yet");
	const cwd = session.cwd || process.cwd();
	const source = await sourceAgent(values, src, kind);
	const agent = resolved ?? sourceAgentFor(source, kind, configFile());
	const args = [
		process.execPath, CLI, "pick",
		"--agent", agent.name,
		...(role ? ["--role", role.name] : []),
		...(name ? ["--name", name] : []),
		"--source-kind", kind,
		"--session", file,
		"--source-pane", src,
		"--source-agent", source,
	];
	const command = args.map(shellQuote).join(" ");
	const pane = await openSplitPane(herdr, { sourcePane: src, cwd, command, ratio: ratio(values), focus: !values["no-focus"], name });
	console.log(`herdr-split: pick the branch point in pane ${pane}; ${agent.name} starts there after you choose.`);
}

/** Runs inside the new pane: choose a turn with fzf, then become the target agent. */
async function pick(values: Values): Promise<number> {
	const { agent: resolved, role, name } = target(values);
	const agent = resolved!;
	const kind = sourceKind(values["source-kind"]);
	const src = required(values, "source-pane");
	const self = sourcePane(undefined);
	const session = readSession(kind, required(values, "session"));
	const lines = [...session.turns].reverse().map((t) => `${t.index}\t${t.index}. ${t.prompt.replace(/\t/g, " ")}`);
	const fzf = spawnSync("fzf", ["--delimiter", "\t", "--with-nth", "2..", "--no-sort", "--header", "Branch after which turn? The branch keeps that turn and everything before it. Esc cancels."], {
		input: lines.join("\n"),
		stdio: ["pipe", "pipe", "inherit"],
		encoding: "utf8",
	});
	if (fzf.error) throw new UsageError(`fzf is required for picking: ${fzf.error.message}`);
	const index = Number(String(fzf.stdout).split("\t")[0]);
	const turn = session.turns.find((t) => t.index === index);
	if (fzf.status !== 0 || !turn) {
		console.error("herdr-split: split cancelled");
		return 130;
	}
	const cwd = session.cwd || process.cwd();
	const plan = prepareTarget({ agent, session, cutId: turn.cutId, outDir: outDir() });
	spawnNotify(self, splitNotice({ sourcePane: src, sourceAgent: values["source-agent"] || kind, cwd, transcript: plan.transcript, name, role }), name);
	const run = spawnSync("sh", ["-c", plan.command], { stdio: "inherit", cwd });
	return run.status ?? 1;
}

async function notify(values: Values): Promise<void> {
	const notice = readFileSync(required(values, "notice-file"), "utf8");
	await waitAndNotify(herdr, { pane: required(values, "pane"), notice, timeoutMs: Number(values.timeout), intervalMs: 500, name: checkName(values.name) });
	console.log(`notice submitted to ${values.pane}`);
}

export async function main(argv: string[]): Promise<number> {
	try {
		const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
		const [command] = positionals;
		if ((values.json || values.slash) && command !== "help" && !values.help) throw new UsageError("--json and --slash only work with help");
		if (values.json && values.slash) throw new UsageError("--json and --slash cannot be combined");
		if (command === "help" || values.help) {
			const agents = listAgents(configFile());
			const roles = listRoles(configFile("roles.json"), agents);
			if (values.json) console.log(JSON.stringify(helpJson(agents, roles), null, 2));
			else if (values.slash) console.log(`herdr-split: usage: ${slashUsage(agents, roles)}`);
			else process.stdout.write(helpText(agents, roles));
		} else if (command === "launch") await launch(values);
		else if (command === "split") await split(values);
		else if (command === "pick") return await pick(values);
		else if (command === "notify") await notify(values);
		else if (command === "roles") {
			for (const r of listRoles(configFile("roles.json"), listAgents(configFile()))) console.log(`${r.name}\t${r.agent ?? "-"}\t${r.prompt}`);
		} else if (command === "agents") {
			for (const a of listAgents(configFile())) console.log(`${a.name}\t${a.exec}`);
		} else throw new UsageError(`${usageLine()}${command ? ` (unknown command "${command}")` : ""}`);
		return 0;
	} catch (error) {
		console.error(`herdr-split: ${(error as Error).message}`);
		return error instanceof UsageError || /^Unknown agent/.test((error as Error).message) || (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS") ? 2 : 1;
	}
}

if (process.argv[1] === CLI) process.exitCode = await main(process.argv.slice(2));
