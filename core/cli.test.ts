import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

test("S1: a malformed roles.json or agents.json exits 2 naming the file, before any pane operation", () => {
	for (const [file, content, shown] of [["roles.json", "{ not json", /^.+/], ["agents.json", "{ not json", /^.+/], ["roles.json", "[]", /^expected a JSON object$/], ["agents.json", "3", /^expected a JSON object$/]] as const) {
		const sb = sandbox();
		mkdirSync(join(sb.dir, "cfg", "herdr-split"), { recursive: true });
		const path = join(sb.dir, "cfg", "herdr-split", file);
		writeFileSync(path, content);
		for (const args of [launchArgs(sb, "--agent", "claude"), ["help"], ["roles"], ...(file === "agents.json" ? [["agents"]] : [])]) {
			const res = spawnSync(BIN, args, { env: sb.env, encoding: "utf8" });
			assert.equal(res.status, 2, `${file} ${args[0]}`);
			assert.equal(res.stdout, "");
			assert.ok(res.stderr.startsWith(`herdr-split: Cannot read ${path}: `), res.stderr);
			assert.match(res.stderr.slice(`herdr-split: Cannot read ${path}: `.length).trimEnd(), shown);
			assert.equal(res.stderr.trimEnd().split("\n").length, 1);
			assert.deepEqual(sb.readCalls(), []);
		}
	}
});

test("S1 preserve: valid roles.json and agents.json still work together", () => {
	const sb = sandbox();
	writeConfig(sb, "agents.json", { opencode: { exec: "opencode" } });
	writeConfig(sb, "roles.json", { critic: { agent: "opencode", prompt: "Critique." } });
	const res = spawnSync(BIN, ["roles"], { env: sb.env, encoding: "utf8" });
	assert.equal(res.status, 0, res.stderr);
	assert.match(res.stdout, /^critic\topencode\tCritique\.\t\S*roles\.json\n/);
});

test("S2: repeating --name or --role exits 2 before any pane operation", () => {
	const cases: [string[], string][] = [
		[["--agent", "claude", "--name", "a", "--name", "b"], "herdr-split: --name can be given only once\n"],
		[["--agent", "claude", "--name=a", "--name", "b"], "herdr-split: --name can be given only once\n"],
		[["--agent", "claude", "--role", "judge", "--role", "judge"], "herdr-split: --role can be given only once\n"],
	];
	for (const [extra, stderr] of cases) {
		for (const command of ["launch", "split"]) {
			const sb = sandbox();
			const args = command === "launch" ? launchArgs(sb, ...extra) : ["split", "--source-kind", "claude", "--session-id", "sid", ...extra];
			const res = spawnSync(BIN, args, { env: sb.env, encoding: "utf8" });
			assert.equal(res.status, 2, `${command} ${extra.join(" ")}`);
			assert.equal(res.stdout, "");
			assert.equal(res.stderr, stderr);
			assert.deepEqual(sb.readCalls(), []);
		}
	}
});

test("S2 preserve: a single --name and --role still work", () => {
	const sb = sandbox();
	const res = spawnSync(BIN, launchArgs(sb, "--agent", "claude", "--role", "judge", "--name", "pr-judge"), { env: sb.env, encoding: "utf8" });
	assert.equal(res.status, 0, res.stderr);
	assert.deepEqual(sb.readCalls()[2], ["pane", "rename", "w1:p7", "pr-judge"]);
});

test("S3: an unknown agent still exits 2 with the same message on split", () => {
	const sb = sandbox();
	const res = spawnSync(BIN, ["split", "--agent", "vim", "--source-kind", "claude", "--session-id", "sid"], { env: sb.env, encoding: "utf8" });
	assert.equal(res.status, 2);
	assert.equal(res.stderr, 'herdr-split: Unknown agent "vim". Known agents: claude, codex, gentle, pi. Known roles: judge\n');
	assert.deepEqual(sb.readCalls(), []);
});

