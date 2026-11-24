/**
 * herdr-split CLI.
 *
 *   herdr-split launch --agent <name> --source-kind pi|claude --session <file> --cut <id>
 *                      [--branched <file>] [--source-agent <name>] [--ratio 0.5] [--no-focus]
 *       Split the calling Herdr pane and continue the conversation in <agent>. Used by
 *       adapters that already chose the branch point (the Pi extension).
 *
 *   herdr-split split --agent <name> --source-kind pi|claude (--session <file> | --session-id <id>)
 *                     [--source-agent <name>] [--ratio 0.5] [--no-focus]
 *       Split the calling pane and pick the branch point with fzf inside the new pane.
 *       Used by adapters that cannot show a picker (the Claude Code command).
 *
 *   herdr-split agents     List known agents.
 *
 * Internal: `pick` (runs inside the new pane) and `notify` (submits the split notice).
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readSession, type SourceKind } from "./sessions.ts";
import {
	listAgents,
	openSplitPane,
	prepareTarget,
	resolveAgent,
	shellQuote,
	splitNotice,
	waitAndNotify,
	type Herdr,
} from "./split.ts";

const CLI = fileURLToPath(import.meta.url);

class UsageError extends Error {}

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

function configFile(): string {
	const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
	return join(base, "herdr-split", "agents.json");
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

const OPTIONS = {
	agent: { type: "string" },
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
function spawnNotify(pane: string, notice: string): string {
	mkdirSync(outDir(), { recursive: true });
	const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
	const noticeFile = join(outDir(), `${stamp}-notice.txt`);
	const log = join(outDir(), `${stamp}-notify.log`);
	writeFileSync(noticeFile, notice);
	const fd = openSync(log, "a");
	spawn(process.execPath, [CLI, "notify", "--pane", pane, "--notice-file", noticeFile], {
		detached: true,
		stdio: ["ignore", fd, fd],
		env: process.env,
	}).unref();
	return log;
}

async function launch(values: Values): Promise<void> {
	const agent = resolveAgent(required(values, "agent"), configFile());
	const kind = sourceKind(values["source-kind"]);
	const src = sourcePane(values["source-pane"]);
	const session = readSession(kind, required(values, "session"));
	const cutId = required(values, "cut");
	const cwd = session.cwd || process.cwd();
	const target = prepareTarget({ agent, session, cutId, branched: values.branched, outDir: outDir() });
	const pane = await openSplitPane(herdr, { sourcePane: src, cwd, command: target.command, ratio: ratio(values), focus: !values["no-focus"] });
	const notice = splitNotice({ sourcePane: src, sourceAgent: await sourceAgent(values, src, kind), cwd, transcript: target.transcript });
	const log = spawnNotify(pane, notice);
	console.log(JSON.stringify({ pane, agent: agent.name, command: target.command, transcript: target.transcript ?? null, log }));
}

async function split(values: Values): Promise<void> {
	const agent = resolveAgent(required(values, "agent"), configFile());
	const kind = sourceKind(values["source-kind"]);
	const src = sourcePane(values["source-pane"]);
	const file = values.session || (kind === "claude" && values["session-id"] ? findClaudeSession(values["session-id"]) : undefined);
	if (!file) throw new UsageError("--session or --session-id is required");
	const session = readSession(kind, file);
	if (session.turns.length === 0) throw new UsageError("The conversation has no messages to branch from yet");
	const cwd = session.cwd || process.cwd();
	const args = [
		process.execPath, CLI, "pick",
		"--agent", agent.name,
		"--source-kind", kind,
		"--session", file,
		"--source-pane", src,
		"--source-agent", await sourceAgent(values, src, kind),
	];
	const command = args.map(shellQuote).join(" ");
	const pane = await openSplitPane(herdr, { sourcePane: src, cwd, command, ratio: ratio(values), focus: !values["no-focus"] });
	console.log(`herdr-split: pick the branch point in pane ${pane}; ${agent.name} starts there after you choose.`);
}

/** Runs inside the new pane: choose a turn with fzf, then become the target agent. */
async function pick(values: Values): Promise<number> {
	const agent = resolveAgent(required(values, "agent"), configFile());
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
	const target = prepareTarget({ agent, session, cutId: turn.cutId, outDir: outDir() });
	spawnNotify(self, splitNotice({ sourcePane: src, sourceAgent: values["source-agent"] || kind, cwd, transcript: target.transcript }));
	const run = spawnSync("sh", ["-c", target.command], { stdio: "inherit", cwd });
	return run.status ?? 1;
}

async function notify(values: Values): Promise<void> {
	const notice = readFileSync(required(values, "notice-file"), "utf8");
	await waitAndNotify(herdr, { pane: required(values, "pane"), notice, timeoutMs: Number(values.timeout), intervalMs: 500 });
	console.log(`notice submitted to ${values.pane}`);
}

export async function main(argv: string[]): Promise<number> {
	try {
		const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
		const [command] = positionals;
		if (command === "launch") await launch(values);
		else if (command === "split") await split(values);
		else if (command === "pick") return await pick(values);
		else if (command === "notify") await notify(values);
		else if (command === "agents") {
			for (const a of listAgents(configFile())) console.log(`${a.name}\t${a.exec}`);
		} else throw new UsageError(`Usage: herdr-split <launch|split|agents> [options]${command ? ` (unknown command "${command}")` : ""}`);
		return 0;
	} catch (error) {
		console.error(`herdr-split: ${(error as Error).message}`);
		return error instanceof UsageError || /^Unknown agent/.test((error as Error).message) || (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS") ? 2 : 1;
	}
}

if (process.argv[1] === CLI) process.exitCode = await main(process.argv.slice(2));
