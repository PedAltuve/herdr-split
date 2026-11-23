/**
 * Herdr side of a split: resolve the target agent, choose the dwindle direction, open the
 * pane, start the agent, and submit the split notice once the agent is ready.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderTranscript, writeClaudeBranch, type Session, type SourceKind } from "./sessions.ts";

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

/** Built-in agents plus `{ "<name>": { "exec": "...", "format": "pi" | "claude" | null } }` from the config file. */
export function listAgents(configFile?: string): Agent[] {
	const agents: Record<string, Omit<Agent, "name">> = { ...BUILTIN };
	if (configFile && existsSync(configFile)) {
		const extra = JSON.parse(readFileSync(configFile, "utf8")) as Record<string, { exec: string; format?: SourceKind | null }>;
		for (const [key, value] of Object.entries(extra)) agents[key] = { exec: value.exec, format: value.format ?? null };
	}
	return Object.keys(agents)
		.sort()
		.map((name) => ({ name, ...agents[name]! }));
}

export function resolveAgent(name: string, configFile?: string): Agent {
	const agents = listAgents(configFile);
	const found = agents.find((a) => a.name === name);
	if (!found) throw new Error(`Unknown agent "${name}". Known agents: ${agents.map((a) => a.name).join(", ")}`);
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

export function splitNotice(opts: { sourcePane: string; sourceAgent: string; cwd: string; transcript?: string }): string {
	const parts = [
		`[herdr-split] This conversation is a split of another conversation that is still in progress in Herdr pane ${opts.sourcePane} (${opts.sourceAgent}).`,
		opts.transcript
			? `Read the transcript at ${opts.transcript} first: it is that conversation up to the point the user branched from.`
			: "Everything above was copied from it up to the point the user branched from.",
		"Do not act on, continue, or redo any request from earlier messages: the original conversation owns them.",
		`The original conversation is probably still changing files in ${opts.cwd}: re-read files before you rely on them, avoid editing the files it is working on, and never revert, reset, stash, checkout or clean changes you did not make.`,
		"Reply with one short line confirming you understand, then wait for the user's next instruction.",
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
	opts: { sourcePane: string; cwd: string; command: string; ratio: number; focus: boolean },
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
	await call(herdr, ["pane", "run", pane, opts.command]);
	return pane;
}

const READY = new Set(["idle", "done"]);

/** Poll until Herdr sees a ready agent in `pane`, then submit the notice once. */
export async function waitAndNotify(
	herdr: Herdr,
	opts: { pane: string; notice: string; timeoutMs: number; intervalMs: number },
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
	await call(herdr, ["agent", "prompt", opts.pane, opts.notice]);
}