test("S4: a multi-line role prompt reaches herdr pane run as one line", async () => {
	const sb = sandbox();
	writeConfig(sb, "roles.json", { critic: { prompt: "Critique the plan.\n\n  Be brief." } });
	const res = spawnSync(BIN, launchArgs(sb, "--agent", "claude", "--role", "critic"), { env: sb.env, encoding: "utf8" });
	assert.equal(res.status, 0, res.stderr);
	await until(() => (runs(sb).length === 2 ? true : undefined));
	const notice = runs(sb)[1]![3]!;
	assert.doesNotMatch(notice, /\n/);
	assert.match(notice, /Do this now: Critique the plan\. Be brief\.$/);
});

// ---- prompt after the agent (issue #4) ----

const NASTY = "x; touch CANARY $(touch CANARY) `touch CANARY` ' \" \\ | & > CANARY\nline two\n\ttouch CANARY";
const NASTY_ONE_LINE = NASTY.replace(/\s+/g, " ").trim();

function claudeHome(sb: ReturnType<typeof sandbox>, rows: unknown[]): string {
	const home = join(sb.dir, "claude");
	mkdirSync(join(home, "projects", "-repo"), { recursive: true });
	writeFileSync(join(home, "projects", "-repo", "sid.jsonl"), jsonl(rows));
	return home;
}

const slashEntry = (uuid: string, parentUuid: string | null, args: string, form: "string" | "array" = "string") => {
	const text = `<command-message>split</command-message>\n<command-name>/split</command-name>\n<command-args>${args}</command-args>`;
	return { type: "user", uuid, parentUuid, sessionId: "sid", cwd: "/repo", message: { role: "user", content: form === "string" ? text : [{ type: "text", text }] } };
};
const hi = { type: "user", uuid: "u", parentUuid: null, sessionId: "sid", cwd: "/repo", message: { role: "user", content: "hi" } };

const fromTranscript = (sb: ReturnType<typeof sandbox>, rows: unknown[], ...extra: string[]) =>
	spawnSync(BIN, ["split", "--source-kind", "claude", "--session-id", "sid", "--source-agent", "claude", "--args-from-transcript", ...extra], { env: { ...sb.env, CLAUDE_CONFIG_DIR: claudeHome(sb, rows) }, encoding: "utf8" });

const SLASH = "/split <claude|codex|gentle|pi|judge> [<role>] [--name <name>] [<prompt>] (agents: claude|codex|gentle|pi; roles: judge)";

const NOT_SPLIT = "The last user message in the Claude Code transcript is not a /split invocation";

