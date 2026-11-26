/**
 * Herdr side of a split: resolve the target agent, choose the dwindle direction, open the
 * pane, start the agent, and submit the split notice once the agent is ready.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderTranscript, writeClaudeBranch, type Session, type SourceKind } from "./sessions.ts";

/** A mistake in what the user asked for or configured; the CLI exits 2 on it. */
export class UsageError extends Error {}

export interface Agent {
	name: string;
	/** Shell command that starts the agent; branch arguments are appended. */
	exec: string;
	/** Session format the agent can resume natively, or null when it only gets a transcript. */
	format: SourceKind | null;
}

const BUILTIN: Record<string, Omit<Agent, "name">> = {
	claude: { exec: "claude", format: "claude" },
	gentle: { exec: "gentle-shell", format: "pi" },
	pi: { exec: "pi", format: "pi" },
	codex: { exec: "codex", format: null },
};

/** Parse a JSON object config file; any problem is a UsageError naming the file. */
export function readConfigObject(file: string): Record<string, unknown> {
	const fail = (reason: string) => new UsageError(`Cannot read ${file}: ${reason}`);
	let data: unknown;
	try {
		data = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		throw fail(error instanceof Error ? error.message : String(error));
	}
	if (typeof data !== "object" || data === null || Array.isArray(data)) throw fail("expected a JSON object");
	return data as Record<string, unknown>;
}

/** Built-in agents plus `{ "<name>": { "exec": "...", "format": "pi" | "claude" | null } }` from the config file. */
export function listAgents(configFile?: string): Agent[] {
	const agents: Record<string, Omit<Agent, "name">> = { ...BUILTIN };
	if (configFile && existsSync(configFile)) {
		const extra = readConfigObject(configFile) as Record<string, { exec: string; format?: SourceKind | null }>;
		for (const [key, value] of Object.entries(extra)) agents[key] = { exec: value.exec, format: value.format ?? null };
	}
	return Object.keys(agents)
		.sort()
		.map((name) => ({ name, ...agents[name]! }));
}

export function resolveAgent(name: string, configFile?: string): Agent {
	const agents = listAgents(configFile);
	const found = agents.find((a) => a.name === name);
	if (!found) throw new UsageError(`Unknown agent "${name}". Known agents: ${agents.map((a) => a.name).join(", ")}`);
	return found;
}

/**
 * Dwindle, the default tiling layout of Hyprland and bspwm: split along the longer side.
 * Terminal cells are about twice as tall as wide, so a pane is "wide" when width > 2 × height.
 */
export function splitDirection(rect: { width: number; height: number }): "right" | "down" {
	return rect.width > rect.height * 2 ? "right" : "down";
}

export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

function ending(opts: { role?: { name: string; prompt: string; source?: string }; prompt?: string }): string[] {
	const prompt = opts.prompt ? oneLine(opts.prompt) : "";
	if (opts.role) {
		const from = opts.role.source && opts.role.source !== "built-in" ? `, defined in ${opts.role.source}` : "";
		const role = `Your role in this split is "${opts.role.name}"${from}. Do this now: ${oneLine(opts.role.prompt)}`;
		return [prompt ? `${role} Additional instruction from the user, to act on now: ${prompt}` : role];
	}
	return [prompt ? `The user's instruction for you in this split, to act on now: ${prompt}` : "Reply with one short line confirming you understand, then wait for the user's next instruction."];
}

export function splitNotice(opts: {
	sourcePane: string;
	sourceAgent: string;
	cwd: string;
	transcript?: string;
	name?: string;
	/** Its prompt replaces the "confirm and wait" ending; a source other than "built-in" is named. */
	role?: { name: string; prompt: string; source?: string };
	/** The user's instruction to act on now; with a role it follows the role's instruction. */
	prompt?: string;
}): string {
	const parts = [
		`[herdr-split] This conversation is a split of another conversation that is still in progress in Herdr pane ${opts.sourcePane} (${opts.sourceAgent}).`,
		...(opts.name ? [`This split is named "${opts.name}".`] : []),
		opts.transcript
			? `Read the transcript at ${opts.transcript} first: it is that conversation up to the point the user branched from.`
			: "Everything above was copied from it up to the point the user branched from.",
		"Do not act on, continue, or redo any request from earlier messages: the original conversation owns them.",
		`The original conversation is probably still changing files in ${opts.cwd}: re-read files before you rely on them, avoid editing the files it is working on, and never revert, reset, stash, checkout or clean changes you did not make.`,
		...ending(opts),
	];
	return parts.join(" ");
}

