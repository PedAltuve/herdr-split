import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { slashUsage } from "../core/help.ts";
import { listRoles } from "../core/roles.ts";
import { listAgents } from "../core/split.ts";
import { agentCompletions, parseSplitArgs, runSplit, splitCommandInfo, type SplitDeps } from "./split-command.ts";

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

test("completions list the known agents and roles by prefix", () => {
	assert.deepEqual(agentCompletions("g").map((i) => i.value), ["gentle"]);
	assert.deepEqual(agentCompletions("j").map((i) => i.value), ["judge"]);
	assert.deepEqual(agentCompletions("").map((i) => i.value), ["claude", "codex", "gentle", "pi", "judge"]);
	assert.equal(agentCompletions("zz"), null);
});

test("after an agent, completions offer the roles for the second word", () => {
	assert.deepEqual(agentCompletions("gentle ").map((i) => i.value), ["gentle judge"]);
	assert.deepEqual(agentCompletions("gentle j").map((i) => i.value), ["gentle judge"]);
	assert.equal(agentCompletions("judge "), null);
	assert.equal(agentCompletions("gentle judge "), null);
});

test("parseSplitArgs reads up to two words and --name", () => {
	assert.deepEqual(parseSplitArgs("gentle"), { words: ["gentle"] });
	assert.deepEqual(parseSplitArgs("  gentle   judge --name rev "), { words: ["gentle", "judge"], name: "rev" });
	assert.deepEqual(parseSplitArgs("--name=rev judge"), { words: ["judge"], name: "rev" });
	assert.deepEqual(parseSplitArgs(""), { words: [] });
	assert.deepEqual(parseSplitArgs("a b c"), { words: ["a", "b", "c"], error: "Usage: /split <agent> [<role>] [--name <name>] (at most two words)" });
	assert.equal(parseSplitArgs("gentle --name").error, "--name needs a value");
	assert.equal(parseSplitArgs("gentle --bogus").error, 'Unknown option "--bogus"');
});

function config(): string {
	const f = join(mkdtempSync(join(tmpdir(), "herdr-split-cfg-")), "agents.json");
	writeFileSync(f, JSON.stringify({ aider: { exec: "aider", format: null } }));
	return f;
}

test("the registered /split completions and description include agents from agents.json", () => {
	const info = splitCommandInfo(config());
	assert.deepEqual(info.getArgumentCompletions("a")?.map((i) => i.value), ["aider"]);
	assert.equal(info.description, `Branch this conversation into another agent in a new Herdr pane: ${slashUsage(listAgents(config()), listRoles(undefined, listAgents(config())))}`);
	assert.match(info.description, /\/split <aider\|claude\|codex\|gentle\|pi\|judge> \[<role>\] \[--name <name>\]/);
	assert.match(splitCommandInfo(undefined).description, /: \/split <claude\|codex\|gentle\|pi\|judge> .*roles: judge\)$/);
});

test("a malformed agents.json does not break registering /split", () => {
	const f = join(mkdtempSync(join(tmpdir(), "herdr-split-cfg-")), "agents.json");
	writeFileSync(f, "{ not json");
	const info = splitCommandInfo(f);
	assert.match(info.description, new RegExp(`^Branch this conversation into another agent in a new Herdr pane: /split <claude\\|codex\\|gentle\\|pi\\|judge> .*\\(ignoring ${f.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}: .+\\)$`));
	assert.deepEqual(info.getArgumentCompletions("g")?.map((i) => i.value), ["gentle"]);
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
	assert.deepEqual(log.notify, [['Unknown agent "vim". Known agents: claude, codex, gentle, pi. Known roles: judge', "error"]]);
	assert.deepEqual(log.launched, []);
	assert.equal(log.selectOptions, undefined);
});

