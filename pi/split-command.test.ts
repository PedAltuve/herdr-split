import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentCompletions, runSplit, splitDescription, type SplitDeps } from "./split-command.ts";

const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

function session(): string {
	const f = join(mkdtempSync(join(tmpdir(), "herdr-split-pi-")), "s.jsonl");
	writeFileSync(
		f,
		jsonl([
			{ type: "session", id: "s", cwd: "/repo" },
			{ type: "message", id: "u1", parentId: null, message: { role: "user", content: "first" } },
			{ type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: "one" } },
			{ type: "message", id: "u2", parentId: "a1", message: { role: "user", content: "second" } },
			{ type: "message", id: "a2", parentId: "u2", message: { role: "assistant", content: "two" } },
		]),
	);
	return f;
}

function deps(over: Partial<SplitDeps> & { pick?: string | undefined } = {}) {
	const log: { notify: [string, string][]; branched: string[]; launched: string[][]; selectTitle?: string; selectOptions?: string[] } = {
		notify: [],
		branched: [],
		launched: [],
	};
	const file = session();
	const d: SplitDeps = {
		env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" },
		sessionFile: file,
		leafId: "a2",
		configFile: undefined,
		select: async (title, options) => {
			log.selectTitle = title;
			log.selectOptions = options;
			return "pick" in over ? over.pick : options[0];
		},
		notify: (msg, level) => log.notify.push([msg, level]),
		branch: (src, cutId) => {
			log.branched.push(`${src}@${cutId}`);
			return "/sessions/branched.jsonl";
		},
		launch: async (args) => {
			log.launched.push(args);
			return { pane: "w1:p5", command: "x" };
		},
		...over,
	};
	return { d, log, file };
}

test("completions list the known agents by prefix", () => {
	assert.deepEqual(agentCompletions("g").map((i) => i.value), ["gentle"]);
	assert.deepEqual(agentCompletions("").map((i) => i.value), ["claude", "codex", "gentle", "pi"]);
	assert.equal(agentCompletions("zz"), null);
});

function config(): string {
	const f = join(mkdtempSync(join(tmpdir(), "herdr-split-cfg-")), "agents.json");
	writeFileSync(f, JSON.stringify({ aider: { exec: "aider", format: null } }));
	return f;
}

test("completions and the description include agents from agents.json", () => {
	const cfg = config();
	assert.deepEqual(agentCompletions("a", cfg)?.map((i) => i.value), ["aider"]);
	assert.equal(splitDescription(cfg), "Branch this conversation into another agent in a new Herdr pane: /split <aider|claude|codex|gentle|pi>");
	assert.equal(splitDescription(undefined), "Branch this conversation into another agent in a new Herdr pane: /split <claude|codex|gentle|pi>");
});

test("/split gentle: picks a turn newest-first, branches the Pi session natively and launches", async () => {
	const { d, log, file } = deps({ pick: "1. first" });
	await runSplit("gentle", d);
	assert.equal(log.selectTitle, "Branch after which message? The branch keeps it and everything before it.");
	assert.deepEqual(log.selectOptions, ["2. second", "1. first"]);
	assert.deepEqual(log.branched, [`${file}@a1`]);
	assert.deepEqual(log.launched, [["launch", "--agent", "gentle", "--source-kind", "pi", "--session", file, "--cut", "a1", "--branched", "/sessions/branched.jsonl"]]);
	assert.deepEqual(log.notify, [["Split opened in pane w1:p5 with gentle.", "info"]]);
});

test("/split claude: no native Pi branch, the core writes a transcript", async () => {
	const { d, log, file } = deps();
	await runSplit("claude", d);
	assert.deepEqual(log.branched, []);
	assert.deepEqual(log.launched, [["launch", "--agent", "claude", "--source-kind", "pi", "--session", file, "--cut", "a2"]]);
});

test("/split with an unknown agent reports the known list and launches nothing", async () => {
	const { d, log } = deps();
	await runSplit("vim", d);
	assert.deepEqual(log.notify, [['Unknown agent "vim". Known agents: claude, codex, gentle, pi', "error"]]);
	assert.deepEqual(log.launched, []);
	assert.equal(log.selectOptions, undefined);
});

test("/split without an agent asks for one", async () => {
	const { d, log } = deps({ pick: undefined });
	await runSplit("", d);
	assert.equal(log.selectTitle, "Split into which agent?");
	assert.deepEqual(log.launched, []);
});

test("/split outside Herdr explains and launches nothing", async () => {
	const { d, log } = deps({ env: {} });
	await runSplit("claude", d);
	assert.deepEqual(log.notify, [["/split needs Herdr: run Pi inside a Herdr pane.", "error"]]);
	assert.deepEqual(log.launched, []);
});

test("cancelling the picker launches nothing", async () => {
	const { d, log } = deps({ pick: undefined });
	await runSplit("claude", d);
	assert.deepEqual(log.launched, []);
	assert.deepEqual(log.notify, [["Split cancelled.", "info"]]);
});

test("launch failures are reported", async () => {
	const { d, log } = deps({ launch: async () => { throw new Error("herdr pane split failed: no room"); } });
	await runSplit("claude", d);
	assert.deepEqual(log.notify, [["/split failed: herdr pane split failed: no room", "error"]]);
});