test("S2: launch --prompt ends the notice with the user's instruction, collapsed to one line", async () => {
	const sb = sandbox();
	const res = spawnSync(BIN, launchArgs(sb, "--agent", "claude", "--prompt", "run a judge\n  on PR X"), { env: sb.env, encoding: "utf8" });
	assert.equal(res.status, 0, res.stderr);
	assert.equal(res.stderr, "");
	await until(() => (runs(sb).length === 2 ? true : undefined));
	const notice = runs(sb)[1]![3]!;
	assert.doesNotMatch(notice, /\n/);
	assert.match(notice, /Do not act on, continue, or redo any request from earlier messages/);
	assert.match(notice, /probably still changing files in \/repo/);
	assert.doesNotMatch(notice, /wait for the user's next instruction/);
	assert.match(notice, /The user's instruction for you in this split, to act on now: run a judge on PR X$/);
});

test("S2: launch --role judge --prompt puts the role's instruction first and the prompt after it", async () => {
	const sb = sandbox();
	const res = spawnSync(BIN, launchArgs(sb, "--agent", "claude", "--role", "judge", "--prompt", "focus on PR 4"), { env: sb.env, encoding: "utf8" });
	assert.equal(res.status, 0, res.stderr);
	await until(() => (runs(sb).length === 2 ? true : undefined));
	const notice = runs(sb)[1]![3]!;
	assert.match(notice, /Your role in this split is "judge"\. Do this now: Run the judgment-day skill .* report its verdict\. Additional instruction from the user, to act on now: focus on PR 4$/);
	assert.match(notice, /Do not act on, continue, or redo any request from earlier messages/);
});

test("S2: an empty or blank --prompt is no prompt at all", async () => {
	const sb = sandbox();
	const res = spawnSync(BIN, launchArgs(sb, "--agent", "claude", "--prompt", " \n "), { env: sb.env, encoding: "utf8" });
	assert.equal(res.status, 0, res.stderr);
	await until(() => (runs(sb).length === 2 ? true : undefined));
	assert.match(runs(sb)[1]![3]!, /Reply with one short line confirming you understand, then wait for the user's next instruction\.$/);
});

test("S2: a prompt over 4000 characters exits 2 before any pane operation (launch, split, pick)", () => {
	const long = "a".repeat(4001);
	const message = "herdr-split: The prompt is 4001 characters long; the limit is 4000\n";
	const sb = sandbox();
	const cases = [
		launchArgs(sb, "--agent", "claude", "--prompt", long),
		["split", "--agent", "claude", "--source-kind", "claude", "--session-id", "sid", "--prompt", long],
		["pick", "--agent", "claude", "--source-kind", "pi", "--session", piSession(sb.dir), "--source-pane", "w1:p1", "--prompt", long],
	];
	for (const args of cases) {
		const res = spawnSync(BIN, args, { env: sb.env, encoding: "utf8" });
		assert.equal(res.status, 2, args[0]);
		assert.equal(res.stdout, "");
		assert.equal(res.stderr, message);
		assert.deepEqual(sb.readCalls(), []);
	}
});

test("S2 preserve: without a prompt a named role split keeps its exact notice ending", async () => {
	const sb = sandbox();
	const res = spawnSync(BIN, launchArgs(sb, "--agent", "claude", "--role", "judge"), { env: sb.env, encoding: "utf8" });
	assert.equal(res.status, 0, res.stderr);
	await until(() => (runs(sb).length === 2 ? true : undefined));
	assert.match(runs(sb)[1]![3]!, /report its verdict\.$/);
});

test("S4: split --prompt hands the prompt to the picker command, single-quoted", () => {
	const sb = sandbox();
	const res = spawnSync(BIN, ["split", "--agent", "gentle", "--source-kind", "claude", "--session-id", "sid", "--source-agent", "claude", "--prompt", "it's a \"test\""], { env: { ...sb.env, CLAUDE_CONFIG_DIR: claudeHome(sb, [hi]) }, encoding: "utf8" });
	assert.equal(res.status, 0, res.stderr);
	const run = sb.readCalls().find((c) => c[1] === "run")!;
	assert.match(run[3]!, / '--source-agent' 'claude' '--prompt-file' '[^']+'$/);
	assert.doesNotMatch(run[3]!, /'--prompt' |test/);
});

test("S4 preserve: split without a prompt passes no --prompt to the picker", () => {
	const sb = sandbox();
	const res = spawnSync(BIN, ["split", "--agent", "gentle", "--source-kind", "claude", "--session-id", "sid", "--source-agent", "claude"], { env: { ...sb.env, CLAUDE_CONFIG_DIR: claudeHome(sb, [hi]) }, encoding: "utf8" });
	assert.equal(res.status, 0, res.stderr);
	assert.doesNotMatch(sb.readCalls().find((c) => c[1] === "run")![3]!, /--prompt/);
});

test("S4: pick --prompt submits the prompt in the notice", async () => {
	const sb = sandbox();
	const bindir = join(sb.dir, "bin");
	mkdirSync(bindir);
	writeFileSync(join(bindir, "fzf"), "#!/bin/sh\ncat >/dev/null\nprintf '1\\t1. build it\\n'\n", { mode: 0o755 });
	writeFileSync(join(bindir, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	const session = piSession(sb.dir);
	writeFileSync(session, readFileSync(session, "utf8").replace('"cwd":"/repo"', `"cwd":${JSON.stringify(sb.dir)}`));
	const res = spawnSync(BIN, ["pick", "--agent", "codex", "--source-kind", "pi", "--session", session, "--source-pane", "w1:p1", "--source-agent", "gentle-shell", "--prompt", "do something"], { env: { ...sb.env, PATH: `${bindir}:${process.env.PATH}` }, encoding: "utf8" });
	assert.equal(res.status, 0, res.stderr);
	const run = await until(() => runs(sb)[0]);
	assert.match(run[3]!, /to act on now: do something$/);
});

test("S3: --args-from-transcript reads the last /split of the Claude transcript (string content)", () => {
	const sb = sandbox();
	const rows = [hi, slashEntry("s1", "u", "pi old prompt"), slashEntry("s2", "s1", "gentle judge --name rev only review PR 4")];
	const res = fromTranscript(sb, rows);
	assert.equal(res.status, 0, res.stderr);
	assert.equal(res.stderr, "");
	assert.equal(res.stdout, "herdr-split: pick the branch point in pane w1:p7; gentle starts there after you choose.\n");
	const calls = sb.readCalls();
	assert.deepEqual(calls[2], ["pane", "rename", "w1:p7", "rev"]);
	assert.match(calls[3]![3]!, /'pick' '--agent' 'gentle' '--role' 'judge' '--name' 'rev' '--source-kind' 'claude' .* '--source-agent' 'claude' '--prompt-file' '[^']+'$/);
});

test("S3: --args-from-transcript reads content-array transcripts too", () => {
	const sb = sandbox();
	const res = fromTranscript(sb, [hi, slashEntry("s1", "u", "claude do something", "array")]);
	assert.equal(res.status, 0, res.stderr);
	assert.match(sb.readCalls()[2]![3]!, /'--agent' 'claude' .* '--prompt-file' '[^']+'$/);
});

test("S3: --args-from-transcript with a plain /split gentle behaves as before (no prompt, no name)", () => {
	const sb = sandbox();
	const res = fromTranscript(sb, [hi, slashEntry("s1", "u", "gentle")]);
	assert.equal(res.status, 0, res.stderr);
	assert.equal(res.stdout, "herdr-split: pick the branch point in pane w1:p7; gentle starts there after you choose.\n");
	assert.deepEqual(sb.readCalls().map((c) => c.slice(0, 2).join(" ")), ["pane layout", "pane split", "pane run"]);
	assert.doesNotMatch(sb.readCalls()[2]![3]!, /--prompt|--name|--role/);
});

test("S3: empty arguments print the slash usage, exit 2, touch no pane", () => {
	for (const args of ["", "   "]) {
		const sb = sandbox();
		const res = fromTranscript(sb, [hi, slashEntry("s1", "u", args)]);
		assert.equal(res.status, 2);
		assert.equal(res.stdout, "");
		assert.equal(res.stderr, `herdr-split: usage: ${SLASH}\n`);
		assert.deepEqual(sb.readCalls(), []);
	}
});

test("S3: invalid arguments print the reason and the slash usage, exit 2, touch no pane", () => {
	const cases: [string, string][] = [
		["vim", 'Unknown agent "vim". Known agents: claude, codex, gentle, pi. Known roles: judge'],
		["gentle --name Bad", '--name must match ^[a-z][a-z0-9_-]{0,31}$, got "Bad"'],
		["gentle --name a --name b", "--name can be given only once"],
		["gentle --name", "--name needs a value"],
		[`gentle ${"a".repeat(4001)}`, "The prompt is 4001 characters long; the limit is 4000"],
	];
	for (const [args, reason] of cases) {
		const sb = sandbox();
		const res = fromTranscript(sb, [hi, slashEntry("s1", "u", args)]);
		assert.equal(res.status, 2, args);
		assert.equal(res.stdout, "");
		assert.equal(res.stderr, `herdr-split: ${reason}\nherdr-split: usage: ${SLASH}\n`);
		assert.deepEqual(sb.readCalls(), []);
	}
});

test("S3: a transcript without a /split entry, or --args-from-transcript with explicit target options, exits 2", () => {
	const sb = sandbox();
	const none = fromTranscript(sb, [hi]);
	assert.equal(none.status, 2);
	assert.equal(none.stderr, `herdr-split: ${NOT_SPLIT}\nherdr-split: usage: ${SLASH}\n`);
	const mixed = fromTranscript(sb, [hi, slashEntry("s1", "u", "gentle")], "--agent", "pi");
	assert.equal(mixed.status, 2);
	assert.equal(mixed.stderr, "herdr-split: --args-from-transcript cannot be combined with --agent, --role, --name or --prompt\n");
	const pi = spawnSync(BIN, ["split", "--source-kind", "pi", "--session", piSession(sb.dir), "--args-from-transcript"], { env: sb.env, encoding: "utf8" });
	assert.equal(pi.status, 2);
	assert.equal(pi.stderr, "herdr-split: --args-from-transcript needs --source-kind claude\n");
	assert.deepEqual(sb.readCalls(), []);
});

/** Run the command herdr was told to type into the new pane, the way the shell there would. */
function typedCommand(sb: ReturnType<typeof sandbox>): { bindir: string; run: () => ReturnType<typeof spawnSync> } {
	const bindir = join(sb.dir, "bin");
	mkdirSync(bindir, { recursive: true });
	writeFileSync(join(bindir, "fzf"), "#!/bin/sh\ncat >/dev/null\nprintf '1\\t1. hi\\n'\n", { mode: 0o755 });
	writeFileSync(join(bindir, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	const command = sb.readCalls().find((c) => c[1] === "run")![3]!;
	return { bindir, run: () => spawnSync("sh", ["-c", command], { cwd: sb.dir, env: { ...sb.env, PATH: `${bindir}:${process.env.PATH}` }, encoding: "utf8" }) };
}

async function assertPromptIsInert(sb: ReturnType<typeof sandbox>) {
	const typed = typedCommand(sb);
	const res = typed.run();
	assert.equal(res.status, 0, String(res.stderr));
	const notice = (await until(() => runs(sb).find((c) => c[2] === "w1:p1")))[3]!;
	assert.ok(notice.endsWith(`to act on now: ${NASTY_ONE_LINE}`), notice);
	assert.equal(existsSync(join(sb.dir, "CANARY")), false);
	assert.equal(existsSync(join(process.cwd(), "CANARY")), false);
}

function canarySession(sb: ReturnType<typeof sandbox>): string {
	const session = piSession(sb.dir);
	writeFileSync(session, readFileSync(session, "utf8").replace('"cwd":"/repo"', `"cwd":${JSON.stringify(sb.dir)}`));
	return session;
}

test("S5: a hostile prompt on the CLI split → pick path reaches the notice verbatim and runs nothing", async () => {
	const sb = sandbox();
	const res = spawnSync(BIN, ["split", "--agent", "codex", "--source-kind", "pi", "--session", canarySession(sb), "--source-agent", "gentle-shell", "--prompt", NASTY], { env: sb.env, encoding: "utf8" });
	assert.equal(res.status, 0, res.stderr);
	await assertPromptIsInert(sb);
});

test("S5: a hostile prompt in the Claude transcript reaches the notice verbatim and runs nothing", async () => {
	const sb = sandbox();
	const res = fromTranscript(sb, [{ ...hi, cwd: sb.dir }, { ...slashEntry("s1", "u", `codex ${NASTY}`), cwd: sb.dir }]);
	assert.equal(res.status, 0, res.stderr);
	assert.equal(res.stderr, "");
	await assertPromptIsInert(sb);
});

test("S5: a hostile prompt through Pi's runSplit args (execFile, no shell) reaches the notice verbatim and runs nothing", async () => {
	const { runSplit } = await import("../pi/split-command.ts");
	const sb = sandbox();
	const session = canarySession(sb);
	const notes: string[] = [];
	await runSplit(`claude ${NASTY}`, {
		env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" },
		sessionFile: session,
		leafId: "a1",
		configFile: undefined,
		select: async (_t, options) => options[0],
		notify: (msg) => notes.push(msg),
		branch: () => session,
		launch: async (args) => {
			assert.equal(args.at(-2), "--prompt");
			assert.equal(args.at(-1), NASTY_ONE_LINE);
			const r = spawnSync(BIN, args, { cwd: sb.dir, env: sb.env, encoding: "utf8" });
			if (r.status !== 0) throw new Error(r.stderr);
			return JSON.parse(r.stdout);
		},
	});
	assert.deepEqual(notes, ["Split opened in pane w1:p7 with claude."]);
	await until(() => (runs(sb).length === 2 ? true : undefined));
	assert.ok(runs(sb)[1]![3]!.endsWith(`to act on now: ${NASTY_ONE_LINE}`));
	assert.equal(existsSync(join(sb.dir, "CANARY")), false);
});

test("S4: a prompt starting with a single dash is accepted as --prompt <text>", async () => {
	const sb = sandbox();
	const res = spawnSync(BIN, launchArgs(sb, "--agent", "claude", "--prompt", "- fix the bug"), { env: sb.env, encoding: "utf8" });
	assert.equal(res.status, 0, res.stderr);
	await until(() => (runs(sb).length === 2 ? true : undefined));
	assert.match(runs(sb)[1]![3]!, /to act on now: - fix the bug$/);
});

const HOSTILE = ["\\' ; touch CANARY #", "a\\\\b", "ends with a backslash \\"];

test("R1: the typed pick command carries no prompt text; the prompt file is owner-only and removed by pick", async () => {
	for (const prompt of HOSTILE) {
		const sb = sandbox();
		const res = spawnSync(BIN, ["split", "--agent", "codex", "--source-kind", "pi", "--session", canarySession(sb), "--source-agent", "gentle-shell", "--prompt", prompt], { env: sb.env, encoding: "utf8" });
		assert.equal(res.status, 0, res.stderr);
		const command = sb.readCalls().find((c) => c[1] === "run")![3]!;
		assert.doesNotMatch(command, /'--prompt' |CANARY|ends with/);
		const file = /'--prompt-file' '([^']+)'$/.exec(command)![1]!;
		assert.equal(statSync(file).mode & 0o777, 0o600);
		assert.equal(readFileSync(file, "utf8"), prompt);
		const typed = typedCommand(sb);
		assert.equal(typed.run().status, 0);
		const notice = (await until(() => runs(sb).find((c) => c[2] === "w1:p1")))[3]!;
		assert.ok(notice.endsWith(`to act on now: ${prompt}`), notice);
		assert.equal(existsSync(file), false);
		assert.equal(existsSync(join(sb.dir, "CANARY")), false);
	}
});

test("R1: fish runs the typed pick command without breaking out of the quoting", { skip: spawnSync("fish", ["--version"]).error !== undefined }, async () => {
	const sb = sandbox();
	const res = spawnSync(BIN, ["split", "--agent", "codex", "--source-kind", "pi", "--session", canarySession(sb), "--source-agent", "gentle-shell", "--prompt", HOSTILE[0]!], { env: sb.env, encoding: "utf8" });
	assert.equal(res.status, 0, res.stderr);
	const typed = typedCommand(sb);
	const command = sb.readCalls().find((c) => c[1] === "run")![3]!;
	const r = spawnSync("fish", ["--no-config", "-c", command], { cwd: sb.dir, env: { ...sb.env, PATH: `${typed.bindir}:${process.env.PATH}` }, encoding: "utf8" });
	assert.equal(r.status, 0, r.stderr);
	const notice = (await until(() => runs(sb).find((c) => c[2] === "w1:p1")))[3]!;
	assert.ok(notice.endsWith(`to act on now: ${HOSTILE[0]}`), notice);
	assert.equal(existsSync(join(sb.dir, "CANARY")), false);
});

test("S3: only the last user entry counts: an older /split followed by an ordinary message exits 2 with no calls", () => {
	const sb = sandbox();
	const older = { ...hi, uuid: "o", parentUuid: "s1", message: { role: "user", content: "and now something else" } };
	const res = fromTranscript(sb, [hi, slashEntry("s1", "u", "gentle go"), older]);
	assert.equal(res.status, 2);
	assert.equal(res.stdout, "");
	assert.equal(res.stderr, `herdr-split: ${NOT_SPLIT}\nherdr-split: usage: ${SLASH}\n`);
	assert.deepEqual(sb.readCalls(), []);
});

test("S3: pasted /split markup with trailing prose exits 2 with no calls", () => {
	const sb = sandbox();
	const text = "<command-name>/split</command-name>\n<command-args>gentle go</command-args>\nplease also rm -rf things";
	const pasted = { ...hi, uuid: "p", message: { role: "user", content: text } };
	const res = fromTranscript(sb, [pasted]);
	assert.equal(res.status, 2);
	assert.equal(res.stderr, `herdr-split: ${NOT_SPLIT}\nherdr-split: usage: ${SLASH}\n`);
	assert.deepEqual(sb.readCalls(), []);
});

test("S3: trailing whitespace after the markup, tool results and meta entries after the /split are fine", () => {
	const sb = sandbox();
	const s1 = slashEntry("s1", "u", "gentle");
	s1.message.content = `${s1.message.content}\n  \n`;
	const meta = { type: "user", uuid: "m", parentUuid: "s1", isMeta: true, message: { role: "user", content: "expanded command body" } };
	const tool = { type: "user", uuid: "t", parentUuid: "m", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] } };
	const res = fromTranscript(sb, [hi, s1, meta, tool]);
	assert.equal(res.status, 0, res.stderr);
});

test("S3: --args-from-transcript outside split and --prompt-file outside pick exit 2 with no calls", () => {
	for (const [argv, message] of [
		[["launch", "--args-from-transcript"], "--args-from-transcript only works with split"],
		[["pick", "--args-from-transcript"], "--args-from-transcript only works with split"],
		[["agents", "--args-from-transcript"], "--args-from-transcript only works with split"],
		[["split", "--prompt-file", "/tmp/x"], "--prompt-file only works with pick"],
		[["launch", "--prompt-file", "/tmp/x"], "--prompt-file only works with pick"],
	] as [string[], string][]) {
		const sb = sandbox();
		const res = spawnSync(BIN, argv, { env: sb.env, encoding: "utf8" });
		assert.equal(res.status, 2, argv.join(" "));
		assert.equal(res.stdout, "");
		assert.equal(res.stderr, `herdr-split: ${message}\n`);
		assert.deepEqual(sb.readCalls(), []);
	}
});

test("S1: /split gentle --security from the transcript is a prompt, not an error", () => {
	const sb = sandbox();
	const res = fromTranscript(sb, [hi, slashEntry("s1", "u", "gentle --security")]);
	assert.equal(res.status, 0, res.stderr);
	assert.match(sb.readCalls()[2]![3]!, /'--agent' 'gentle' .* '--prompt-file' '[^']+'$/);
});

/** A git project with `.herdr-split/roles/<file>`; the CLI runs inside it. */
function projectWith(sb: ReturnType<typeof sandbox>, files: Record<string, string>): string {
	const root = join(sb.dir, "proj");
	mkdirSync(join(root, ".git"), { recursive: true });
	mkdirSync(join(root, ".herdr-split", "roles"), { recursive: true });
	for (const [file, text] of Object.entries(files)) writeFileSync(join(root, ".herdr-split", "roles", file), text);
	return root;
}

test("S2/S5: a project role file runs with its agent and body; the notice names the file", async () => {
	const sb = sandbox();
	const root = projectWith(sb, { "critic.md": "---\nagent: claude\n---\nReview the plan.\n\nEach finding stands alone.\n" });
	const file = join(root, ".herdr-split", "roles", "critic.md");
	const res = spawnSync(BIN, launchArgs(sb, "--agent", "critic"), { env: sb.env, encoding: "utf8", cwd: root });
	assert.equal(res.status, 0, res.stderr);
	assert.equal(res.stderr, "");
	assert.equal(JSON.parse(res.stdout).agent, "claude");
	const notice = (await until(() => runs(sb)[1]))[3]!;
	assert.ok(notice.includes(`Your role in this split is "critic", defined in ${file}. Do this now: Review the plan. Each finding stands alone.`), notice);
});

test("S5: a built-in role's notice names no file", async () => {
	const sb = sandbox();
	const res = spawnSync(BIN, launchArgs(sb, "--agent", "judge", "--branched", piSession(sb.dir)), { env: sb.env, encoding: "utf8" });
	assert.equal(res.status, 0, res.stderr);
	const notice = (await until(() => runs(sb)[1]))[3]!;
	assert.match(notice, /Your role in this split is "judge"\. Do this now: /);
});

test("S3/S4: skipped role files warn on stderr once and the split still runs", () => {
	const sb = sandbox();
	const root = projectWith(sb, { "judge.md": "Hostile.", "ghost.md": "---\nagent: vim\n---\nx" });
	const dir = join(root, ".herdr-split", "roles");
	const res = spawnSync(BIN, launchArgs(sb, "--agent", "claude"), { env: sb.env, encoding: "utf8", cwd: root });
	assert.equal(res.status, 0, res.stderr);
	assert.equal(
		res.stderr,
		`herdr-split: ignoring ${join(dir, "ghost.md")}: it uses unknown agent "vim"\nherdr-split: ignoring ${join(dir, "judge.md")}: a project role cannot replace the "judge" role from built-in\n`,
	);
});

test("S4: asking for an invalid role file exits 2 naming it, before any pane operation", () => {
	const sb = sandbox();
	const root = projectWith(sb, { "ghost.md": "---\nagent: vim\n---\nx" });
	const file = join(root, ".herdr-split", "roles", "ghost.md");
	const res = spawnSync(BIN, launchArgs(sb, "--agent", "ghost"), { env: sb.env, encoding: "utf8", cwd: root });
	assert.equal(res.status, 2);
	assert.equal(res.stdout, "");
	assert.equal(res.stderr, `herdr-split: ignoring ${file}: it uses unknown agent "vim"\nherdr-split: Role "ghost" cannot be used: ${file}: it uses unknown agent "vim"\n`);
	assert.deepEqual(sb.readCalls(), []);
});

test("S6: roles lists each role's source and the skipped role files", () => {
	const sb = sandbox();
	writeConfig(sb, "roles.json", { critic: { prompt: "Critique the plan." } });
	const personal = join(sb.env.XDG_CONFIG_HOME, "herdr-split", "roles");
	mkdirSync(personal, { recursive: true });
	writeFileSync(join(personal, "notes.md"), "Take notes.\n\n- short\n");
	const root = projectWith(sb, { "fresh.md": "---\nagent: pi\n---\nNew.", "ghost.md": "---\nagent: vim\n---\nx" });
	const dir = join(root, ".herdr-split", "roles");
	const res = spawnSync(BIN, ["roles"], { env: sb.env, encoding: "utf8", cwd: root });
	assert.equal(res.status, 0, res.stderr);
	assert.equal(res.stderr, `herdr-split: ignoring ${join(dir, "ghost.md")}: it uses unknown agent "vim"\n`);
	assert.equal(
		res.stdout,
		[
			`critic\t-\tCritique the plan.\t${join(sb.env.XDG_CONFIG_HOME, "herdr-split", "roles.json")}`,
			`fresh\tpi\tNew.\t${join(dir, "fresh.md")}`,
			"judge\tgentle\tRun the judgment-day skill for an adversarial review of the pull request discussed in this conversation, and report its verdict.\tbuilt-in",
			`notes\t-\tTake notes. - short\t${join(personal, "notes.md")}`,
			`ghost\t-\tignored: it uses unknown agent "vim"\t${join(dir, "ghost.md")}`,
			"",
		].join("\n"),
	);
});

test("S6: help --json gives each role's source", () => {
	const sb = sandbox();
	const root = projectWith(sb, { "fresh.md": "New." });
	const res = spawnSync(BIN, ["help", "--json"], { env: sb.env, encoding: "utf8", cwd: root });
	assert.equal(res.status, 0, res.stderr);
	assert.deepEqual(JSON.parse(res.stdout).roles.map((r: { name: string; source: string }) => [r.name, r.source]), [
		["fresh", join(root, ".herdr-split", "roles", "fresh.md")],
		["judge", "built-in"],
	]);
});

test("roles keeps a roles.json prompt byte for byte; only role-file prompts are collapsed", () => {
	const sb = sandbox();
	writeConfig(sb, "roles.json", { json: { prompt: "first\nsecond\tthird" } });
	const res = spawnSync(BIN, ["roles"], { env: sb.env, encoding: "utf8" });
	assert.equal(res.status, 0, res.stderr);
	assert.equal(res.stderr, "");
	assert.ok(res.stdout.startsWith(`json\t-\tfirst\nsecond\tthird\t${join(sb.env.XDG_CONFIG_HOME, "herdr-split", "roles.json")}\n`), res.stdout);
});
