import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSession, writeClaudeBranch, renderTranscript } from "./sessions.ts";

const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

function tmp(name: string, body: string): string {
	const dir = mkdtempSync(join(tmpdir(), "herdr-split-test-"));
	const file = join(dir, name);
	writeFileSync(file, body);
	return file;
}

const piRows = [
	{ type: "session", id: "sess", cwd: "/repo" },
	{ type: "model_change", id: "m1", parentId: null },
	{ type: "message", id: "u1", parentId: "m1", message: { role: "user", content: [{ type: "text", text: "first ask" }] } },
	{ type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "ls" } }] } },
	{ type: "message", id: "r1", parentId: "a1", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "file.txt" }] } },
	{ type: "message", id: "a1b", parentId: "r1", message: { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "done one" }] } },
	{ type: "custom", id: "c1", parentId: "a1b", customType: "pi-stamp" },
	{ type: "message", id: "u2", parentId: "c1", message: { role: "user", content: "second ask" } },
	{ type: "message", id: "a2", parentId: "u2", message: { role: "assistant", content: [{ type: "text", text: "done two" }] } },
	// abandoned sibling branch from u1's turn
	{ type: "message", id: "x1", parentId: "a1b", message: { role: "user", content: "abandoned" } },
];

test("pi: turns follow the leaf path and end before the next prompt", () => {
	const s = readSession("pi", tmp("p.jsonl", jsonl(piRows)), "a2");
	assert.equal(s.cwd, "/repo");
	assert.deepEqual(
		s.turns.map((t) => [t.index, t.prompt, t.cutId]),
		[
			[1, "first ask", "c1"],
			[2, "second ask", "a2"],
		],
	);
});

test("pi: default leaf is the last entry", () => {
	const s = readSession("pi", tmp("p.jsonl", jsonl(piRows)));
	assert.deepEqual(s.turns.map((t) => t.prompt), ["first ask", "abandoned"]);
});

test("pi: transcript up to a cut renders text, tool calls and results, never thinking", () => {
	const s = readSession("pi", tmp("p.jsonl", jsonl(piRows)), "a2");
	const md = renderTranscript(s, "c1");
	assert.match(md, /## User\n\nfirst ask/);
	assert.match(md, /Tool call: bash/);
	assert.match(md, /file\.txt/);
	assert.match(md, /done one/);
	assert.doesNotMatch(md, /hidden/);
	assert.doesNotMatch(md, /second ask/);
});

test("pi: unknown cut id is rejected", () => {
	const s = readSession("pi", tmp("p.jsonl", jsonl(piRows)), "a2");
	assert.throws(() => renderTranscript(s, "nope"), /Entry nope is not on the conversation path/);
});

const sid = "old-session";
const claudeRows = [
	{ type: "session-owner", sessionId: sid },
	{ type: "user", uuid: "cu1", parentUuid: null, sessionId: sid, cwd: "/repo", message: { role: "user", content: "hello claude" } },
	{ type: "assistant", uuid: "ca1", parentUuid: "cu1", sessionId: sid, message: { role: "assistant", content: [{ type: "tool_use", name: "Read", input: { file_path: "x" } }] } },
	{ type: "user", uuid: "cr1", parentUuid: "ca1", sessionId: sid, message: { role: "user", content: [{ type: "tool_result", content: "x body" }] } },
	{ type: "assistant", uuid: "ca1b", parentUuid: "cr1", sessionId: sid, message: { role: "assistant", content: [{ type: "text", text: "read it" }] } },
	{ type: "user", uuid: "meta", parentUuid: "ca1b", sessionId: sid, isMeta: true, message: { role: "user", content: "caveat" } },
	{ type: "user", uuid: "cu2", parentUuid: "meta", sessionId: sid, message: { role: "user", content: [{ type: "text", text: "next thing" }] } },
	{ type: "assistant", uuid: "ca2", parentUuid: "cu2", sessionId: sid, message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
	{ type: "user", uuid: "cu3", parentUuid: "ca2", sessionId: sid, message: { role: "user", content: "<command-name>/split</command-name>\n<command-args>claude</command-args>" } },
	{ type: "last-prompt", sessionId: sid },
];

test("claude: tool results and meta are not prompts; /split itself is excluded", () => {
	const s = readSession("claude", tmp(`${sid}.jsonl`, jsonl(claudeRows)));
	assert.equal(s.cwd, "/repo");
	assert.deepEqual(
		s.turns.map((t) => [t.index, t.prompt, t.cutId]),
		[
			[1, "hello claude", "meta"],
			[2, "next thing", "ca2"],
		],
	);
});

test("claude: branch copy keeps only the chain up to the cut with a new session id", () => {
	const file = tmp(`${sid}.jsonl`, jsonl(claudeRows));
	const s = readSession("claude", file);
	const out = writeClaudeBranch(s, "ca1b", "new-id");
	assert.equal(out, join(file, "..", "new-id.jsonl"));
	const rows = readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.deepEqual(rows.map((r) => r.uuid), ["cu1", "ca1", "cr1", "ca1b"]);
	assert.ok(rows.every((r) => r.sessionId === "new-id"));
	// source untouched
	assert.equal(readFileSync(file, "utf8"), jsonl(claudeRows));
});

test("claude: transcript renders tool_use and tool_result", () => {
	const s = readSession("claude", tmp(`${sid}.jsonl`, jsonl(claudeRows)));
	const md = renderTranscript(s, "ca2");
	assert.match(md, /Tool call: Read/);
	assert.match(md, /x body/);
	assert.match(md, /next thing/);
	assert.doesNotMatch(md, /caveat/);
});

test("long tool results are truncated in the transcript", () => {
	const rows = [
		{ type: "session", id: "s", cwd: "/r" },
		{ type: "message", id: "u", parentId: null, message: { role: "user", content: "go" } },
		{ type: "message", id: "r", parentId: "u", message: { role: "toolResult", toolName: "bash", content: "y".repeat(5000) } },
	];
	const s = readSession("pi", tmp("p.jsonl", jsonl(rows)));
	const md = renderTranscript(s, "r");
	assert.match(md, /\[truncated 3000 chars\]/);
});
