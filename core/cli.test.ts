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
  "agent get": { result: { agent: { agent_status: "idle", ...(process.env.FAKE_AGENT ? { agent: process.env.FAKE_AGENT } : {}) } } },
}[k] || {};
if (process.env.FAKE_FAIL === k) { process.stderr.write("boom " + k); process.exit(1); }
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
	assert.equal(res.stderr, 'herdr-split: Unknown agent "vim". Known agents: claude, codex, gentle, pi. Known roles: judge\n');
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

const launchArgs = (sb: ReturnType<typeof sandbox>, ...extra: string[]) => ["launch", "--source-kind", "pi", "--session", piSession(sb.dir), "--cut", "a1", "--source-agent", "gentle-shell", ...extra];
const runs = (sb: ReturnType<typeof sandbox>) => sb.readCalls().filter((c) => c[0] === "pane" && c[1] === "run");
const writeConfig = (sb: ReturnType<typeof sandbox>, file: string, data: unknown) => {
	mkdirSync(join(sb.dir, "cfg", "herdr-split"), { recursive: true });
	writeFileSync(join(sb.dir, "cfg", "herdr-split", file), JSON.stringify(data));
};

test("launch --name: pane rename right after the split, agent rename after readiness, notice names the split", async () => {
	const sb = sandbox();
	const res = spawnSync(BIN, launchArgs(sb, "--agent", "claude", "--name", "reviewer"), { env: sb.env, encoding: "utf8" });
	assert.equal(res.status, 0, res.stderr);
	assert.equal(res.stderr, "");
	await until(() => (runs(sb).length === 2 ? true : undefined));
	const calls = sb.readCalls();
	assert.deepEqual(calls.slice(0, 4).map((c) => c.slice(0, 2).join(" ")), ["pane layout", "pane split", "pane rename", "pane run"]);
	assert.deepEqual(calls[2], ["pane", "rename", "w1:p7", "reviewer"]);
	const keys = calls.map((c) => c.slice(0, 2).join(" "));
	assert.ok(keys.indexOf("agent get") < keys.indexOf("agent rename"));
	assert.ok(keys.indexOf("agent rename") < keys.lastIndexOf("pane run"));
	assert.deepEqual(calls[keys.indexOf("agent rename")], ["agent", "rename", "w1:p7", "reviewer"]);
	assert.match(runs(sb)[1]![3]!, /This split is named "reviewer"\./);
	assert.match(runs(sb)[1]![3]!, /wait for the user's next instruction/);
});

test("launch --name: an invalid name exits 2 before any pane operation", () => {
	for (const bad of ["Bad", "1x", "a b", "", "x".repeat(33), "-a"]) {
		const sb = sandbox();
		const res = spawnSync(BIN, launchArgs(sb, "--agent", "claude", `--name=${bad}`), { env: sb.env, encoding: "utf8" });
		assert.equal(res.status, 2, bad);
		assert.equal(res.stdout, "");
		assert.equal(res.stderr, `herdr-split: --name must match ^[a-z][a-z0-9_-]{0,31}$, got "${bad}"\n`);
		assert.deepEqual(sb.readCalls(), []);
	}
});

test("launch --name: a failing agent rename is logged and the notice is still submitted", async () => {
	const sb = sandbox();
	const res = spawnSync(BIN, launchArgs(sb, "--agent", "claude", "--name", "reviewer"), { env: { ...sb.env, FAKE_FAIL: "agent rename" }, encoding: "utf8" });
	assert.equal(res.status, 0, res.stderr);
	const log = JSON.parse(res.stdout).log;
	await until(() => (runs(sb).length === 2 ? true : undefined));
	await until(() => (readFileSync(log, "utf8").includes("notice submitted") ? true : undefined));
	assert.match(readFileSync(log, "utf8"), /herdr-split: could not rename the agent to "reviewer": herdr agent rename failed: boom agent rename/);
	assert.match(runs(sb)[1]![3]!, /named "reviewer"/);
});

test("launch --name: a failing pane rename warns on stderr and the split still starts the agent", () => {
	const sb = sandbox();
	const res = spawnSync(BIN, launchArgs(sb, "--agent", "claude", "--name", "reviewer"), { env: { ...sb.env, FAKE_FAIL: "pane rename" }, encoding: "utf8" });
	assert.equal(res.status, 0);
	assert.equal(res.stderr, 'herdr-split: could not rename pane w1:p7 to "reviewer": herdr pane rename failed: boom pane rename\n');
	assert.deepEqual(runs(sb)[0], ["pane", "run", "w1:p7", "claude"]);
});

test("launch without name or role makes no rename call and keeps the plain notice", async () => {
	const sb = sandbox();
	const res = spawnSync(BIN, launchArgs(sb, "--agent", "claude"), { env: sb.env, encoding: "utf8" });
	assert.equal(res.status, 0, res.stderr);
	await until(() => (runs(sb).length === 2 ? true : undefined));
	assert.deepEqual(sb.readCalls().filter((c) => c[1] === "rename"), []);
	const notice = runs(sb)[1]![3]!;
	assert.doesNotMatch(notice, /named|role/i);
	assert.match(notice, /Reply with one short line confirming you understand, then wait for the user's next instruction\.$/);
});

test("launch --agent judge: the role picks gentle, names the split and replaces confirm-and-wait with the instruction", async () => {
	const sb = sandbox();
	const res = spawnSync(BIN, launchArgs(sb, "--agent", "judge", "--branched", piSession(sb.dir)), { env: sb.env, encoding: "utf8" });
	assert.equal(res.status, 0, res.stderr);
	const out = JSON.parse(res.stdout);
	assert.equal(out.agent, "gentle");
	assert.match(out.command, /^gentle-shell --session /);
	await until(() => (runs(sb).length === 2 ? true : undefined));
	assert.deepEqual(sb.readCalls()[2], ["pane", "rename", "w1:p7", "judge"]);
	assert.ok(sb.readCalls().some((c) => c.join(" ") === "agent rename w1:p7 judge"));
	const notice = runs(sb)[1]![3]!;
	assert.match(notice, /This split is named "judge"\./);
	assert.match(notice, /judgment-day/);
	assert.match(notice, /adversarial/);
	assert.match(notice, /pull request/);
	assert.match(notice, /Do not act on, continue, or redo any request from earlier messages/);
	assert.match(notice, /probably still changing files in \/repo/);
	assert.doesNotMatch(notice, /wait for the user's next instruction/);
});

test("launch --agent claude --role judge uses that agent with the role's prompt; --name overrides the role name", async () => {
	const sb = sandbox();
	const res = spawnSync(BIN, launchArgs(sb, "--agent", "claude", "--role", "judge", "--name", "pr-judge"), { env: sb.env, encoding: "utf8" });
	assert.equal(res.status, 0, res.stderr);
	assert.equal(JSON.parse(res.stdout).agent, "claude");
	await until(() => (runs(sb).length === 2 ? true : undefined));
	assert.deepEqual(sb.readCalls()[2], ["pane", "rename", "w1:p7", "pr-judge"]);
	assert.match(runs(sb)[1]![3]!, /named "pr-judge"[\s\S]*judgment-day/);
});

test("launch --role judge alone uses the role's agent", () => {
	const sb = sandbox();
	const res = spawnSync(BIN, launchArgs(sb, "--role", "judge", "--branched", piSession(sb.dir)), { env: sb.env, encoding: "utf8" });
	assert.equal(res.status, 0, res.stderr);
	assert.equal(JSON.parse(res.stdout).agent, "gentle");
});

test("roles.json adds roles and overrides built-ins", async () => {
	const sb = sandbox();
	writeConfig(sb, "roles.json", { judge: { agent: "claude", prompt: "Be gentle." }, critic: { prompt: "Critique the plan." } });
	const res = spawnSync(BIN, launchArgs(sb, "--agent", "judge"), { env: sb.env, encoding: "utf8" });
	assert.equal(res.status, 0, res.stderr);
	assert.equal(JSON.parse(res.stdout).agent, "claude");
	await until(() => (runs(sb).length === 2 ? true : undefined));
	assert.match(runs(sb)[1]![3]!, /Be gentle\./);
	assert.doesNotMatch(runs(sb)[1]![3]!, /judgment-day/);
});

test("a role without an agent splits into the source agent (exec match, then source kind)", () => {
	const sb = sandbox();
	writeConfig(sb, "roles.json", { critic: { prompt: "Critique the plan." } });
	const viaExec = spawnSync(BIN, launchArgs(sb, "--agent", "critic", "--branched", piSession(sb.dir)), { env: sb.env, encoding: "utf8" });
	assert.equal(viaExec.status, 0, viaExec.stderr);
	assert.equal(JSON.parse(viaExec.stdout).agent, "gentle");
	const sb2 = sandbox();
	writeConfig(sb2, "roles.json", { critic: { prompt: "Critique the plan." } });
	const args = launchArgs(sb2, "--agent", "critic", "--branched", piSession(sb2.dir));
	args.splice(args.indexOf("--source-agent"), 2);
	const viaHerdr = spawnSync(BIN, args, { env: { ...sb2.env, FAKE_AGENT: "codex" }, encoding: "utf8" });
	assert.equal(viaHerdr.status, 0, viaHerdr.stderr);
	assert.equal(JSON.parse(viaHerdr.stdout).agent, "codex");
	const sb3 = sandbox();
	writeConfig(sb3, "roles.json", { critic: { prompt: "Critique the plan." } });
	const args3 = launchArgs(sb3, "--agent", "critic", "--branched", piSession(sb3.dir));
	args3.splice(args3.indexOf("--source-agent"), 2);
	const viaKind = spawnSync(BIN, args3, { env: sb3.env, encoding: "utf8" });
	assert.equal(viaKind.status, 0, viaKind.stderr);
	assert.equal(JSON.parse(viaKind.stdout).agent, "pi");
});

test("a role named like an agent is a configuration error naming it: exit 2, no pane operation", () => {
	const sb = sandbox();
	writeConfig(sb, "roles.json", { gentle: { prompt: "x" } });
	const res = spawnSync(BIN, launchArgs(sb, "--agent", "claude"), { env: sb.env, encoding: "utf8" });
	assert.equal(res.status, 2);
	assert.equal(res.stdout, "");
	assert.equal(res.stderr, 'herdr-split: Role "gentle" has the same name as an agent; rename it in roles.json\n');
	assert.deepEqual(sb.readCalls(), []);
});

test("unknown agent or role and bad combinations exit 2 without touching a pane", () => {
	const cases: [string[], string][] = [
		[["--agent", "claude", "--role", "nope"], 'herdr-split: Unknown role "nope". Known roles: judge\n'],
		[["--agent", "judge", "--role", "judge"], 'herdr-split: --agent judge is a role; it cannot be combined with --role\n'],
		[["--role", "claude"], 'herdr-split: Unknown role "claude". Known roles: judge\n'],
		[[], "herdr-split: --agent or --role is required\n"],
	];
	for (const [extra, stderr] of cases) {
		const sb = sandbox();
		const res = spawnSync(BIN, launchArgs(sb, ...extra), { env: sb.env, encoding: "utf8" });
		assert.equal(res.status, 2, extra.join(" "));
		assert.equal(res.stdout, "");
		assert.equal(res.stderr, stderr);
		assert.deepEqual(sb.readCalls(), []);
	}
});

test("roles lists the built-in and configured roles", () => {
	const sb = sandbox();
	writeConfig(sb, "roles.json", { critic: { prompt: "Critique the plan." } });
	const res = spawnSync(BIN, ["roles"], { env: sb.env, encoding: "utf8" });
	assert.equal(res.status, 0);
	assert.equal(res.stderr, "");
	const lines = res.stdout.trimEnd().split("\n");
	assert.deepEqual(lines.map((l) => l.split("\t").slice(0, 2)), [["critic", "-"], ["judge", "gentle"]]);
	assert.equal(lines[0]!.split("\t")[2], "Critique the plan.");
	assert.match(lines[1]!.split("\t")[2]!, /judgment-day/);
});

test("split: the resolved agent, role and name go single-quoted to the picker and the pane is renamed", () => {
	const sb = sandbox();
	const claudeHome = join(sb.dir, "claude");
	mkdirSync(join(claudeHome, "projects", "-repo"), { recursive: true });
	writeFileSync(join(claudeHome, "projects", "-repo", "sid.jsonl"), jsonl([{ type: "user", uuid: "u", parentUuid: null, sessionId: "sid", cwd: "/repo", message: { role: "user", content: "hi" } }]));
	const res = spawnSync(BIN, ["split", "--agent", "judge", "--source-kind", "claude", "--session-id", "sid", "--source-agent", "claude"], { env: { ...sb.env, CLAUDE_CONFIG_DIR: claudeHome }, encoding: "utf8" });
	assert.equal(res.status, 0, res.stderr);
	assert.equal(res.stdout, "herdr-split: pick the branch point in pane w1:p7; gentle starts there after you choose.\n");
	const calls = sb.readCalls();
	assert.deepEqual(calls[2], ["pane", "rename", "w1:p7", "judge"]);
	assert.match(calls[3]![3]!, /'pick' '--agent' 'gentle' '--role' 'judge' '--name' 'judge' '--source-kind' 'claude'/);
});

test("split: an invalid name exits 2 before any pane operation", () => {
	const sb = sandbox();
	const res = spawnSync(BIN, ["split", "--agent", "claude", "--source-kind", "claude", "--session-id", "sid", "--name", "Bad"], { env: sb.env, encoding: "utf8" });
	assert.equal(res.status, 2);
	assert.equal(res.stderr, 'herdr-split: --name must match ^[a-z][a-z0-9_-]{0,31}$, got "Bad"\n');
	assert.deepEqual(sb.readCalls(), []);
});

test("pick: names the agent after readiness and submits the role notice", async () => {
	const sb = sandbox();
	const bindir = join(sb.dir, "bin");
	mkdirSync(bindir);
	writeFileSync(join(bindir, "fzf"), "#!/bin/sh\ncat >/dev/null\nprintf '1\\t1. build it\\n'\n", { mode: 0o755 });
	writeFileSync(join(bindir, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	// pick runs the agent in the session's cwd, which must exist.
	const session = piSession(sb.dir);
	writeFileSync(session, readFileSync(session, "utf8").replace('"cwd":"/repo"', `"cwd":${JSON.stringify(sb.dir)}`));
	const res = spawnSync(BIN, ["pick", "--agent", "codex", "--role", "judge", "--name", "reviewer", "--source-kind", "pi", "--session", session, "--source-pane", "w1:p1", "--source-agent", "gentle-shell"], { env: { ...sb.env, PATH: `${bindir}:${process.env.PATH}` }, encoding: "utf8" });
	assert.equal(res.status, 0, res.stderr);
	const run = await until(() => runs(sb)[0]);
	assert.equal(run[2], "w1:p1");
	assert.match(run[3]!, /named "reviewer"[\s\S]*judgment-day/);
	assert.ok(sb.readCalls().some((c) => c.join(" ") === "agent rename w1:p1 reviewer"));
});
