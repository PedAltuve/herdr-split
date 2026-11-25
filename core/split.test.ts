import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	resolveAgent,
	splitDirection,
	splitNotice,
	prepareTarget,
	openSplitPane,
	waitAndNotify,
	shellQuote,
	type Herdr,
} from "./split.ts";
import { readSession } from "./sessions.ts";

const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const dir = () => mkdtempSync(join(tmpdir(), "herdr-split-test-"));

test("known agents resolve to their executable and session format", () => {
	assert.deepEqual(resolveAgent("claude"), { name: "claude", exec: "claude", format: "claude" });
	assert.deepEqual(resolveAgent("gentle"), { name: "gentle", exec: "gentle-shell", format: "pi" });
	assert.deepEqual(resolveAgent("pi"), { name: "pi", exec: "pi", format: "pi" });
	assert.deepEqual(resolveAgent("codex"), { name: "codex", exec: "codex", format: null });
});

test("unknown agent is rejected with the known list", () => {
	assert.throws(() => resolveAgent("vim"), { message: 'Unknown agent "vim". Known agents: claude, codex, gentle, pi' });
});

test("a config file adds or overrides agents", () => {
	const d = dir();
	const cfg = join(d, "agents.json");
	writeFileSync(cfg, JSON.stringify({ opencode: { exec: "opencode" }, gentle: { exec: "gentle-shell --isolated", format: "pi" } }));
	assert.deepEqual(resolveAgent("opencode", cfg), { name: "opencode", exec: "opencode", format: null });
	assert.equal(resolveAgent("gentle", cfg).exec, "gentle-shell --isolated");
	assert.throws(() => resolveAgent("vim", cfg), /Known agents: claude, codex, gentle, opencode, pi/);
});

test("dwindle: wide panes split right, tall panes split down", () => {
	assert.equal(splitDirection({ width: 263, height: 69 }), "right");
	assert.equal(splitDirection({ width: 131, height: 69 }), "down");
	assert.equal(splitDirection({ width: 138, height: 69 }), "down");
	assert.equal(splitDirection({ width: 139, height: 69 }), "right");
});

test("notice tells the agent not to act on earlier messages and that the original keeps changing files", () => {
	const n = splitNotice({ sourcePane: "w1:p1", sourceAgent: "gentle-shell", cwd: "/repo" });
	assert.match(n, /split of another conversation that is still in progress/i);
	assert.match(n, /pane w1:p1/);
	assert.match(n, /Do not act on, continue, or redo any request from earlier messages/);
	assert.match(n, /probably still changing files in \/repo/);
	assert.match(n, /never revert, reset, stash, checkout or clean changes you did not make/);
	assert.match(n, /wait for the user's next instruction/);
	assert.doesNotMatch(n, /transcript/i);
	assert.doesNotMatch(n, /\n/);
	const withFile = splitNotice({ sourcePane: "w1:p1", sourceAgent: "claude", cwd: "/repo", transcript: "/tmp/t.md" });
	assert.match(withFile, /Read the transcript at \/tmp\/t\.md first/);
});

test("shellQuote survives single quotes", () => {
	assert.equal(shellQuote("a b"), "'a b'");
	assert.equal(shellQuote("it's"), "'it'\\''s'");
});

const piFile = () => {
	const f = join(dir(), "s.jsonl");
	writeFileSync(
		f,
		jsonl([
			{ type: "session", id: "s", cwd: "/repo" },
			{ type: "message", id: "u1", parentId: null, message: { role: "user", content: "do it" } },
			{ type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: "done" } },
		]),
	);
	return f;
};

test("pi source to pi agent resumes the branched session file", () => {
	const t = prepareTarget({ agent: resolveAgent("gentle"), session: readSession("pi", piFile()), cutId: "a1", branched: "/s/b.jsonl", outDir: dir() });
	assert.equal(t.command, "gentle-shell --session '/s/b.jsonl'");
	assert.equal(t.transcript, undefined);
});

test("pi source to pi agent without a branched file is an error", () => {
	assert.throws(
		() => prepareTarget({ agent: resolveAgent("pi"), session: readSession("pi", piFile()), cutId: "a1", outDir: dir() }),
		/Pi to Pi splits need the branched session file/,
	);
});

test("pi source to claude writes a transcript and starts claude fresh", () => {
	const out = dir();
	const t = prepareTarget({ agent: resolveAgent("claude"), session: readSession("pi", piFile()), cutId: "a1", outDir: out });
	assert.equal(t.command, "claude");
	assert.ok(t.transcript && t.transcript.startsWith(out) && existsSync(t.transcript));
	assert.match(readFileSync(t.transcript, "utf8"), /do it/);
});

test("claude source to claude resumes a truncated native copy", () => {
	const f = join(dir(), "old.jsonl");
	writeFileSync(
		f,
		jsonl([
			{ type: "user", uuid: "u", parentUuid: null, sessionId: "old", cwd: "/repo", message: { role: "user", content: "hi" } },
			{ type: "assistant", uuid: "a", parentUuid: "u", sessionId: "old", message: { role: "assistant", content: [{ type: "text", text: "yo" }] } },
		]),
	);
	const t = prepareTarget({ agent: resolveAgent("claude"), session: readSession("claude", f), cutId: "a", outDir: dir(), newId: () => "new" });
	assert.equal(t.command, "claude --resume 'new'");
	assert.ok(existsSync(join(f, "..", "new.jsonl")));
});