test("/split without an agent asks for one", async () => {
	const { d, log } = deps({ pick: undefined });
	await runSplit("", d);
	assert.equal(log.selectTitle, "Split into which agent or role?");
	assert.deepEqual(log.selectOptions, ["claude", "codex", "gentle", "pi", "judge"]);
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

test("/split gentle --name reviewer passes the name to the core", async () => {
	const { d, log, file } = deps();
	await runSplit("gentle --name reviewer", d);
	assert.deepEqual(log.launched, [["launch", "--agent", "gentle", "--source-kind", "pi", "--session", file, "--cut", "a2", "--branched", "/sessions/branched.jsonl", "--name", "reviewer"]]);
});

test("/split judge: a role alone launches with --agent <role>, branching natively as the role's agent is gentle", async () => {
	const { d, log, file } = deps();
	await runSplit("judge", d);
	assert.deepEqual(log.launched, [["launch", "--agent", "judge", "--source-kind", "pi", "--session", file, "--cut", "a2", "--branched", "/sessions/branched.jsonl"]]);
	assert.deepEqual(log.notify, [["Split opened in pane w1:p5 with gentle.", "info"]]);
});

test("/split claude judge: agent plus role, no native branch for a non-pi agent", async () => {
	const { d, log, file } = deps();
	await runSplit("claude judge", d);
	assert.deepEqual(log.branched, []);
	assert.deepEqual(log.launched, [["launch", "--agent", "claude", "--role", "judge", "--source-kind", "pi", "--session", file, "--cut", "a2"]]);
});

test("/split with an invalid name, a bad role or too many words reports it and launches nothing", async () => {
	for (const [args, message] of [
		["gentle --name Bad", '--name must match ^[a-z][a-z0-9_-]{0,31}$, got "Bad"'],
		["gentle nope", 'Unknown role "nope". Known roles: judge'],
		["a b c", "Usage: /split <agent> [<role>] [--name <name>] (at most two words)"],
		["gentle --name", "--name needs a value"],
	] as const) {
		const { d, log } = deps();
		await runSplit(args, d);
		assert.deepEqual(log.notify, [[message, "error"]], args);
		assert.deepEqual(log.launched, []);
		assert.equal(log.selectOptions, undefined);
	}
});

test("an agents.json agent named judge still registers /split, without the built-in judge role", () => {
	const f = join(mkdtempSync(join(tmpdir(), "herdr-split-cfg-")), "agents.json");
	writeFileSync(f, JSON.stringify({ judge: { exec: "judge-cli", format: null } }));
	const info = splitCommandInfo(f);
	assert.doesNotMatch(info.description, /ignoring/);
	assert.match(info.description, /judge/);
	assert.deepEqual(info.getArgumentCompletions("ju")?.map((i) => i.value), ["judge"]);
});

test("transcript-only agents never create a native Pi branch", async () => {
	const { d, log } = deps();
	await runSplit("codex", d);
	assert.deepEqual(log.branched, []);
	assert.equal(log.launched.length, 1);
	assert.equal(log.launched[0]!.includes("--branched"), false);
});

test("a repeated --name is rejected before anything is picked or launched", async () => {
	for (const args of ["gentle --name first --name second", "gentle --name a' --name second"]) {
		const { d, log } = deps();
		await runSplit(args, d);
		assert.deepEqual(log.launched, [], args);
		assert.deepEqual(log.branched, [], args);
		assert.equal(log.selectOptions, undefined, args);
		assert.deepEqual(log.notify, [["--name can be given only once", "error"]], args);
	}
});

test("a malformed roles.json does not break registering /split and is reported once, naming the file", () => {
	const f = join(mkdtempSync(join(tmpdir(), "herdr-split-cfg-")), "roles.json");
	writeFileSync(f, "{ not json");
	const info = splitCommandInfo(undefined, f);
	assert.match(info.description, /: \/split <claude\|codex\|gentle\|pi\|judge> .*roles: judge\)/);
	assert.equal(info.description.split(f).length, 2, info.description);
	assert.deepEqual(info.getArgumentCompletions("g")?.map((i) => i.value), ["gentle"]);
});

test("a malformed agents.json names the file once in the /split description", () => {
	const f = join(mkdtempSync(join(tmpdir(), "herdr-split-cfg-")), "agents.json");
	writeFileSync(f, "{ not json");
	assert.equal(splitCommandInfo(f).description.split(f).length, 2);
});
