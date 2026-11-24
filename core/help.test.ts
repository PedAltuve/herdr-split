import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OPTIONS } from "./cli.ts";
import { COMMANDS, synopsis } from "./help.ts";

const BIN = fileURLToPath(new URL("../bin/herdr-split", import.meta.url));
const README = fileURLToPath(new URL("../README.md", import.meta.url));

/** Run the CLI with a config dir that adds one agent. */
function run(...args: string[]) {
	const dir = mkdtempSync(join(tmpdir(), "herdr-split-help-"));
	mkdirSync(join(dir, "herdr-split"));
	writeFileSync(join(dir, "herdr-split", "agents.json"), JSON.stringify({ aider: { exec: "aider", format: null } }));
	return spawnSync(BIN, args, { encoding: "utf8", env: { ...process.env, XDG_CONFIG_HOME: dir } });
}

test("help prints the usage of every public command, its options and the known agents", () => {
	const r = run("help");
	assert.equal(r.status, 0);
	assert.equal(r.stderr, "");
	for (const line of synopsis()) assert.ok(r.stdout.includes(line), `missing synopsis: ${line}`);
	for (const c of COMMANDS.filter((c) => !c.internal)) assert.match(r.stdout, new RegExp(`^  ${c.name} +${c.summary.replace(/[.()]/g, "\\$&")}$`, "m"));
	for (const flag of ["--agent <name>", "--ratio <0..1>", "--no-focus", "--json"]) assert.ok(r.stdout.includes(flag), `missing option: ${flag}`);
	assert.match(r.stdout, /^Agents: aider, claude, codex, gentle, pi$/m);
	assert.doesNotMatch(r.stdout, /^  (pick|notify) |--notice-file|--source-pane|--timeout/m);
});

test("--help and -h print the same help, even after a command", () => {
	const help = run("help").stdout;
	for (const args of [["--help"], ["-h"], ["split", "--help"]]) {
		const r = run(...args);
		assert.equal(r.status, 0, args.join(" "));
		assert.equal(r.stderr, "");
		assert.equal(r.stdout, help);
	}
});

test("help --json describes the public commands, their options and the agents", () => {
	const r = run("help", "--json");
	assert.equal(r.status, 0);
	assert.equal(r.stderr, "");
	const doc = JSON.parse(r.stdout);
	assert.equal(doc.name, "herdr-split");
	assert.equal(doc.slashCommand, "/split <aider|claude|codex|gentle|pi>");
	assert.deepEqual(doc.commands.map((c: { name: string }) => c.name), ["launch", "split", "agents", "help"]);
	const launch = doc.commands[0];
	assert.ok(launch.synopsis.startsWith("herdr-split launch --agent <name>"));
	assert.deepEqual(launch.options.find((o: { flag: string }) => o.flag === "--ratio"), { flag: "--ratio", value: "<0..1>", description: "Size of the new pane as a fraction of the calling pane.", default: "0.5", required: false });
	assert.equal(launch.options.find((o: { flag: string }) => o.flag === "--agent").required, true);
	assert.deepEqual(doc.agents.find((a: { name: string }) => a.name === "aider"), { name: "aider", exec: "aider", format: null });
	assert.deepEqual(doc.agents.find((a: { name: string }) => a.name === "gentle"), { name: "gentle", exec: "gentle-shell", format: "pi" });
});

test("help --slash prints the /split usage with the known agents", () => {
	const r = run("help", "--slash");
	assert.equal(r.status, 0);
	assert.equal(r.stderr, "");
	assert.equal(r.stdout, "herdr-split: usage: /split <aider|claude|codex|gentle|pi>\n");
});

test("an unknown or missing command prints the generated usage line and exits 2", () => {
	const unknown = run("frobnicate");
	assert.equal(unknown.status, 2);
	assert.equal(unknown.stdout, "");
	assert.equal(unknown.stderr, 'herdr-split: Usage: herdr-split <launch|split|agents|help> [options] (unknown command "frobnicate")\n');
	const none = run();
	assert.equal(none.status, 2);
	assert.equal(none.stdout, "");
	assert.equal(none.stderr, "herdr-split: Usage: herdr-split <launch|split|agents|help> [options]\n");
});

test("drift: the parser accepts exactly the options the table documents", () => {
	const documented = new Set(COMMANDS.flatMap((c) => c.options.map((o) => o.name)));
	assert.deepEqual([...documented].sort(), Object.keys(OPTIONS).sort());
});

test("drift: the README CLI reference matches the table", () => {
	const readme = readFileSync(README, "utf8");
	const section = readme.split("## CLI reference")[1]!.split("\n## ")[0]!;
	const block = section.split("```")[1]!.replace(/^\n/, "");
	assert.equal(block, synopsis().join("\n") + "\n");
	for (const c of COMMANDS.filter((c) => !c.internal)) assert.ok(section.includes(`- \`${c.name}\`: ${c.summary}`), `README misses ${c.name}`);
});
