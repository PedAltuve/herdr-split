/**
 * Read Pi and Claude Code session files as one linear conversation path, split it into
 * turns (a user prompt plus everything the agent did until the next prompt), write a
 * truncated native Claude copy, and render a markdown transcript for cross-agent splits.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type SourceKind = "pi" | "claude";

export type Role = "user" | "assistant" | "tool" | "other";

export interface PathEntry {
	id: string;
	role: Role;
	/** True when this entry starts a turn (a real user prompt). */
	prompt: boolean;
	text: string;
	toolCalls: { name: string; input: unknown }[];
	raw: Record<string, unknown>;
}

export interface Turn {
	index: number;
	/** First line of the prompt, for pickers. */
	prompt: string;
	startId: string;
	/** Last entry of the turn: the branch keeps everything up to and including it. */
	cutId: string;
}

export interface Session {
	kind: SourceKind;
	file: string;
	cwd: string | undefined;
	path: PathEntry[];
	turns: Turn[];
}

const TOOL_RESULT_LIMIT = 2000;

function parseLines(file: string): Record<string, unknown>[] {
	const rows: Record<string, unknown>[] = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			rows.push(JSON.parse(line));
		} catch {
			// a partially written last line of a live session; ignore it
		}
	}
	return rows;
}

/** Walk parent links from the leaf to the root and return the root-first path. */
function walk<T>(byId: Map<string, T>, leafId: string, parentOf: (row: T) => string | null | undefined): T[] {
	const out: T[] = [];
	const seen = new Set<string>();
	let cur: string | null | undefined = leafId;
	while (cur && byId.has(cur) && !seen.has(cur)) {
		seen.add(cur);
		const row = byId.get(cur)!;
		out.push(row);
		cur = parentOf(row);
	}
	return out.reverse();
}

type Block = Record<string, unknown>;

function blocks(content: unknown): Block[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return Array.isArray(content) ? (content as Block[]) : [];
}