export interface Target {
	command: string;
	transcript?: string;
}

/** Build the command that starts the target agent on the branch. */
export function prepareTarget(opts: {
	agent: Agent;
	session: Session;
	cutId: string;
	/** Pi session file already branched by the Pi adapter (Pi → Pi). */
	branched?: string;
	outDir: string;
	newId?: () => string;
}): Target {
	const { agent, session, cutId } = opts;
	if (agent.format === session.kind) {
		if (session.kind === "pi") {
			if (!opts.branched) throw new Error("Pi to Pi splits need the branched session file");
			return { command: `${agent.exec} --session ${shellQuote(opts.branched)}` };
		}
		const newId = (opts.newId ?? randomUUID)();
		writeClaudeBranch(session, cutId, newId);
		return { command: `${agent.exec} --resume ${shellQuote(newId)}` };
	}
	mkdirSync(opts.outDir, { recursive: true });
	const transcript = join(opts.outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${session.kind}-transcript.md`);
	writeFileSync(transcript, renderTranscript(session, cutId));
	return { command: agent.exec, transcript };
}

export interface HerdrResult {
	code: number;
	stdout: string;
	stderr: string;
}

export type Herdr = (args: string[]) => Promise<HerdrResult>;

async function call(herdr: Herdr, args: string[]): Promise<any> {
	const res = await herdr(args);
	if (res.code !== 0) throw new Error(`herdr ${args.slice(0, 2).join(" ")} failed: ${(res.stderr || res.stdout).trim()}`);
	return res.stdout.trim() ? JSON.parse(res.stdout) : {};
}

/** Split the source pane (dwindle), then run `command` in the new pane. Returns its id. */
export async function openSplitPane(
	herdr: Herdr,
	opts: { sourcePane: string; cwd: string; command: string; ratio: number; focus: boolean; name?: string; warn?: (message: string) => void },
): Promise<string> {
	const layout = await call(herdr, ["pane", "layout", "--pane", opts.sourcePane]);
	const panes: { pane_id: string; rect: { width: number; height: number } }[] = layout?.result?.layout?.panes ?? [];
	const rect = panes.find((p) => p.pane_id === opts.sourcePane)?.rect ?? { width: 0, height: 0 };
	const split = await call(herdr, [
		"pane",
		"split",
		opts.sourcePane,
		"--direction",
		splitDirection(rect),
		"--ratio",
		String(opts.ratio),
		"--cwd",
		opts.cwd,
		opts.focus ? "--focus" : "--no-focus",
	]);
	const pane = split?.result?.pane?.pane_id;
	if (typeof pane !== "string") throw new Error("herdr pane split returned no pane id");
	if (opts.name) {
		// Best effort: the pane exists, so a label that fails must not stop the agent from starting.
		try {
			await call(herdr, ["pane", "rename", pane, opts.name]);
		} catch (error) {
			(opts.warn ?? warnToStderr)(`could not rename pane ${pane} to "${opts.name}": ${(error as Error).message}`);
		}
	}
	await call(herdr, ["pane", "run", pane, opts.command]);
	return pane;
}

function warnToStderr(message: string): void {
	console.error(`herdr-split: ${message}`);
}

const READY = new Set(["idle", "done"]);

/**
 * Poll until Herdr sees a ready agent in `pane`, then submit the notice once.
 * `herdr agent prompt` only accepts agents Herdr itself started with `agent start`, which
 * cannot start gentle-shell, so the notice is typed with `pane run` (text + Enter).
 */
export async function waitAndNotify(
	herdr: Herdr,
	opts: { pane: string; notice: string; timeoutMs: number; intervalMs: number; name?: string; warn?: (message: string) => void },
): Promise<void> {
	const deadline = Date.now() + opts.timeoutMs;
	for (;;) {
		const res = await herdr(["agent", "get", opts.pane]);
		if (res.code === 0) {
			const status = JSON.parse(res.stdout)?.result?.agent?.agent_status;
			if (READY.has(status)) break;
		}
		if (Date.now() >= deadline) throw new Error(`agent in ${opts.pane} was not ready after ${opts.timeoutMs}ms`);
		await new Promise((r) => setTimeout(r, opts.intervalMs));
	}
	if (opts.name) {
		try {
			await call(herdr, ["agent", "rename", opts.pane, opts.name]);
		} catch (error) {
			(opts.warn ?? warnToStderr)(`could not rename the agent to "${opts.name}": ${(error as Error).message}`);
		}
	}
	await call(herdr, ["pane", "run", opts.pane, opts.notice]);
}