function fakeHerdr(responses: Record<string, unknown[]>): Herdr & { calls: string[][] } {
	const calls: string[][] = [];
	const h = async (args: string[]) => {
		calls.push(args);
		const key = args.slice(0, 2).join(" ");
		const queue = responses[key];
		const next = queue && queue.length > 1 ? queue.shift() : queue?.[0];
		if (next instanceof Error) return { code: 1, stdout: "", stderr: next.message };
		return { code: 0, stdout: JSON.stringify(next ?? {}), stderr: "" };
	};
	return Object.assign(h, { calls });
}

test("openSplitPane splits the source pane by its shape and runs the command in the new pane", async () => {
	const herdr = fakeHerdr({
		"pane layout": [{ result: { layout: { panes: [{ pane_id: "w1:p1", rect: { width: 200, height: 50 } }] } } }],
		"pane split": [{ result: { pane: { pane_id: "w1:p9" } } }],
		"pane run": [{}],
	});
	const pane = await openSplitPane(herdr, { sourcePane: "w1:p1", cwd: "/repo", command: "claude", ratio: 0.5, focus: true });
	assert.equal(pane, "w1:p9");
	assert.deepEqual(herdr.calls, [
		["pane", "layout", "--pane", "w1:p1"],
		["pane", "split", "w1:p1", "--direction", "right", "--ratio", "0.5", "--cwd", "/repo", "--focus"],
		["pane", "run", "w1:p9", "claude"],
	]);
});

test("openSplitPane surfaces herdr errors", async () => {
	const herdr = fakeHerdr({
		"pane layout": [{ result: { layout: { panes: [{ pane_id: "w1:p1", rect: { width: 80, height: 50 } }] } } }],
		"pane split": [new Error('{"error":{"code":"x","message":"no room"}}')],
	});
	await assert.rejects(openSplitPane(herdr, { sourcePane: "w1:p1", cwd: "/r", command: "c", ratio: 0.5, focus: false }), /herdr pane split failed: .*no room/);
});

test("waitAndNotify polls until the agent is idle, then prompts it once", async () => {
	const herdr = fakeHerdr({
		"agent get": [new Error("agent_not_running"), { result: { agent: { agent_status: "unknown" } } }, { result: { agent: { agent_status: "idle" } } }],
		"pane run": [{}],
	});
	await waitAndNotify(herdr, { pane: "w1:p9", notice: "hello", timeoutMs: 5000, intervalMs: 1 });
	assert.deepEqual(herdr.calls.filter((c) => c[1] === "run"), [["pane", "run", "w1:p9", "hello"]]);
	assert.equal(herdr.calls.filter((c) => c[1] === "get").length, 3);
});

test("waitAndNotify gives up without prompting when the agent never gets ready", async () => {
	const herdr = fakeHerdr({ "agent get": [{ result: { agent: { agent_status: "working" } } }] });
	await assert.rejects(waitAndNotify(herdr, { pane: "w1:p9", notice: "x", timeoutMs: 20, intervalMs: 1 }), /agent in w1:p9 was not ready after 20ms/);
	assert.equal(herdr.calls.filter((c) => c[1] === "run").length, 0);
});

test("splitNotice names the split and, with a role, ends with its instruction instead of confirm-and-wait", () => {
	const named = splitNotice({ sourcePane: "w1:p1", sourceAgent: "claude", cwd: "/repo", name: "reviewer" });
	assert.match(named, /This split is named "reviewer"\./);
	assert.match(named, /wait for the user's next instruction/);
	const role = splitNotice({ sourcePane: "w1:p1", sourceAgent: "claude", cwd: "/repo", name: "judge", role: { name: "judge", prompt: "Run the skill." } });
	assert.match(role, /Do not act on, continue, or redo any request from earlier messages/);
	assert.match(role, /never revert, reset, stash, checkout or clean/);
	assert.doesNotMatch(role, /wait for the user's next instruction|confirming you understand/);
	assert.match(role, /Your role in this split is "judge"\. Do this now: Run the skill\.$/);
});

test("openSplitPane renames the pane right after the split when given a name", async () => {
	const herdr = fakeHerdr({
		"pane layout": [{ result: { layout: { panes: [{ pane_id: "w1:p1", rect: { width: 200, height: 50 } }] } } }],
		"pane split": [{ result: { pane: { pane_id: "w1:p9" } } }],
	});
	await openSplitPane(herdr, { sourcePane: "w1:p1", cwd: "/repo", command: "claude", ratio: 0.5, focus: true, name: "reviewer" });
	assert.deepEqual(herdr.calls.slice(2), [["pane", "rename", "w1:p9", "reviewer"], ["pane", "run", "w1:p9", "claude"]]);
});

test("waitAndNotify renames the agent once it is ready; a failure is reported and the notice still goes out", async () => {
	const herdr = fakeHerdr({
		"agent get": [{ result: { agent: { agent_status: "working" } } }, { result: { agent: { agent_status: "idle" } } }],
		"agent rename": [new Error("nope")],
	});
	const warnings: string[] = [];
	await waitAndNotify(herdr, { pane: "w1:p9", notice: "hello", timeoutMs: 5000, intervalMs: 1, name: "reviewer", warn: (m) => warnings.push(m) });
	assert.deepEqual(herdr.calls.map((c) => c.slice(0, 2).join(" ")), ["agent get", "agent get", "agent rename", "pane run"]);
	assert.deepEqual(herdr.calls[2], ["agent", "rename", "w1:p9", "reviewer"]);
	assert.deepEqual(warnings, ['could not rename the agent to "reviewer": herdr agent rename failed: nope']);
});
