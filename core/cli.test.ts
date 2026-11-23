import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/herdr-split", import.meta.url));
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

/** A fake herdr that logs each call as one JSON line and answers like the real CLI. */
function sandbox() {
	const dir = mkdtempSync(join(tmpdir(), "herdr-split-cli-"));
	const calls = join(dir, "calls.jsonl");
	const fake = join(dir, "herdr");
	writeFileSync(
		fake,
		`#!/usr/bin/env node
const fs = require("fs");
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(a) + "\\n");
const k = a.slice(0, 2).join(" ");
const out = {
  "pane layout": { result: { layout: { panes: [{ pane_id: "w1:p1", rect: { width: 200, height: 50 } }] } } },
  "pane split": { result: { pane: { pane_id: "w1:p7" } } },
  "agent get": { result: { agent: { agent_status: "idle" } } },
}[k] || {};
process.stdout.write(JSON.stringify(out));
`,
	);
	chmodSync(fake, 0o755);
	const env = { ...process.env, HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_SPLIT_HERDR: fake, TMPDIR: dir, XDG_CONFIG_HOME: join(dir, "cfg") };
	const readCalls = (): string[][] => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
	return { dir, env, readCalls };
}

function piSession(dir: string): string {
	const f = join(dir, "pi.jsonl");
	writeFileSync(
		f,
		jsonl([
			{ type: "session", id: "s", cwd: "/repo" },
			{ type: "message", id: "u1", parentId: null, message: { role: "user", content: "build it" } },
			{ type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: "built" } },
		]),
	);
	return f;
}

async function until<T>(fn: () => T | undefined, ms = 5000): Promise<T> {
	const end = Date.now() + ms;
	for (;;) {
		const v = fn();
		if (v !== undefined) return v;
		if (Date.now() > end) throw new Error("timed out");
		await new Promise((r) => setTimeout(r, 50));
	}
}

test("launch: pi → claude opens a right split, starts claude, then submits the notice", async () => {
	const sb = sandbox();
	const res = spawnSync(BIN, ["launch", "--agent", "claude", "--source-kind", "pi", "--session", piSession(sb.dir), "--cut", "a1", "--source-agent", "gentle-shell"], { env: sb.env, encoding: "utf8" });
	assert.equal(res.status, 0, res.stderr);
	assert.equal(res.stderr, "");
	const out = JSON.parse(res.stdout);
	assert.equal(out.pane, "w1:p7");
	assert.equal(out.command, "claude");
	assert.match(readFileSync(out.transcript, "utf8"), /build it/);
	const prompt = await until(() => sb.readCalls().filter((c) => c[0] === "pane" && c[1] === "run")[1]);
	assert.equal(prompt[2], "w1:p7");
	assert.match(prompt[3]!, /split of another conversation that is still in progress in Herdr pane w1:p1 \(gentle-shell\)/);
	assert.match(prompt[3]!, new RegExp(`Read the transcript at ${out.transcript.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
	assert.deepEqual(sb.readCalls().slice(0, 3), [
		["pane", "layout", "--pane", "w1:p1"],
		["pane", "split", "w1:p1", "--direction", "right", "--ratio", "0.5", "--cwd", "/repo", "--focus"],
		["pane", "run", "w1:p7", "claude"],
	]);
});

test("launch: unknown agent exits 2, names the known agents, and touches no pane", () => {
	const sb = sandbox();
	const res = spawnSync(BIN, ["launch", "--agent", "vim", "--source-kind", "pi", "--session", piSession(sb.dir), "--cut", "a1"], { env: sb.env, encoding: "utf8" });
	assert.equal(res.status, 2);
	assert.equal(res.stdout, "");
	assert.equal(res.stderr, 'herdr-split: Unknown agent "vim". Known agents: claude, codex, gentle, pi\n');
	assert.deepEqual(sb.readCalls(), []);
});

test("launch outside Herdr exits 2 without touching a pane", () => {
	const sb = sandbox();
	const res = spawnSync(BIN, ["launch", "--agent", "pi", "--source-kind", "pi", "--session", piSession(sb.dir), "--cut", "a1"], { env: { ...sb.env, HERDR_ENV: "" }, encoding: "utf8" });
	assert.equal(res.status, 2);
	assert.equal(res.stderr, "herdr-split: herdr-split must run inside a Herdr pane (HERDR_ENV=1)\n");
	assert.deepEqual(sb.readCalls(), []);
});

test("split: claude session id is resolved and the picker runs in the new pane", () => {
	const sb = sandbox();
	const claudeHome = join(sb.dir, "claude");
	mkdirSync(join(claudeHome, "projects", "-repo"), { recursive: true });
	const file = join(claudeHome, "projects", "-repo", "sid.jsonl");
	writeFileSync(file, jsonl([{ type: "user", uuid: "u", parentUuid: null, sessionId: "sid", cwd: "/repo", message: { role: "user", content: "hi" } }]));
	const res = spawnSync(BIN, ["split", "--agent", "gentle", "--source-kind", "claude", "--session-id", "sid"], { env: { ...sb.env, CLAUDE_CONFIG_DIR: claudeHome }, encoding: "utf8" });
	assert.equal(res.status, 0, res.stderr);
	assert.equal(res.stdout, "herdr-split: pick the branch point in pane w1:p7; gentle starts there after you choose.\n");
	const run = sb.readCalls().find((c) => c[1] === "run")!;
	assert.equal(run[2], "w1:p7");
	assert.match(run[3]!, /'pick' '--agent' 'gentle' '--source-kind' 'claude' '--session' '[^']*sid\.jsonl' '--source-pane' 'w1:p1' '--source-agent' 'claude'/);
});

test("split: missing claude session exits 2", () => {
	const sb = sandbox();
	const res = spawnSync(BIN, ["split", "--agent", "claude", "--source-kind", "claude", "--session-id", "nope"], { env: { ...sb.env, CLAUDE_CONFIG_DIR: join(sb.dir, "none") }, encoding: "utf8" });
	assert.equal(res.status, 2);
	assert.match(res.stderr, /^herdr-split: No Claude Code session nope under /);
	assert.deepEqual(sb.readCalls(), []);
});

test("agents lists built-ins and config additions", () => {
	const sb = sandbox();
	mkdirSync(join(sb.dir, "cfg", "herdr-split"), { recursive: true });
	writeFileSync(join(sb.dir, "cfg", "herdr-split", "agents.json"), JSON.stringify({ opencode: { exec: "opencode" } }));
	const res = spawnSync(BIN, ["agents"], { env: sb.env, encoding: "utf8" });
	assert.equal(res.status, 0);
	assert.equal(res.stdout, "claude\tclaude\ncodex\tcodex\ngentle\tgentle-shell\nopencode\topencode\npi\tpi\n");
});