function blockText(content: unknown): string {
	return blocks(content)
		.map((b) => {
			if (b.type === "text" && typeof b.text === "string") return b.text;
			if (b.type === "tool_result") return blockText(b.content);
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function piEntry(row: Record<string, unknown>): PathEntry {
	const id = String(row.id);
	const msg = row.message as { role?: string; content?: unknown; toolName?: string } | undefined;
	if (row.type !== "message" || !msg) return { id, role: "other", prompt: false, text: "", toolCalls: [], raw: row };
	const all = blocks(msg.content);
	const toolCalls = all
		.filter((b) => b.type === "toolCall")
		.map((b) => ({ name: String(b.name ?? "tool"), input: b.arguments }));
	const text = blockText(msg.content);
	if (msg.role === "user") return { id, role: "user", prompt: text.trim().length > 0, text, toolCalls, raw: row };
	if (msg.role === "assistant") return { id, role: "assistant", prompt: false, text, toolCalls, raw: row };
	if (msg.role === "toolResult") return { id, role: "tool", prompt: false, text, toolCalls, raw: row };
	return { id, role: "other", prompt: false, text, toolCalls, raw: row };
}

function isSplitCommand(text: string): boolean {
	return /<command-name>\/split<\/command-name>/.test(text);
}

function claudeEntry(row: Record<string, unknown>): PathEntry {
	const id = String(row.uuid);
	const msg = row.message as { role?: string; content?: unknown } | undefined;
	if (!msg || (row.type !== "user" && row.type !== "assistant")) {
		return { id, role: "other", prompt: false, text: "", toolCalls: [], raw: row };
	}
	const all = blocks(msg.content);
	const toolCalls = all.filter((b) => b.type === "tool_use").map((b) => ({ name: String(b.name ?? "tool"), input: b.input }));
	const text = blockText(msg.content);
	if (row.type === "assistant") return { id, role: "assistant", prompt: false, text, toolCalls, raw: row };
	const isToolResult = all.some((b) => b.type === "tool_result");
	if (isToolResult) return { id, role: "tool", prompt: false, text, toolCalls, raw: row };
	if (row.isMeta) return { id, role: "other", prompt: false, text, toolCalls, raw: row };
	return { id, role: "user", prompt: text.trim().length > 0 && !isSplitCommand(text), text, toolCalls, raw: row };
}

const SPLIT_MARKUP = /^\s*(?:<command-message>[^<]*<\/command-message>\s*)?<command-name>\/split<\/command-name>(?:\s*<command-args>((?:(?!<\/?command-args>)[\s\S])*)<\/command-args>)?\s*$/;

/**
 * The `<command-args>` of the `/split` the user just typed, as Claude Code records it in the transcript
 * (`<command-message>split</command-message>\n<command-name>/split</command-name>\n<command-args>…</command-args>`)
 * before the command runs. Only the last user entry on the path counts, and its text must be exactly that
 * markup (whitespace aside); otherwise undefined, so an older /split or pasted markup is never replayed.
 */
export function lastSplitArgs(session: Session): string | undefined {
	if (session.kind !== "claude") throw new Error("lastSplitArgs needs a Claude session");
	// A tool-result entry that also carries user text is a newer user message, not a tool echo.
	const entry = session.path.findLast((e) => e.role === "user" || (e.role === "tool" && hasUserText(e)));
	if (!entry) return undefined;
	const match = SPLIT_MARKUP.exec(entry.text);
	return match ? (match[1] ?? "") : undefined;
}

function hasUserText(entry: PathEntry): boolean {
	const msg = (entry.raw as { message?: { content?: unknown } }).message;
	return blocks(msg?.content).some((b) => b.type === "text" && String(b.text ?? "").trim().length > 0);
}

function buildTurns(path: PathEntry[]): Turn[] {
	const turns: Turn[] = [];
	// Drop only the trailing /split invocation (the one running now); earlier ones stay in their turn.
	const splitAt = path.findLastIndex((e) => e.role === "user" && isSplitCommand(e.text));
	const usable = splitAt >= 0 ? path.slice(0, splitAt) : path;
	usable.forEach((entry, i) => {
		if (entry.prompt) {
			turns.push({
				index: turns.length + 1,
				prompt: entry.text.trim().split("\n")[0]!.slice(0, 120),
				startId: entry.id,
				cutId: entry.id,
			});
		} else if (turns.length > 0) {
			turns[turns.length - 1]!.cutId = usable[i]!.id;
		}
	});
	return turns;
}

/** Read a session as the path from its root to `leafId` (default: the last entry). */
export function readSession(kind: SourceKind, file: string, leafId?: string): Session {
	const rows = parseLines(file);
	if (kind === "pi") {
		const header = rows.find((r) => r.type === "session");
		const entries = rows.filter((r) => r.type !== "session" && typeof r.id === "string");
		const byId = new Map(entries.map((r) => [String(r.id), r]));
		const leaf = leafId ?? (entries.length ? String(entries[entries.length - 1]!.id) : "");
		const path = walk(byId, leaf, (r) => r.parentId as string | null).map(piEntry);
		return { kind, file, cwd: header?.cwd as string | undefined, path, turns: buildTurns(path) };
	}
	const entries = rows.filter((r) => typeof r.uuid === "string" && !r.isSidechain);
	const byId = new Map(entries.map((r) => [String(r.uuid), r]));
	const leaf = leafId ?? (entries.length ? String(entries[entries.length - 1]!.uuid) : "");
	const path = walk(byId, leaf, (r) => r.parentUuid as string | null).map(claudeEntry);
	const cwd = entries.find((r) => typeof r.cwd === "string")?.cwd as string | undefined;
	return { kind, file, cwd, path, turns: buildTurns(path) };
}

function pathUpTo(session: Session, cutId: string): PathEntry[] {
	const at = session.path.findIndex((e) => e.id === cutId);
	if (at < 0) throw new Error(`Entry ${cutId} is not on the conversation path`);
	return session.path.slice(0, at + 1);
}

/**
 * Write a native Claude Code session containing the path up to `cutId` under a new
 * session id, next to the source file so `claude --resume <newId>` finds it.
 */
export function writeClaudeBranch(session: Session, cutId: string, newId: string): string {
	if (session.kind !== "claude") throw new Error("writeClaudeBranch needs a Claude session");
	const kept = pathUpTo(session, cutId).map((e) => JSON.stringify({ ...e.raw, sessionId: newId }));
	const out = join(dirname(session.file), `${newId}.jsonl`);
	writeFileSync(out, kept.join("\n") + "\n", { flag: "wx" });
	return out;
}

function clip(text: string, limit: number): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n… [truncated ${text.length - limit} chars]`;
}

function fence(text: string): string {
	const ticks = text.includes("```") ? "````" : "```";
	return `${ticks}\n${text}\n${ticks}`;
}

/** Markdown transcript of the path up to `cutId`. Thinking blocks are never included. */
export function renderTranscript(session: Session, cutId: string): string {
	const parts: string[] = [];
	for (const e of pathUpTo(session, cutId)) {
		if (e.role === "user" && e.text.trim()) parts.push(`## User\n\n${e.text.trim()}`);
		if (e.role === "assistant") {
			const body: string[] = [];
			if (e.text.trim()) body.push(e.text.trim());
			for (const call of e.toolCalls) body.push(`Tool call: ${call.name}\n${fence(clip(JSON.stringify(call.input ?? {}, null, 2), TOOL_RESULT_LIMIT))}`);
			if (body.length) parts.push(`## Assistant\n\n${body.join("\n\n")}`);
		}
		if (e.role === "tool" && e.text.trim()) parts.push(`### Tool result\n\n${fence(clip(e.text.trim(), TOOL_RESULT_LIMIT))}`);
	}
	return parts.join("\n\n") + "\n";
}
