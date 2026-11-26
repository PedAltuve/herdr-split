import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OPTIONS } from "./cli.ts";
import { COMMANDS, optionDoc, synopsis } from "./help.ts";
import { listRoles } from "./roles.ts";
import { listAgents } from "./split.ts";

const BIN = fileURLToPath(new URL("../bin/herdr-split", import.meta.url));
const SLASH = "/split <aider|claude|codex|gentle|pi|judge> [<role>] [--name <name>] [<prompt>] (agents: aider|claude|codex|gentle|pi; roles: judge)";
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
	for (const flag of ["--agent <name>", "--role <name>", "--name <name>", "--ratio <0..1>", "--no-focus", "--json"]) assert.ok(r.stdout.includes(flag), `missing option: ${flag}`);
	assert.match(r.stdout, /^Agents: aider, claude, codex, gentle, pi$/m);
	assert.match(r.stdout, /^Roles: judge$/m);
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
	assert.equal(doc.slashCommand, SLASH);
	assert.deepEqual(doc.commands.map((c: { name: string }) => c.name), ["launch", "split", "agents", "roles", "help"]);
	const launch = doc.commands[0];
	assert.ok(launch.synopsis.startsWith("herdr-split launch (--agent <name> | --role <name>) "));
	assert.deepEqual(launch.options.find((o: { flag: string }) => o.flag === "--ratio"), { flag: "--ratio", value: "<0..1>", description: "Size of the new pane as a fraction of the calling pane.", default: "0.5", required: false });
	const agentOption = (c: { options: { flag: string; required: boolean; description: string }[] }) => c.options.find((o) => o.flag === "--agent")!;
	for (const c of [doc.commands[0], doc.commands[1]]) {
		assert.equal(agentOption(c).required, false);
		assert.match(agentOption(c).description, /Required unless --role is given\./);
	}
	assert.equal(launch.options.find((o: { flag: string }) => o.flag === "--source-kind").required, true);
	assert.deepEqual(doc.agents.find((a: { name: string }) => a.name === "aider"), { name: "aider", exec: "aider", format: null });
	assert.deepEqual(doc.agents.find((a: { name: string }) => a.name === "gentle"), { name: "gentle", exec: "gentle-shell", format: "pi" });
	assert.equal(doc.roles.length, 1);
	assert.deepEqual([doc.roles[0].name, doc.roles[0].agent], ["judge", "gentle"]);
	assert.match(doc.roles[0].prompt, /judgment-day/);
	for (const name of ["name", "role"]) assert.ok(launch.options.some((o: { flag: string; value: string }) => o.flag === `--${name}` && o.value === "<name>"));
});

test("help --slash prints the /split usage with the known agents", () => {
	const r = run("help", "--slash");
	assert.equal(r.status, 0);
	assert.equal(r.stderr, "");
	assert.equal(r.stdout, `herdr-split: usage: ${SLASH}\n`);
});

test("an unknown or missing command prints the generated usage line and exits 2", () => {
	const unknown = run("frobnicate");
	assert.equal(unknown.status, 2);
	assert.equal(unknown.stdout, "");
	assert.equal(unknown.stderr, 'herdr-split: Usage: herdr-split <launch|split|agents|roles|help> [options] (unknown command "frobnicate")\n');
	const none = run();
	assert.equal(none.status, 2);
	assert.equal(none.stdout, "");
	assert.equal(none.stderr, "herdr-split: Usage: herdr-split <launch|split|agents|roles|help> [options]\n");
});

test("drift: the parser accepts exactly the options the table documents", () => {
	const documented = new Set(COMMANDS.flatMap((c) => c.options.map((o) => o.name)));
	assert.deepEqual([...documented].sort(), Object.keys(OPTIONS).sort());
	for (const [name, o] of Object.entries(OPTIONS) as [string, { type: string; default?: unknown; short?: string }][]) {
		const doc = optionDoc(name);
		assert.equal(doc.value !== undefined, o.type === "string", `--${name}: value placeholder vs parser type`);
		assert.equal(doc.default, o.type === "string" ? o.default : undefined, `--${name}: default`);
		assert.equal(doc.short, o.short ? `-${o.short}` : undefined, `--${name}: short flag`);
	}
});

test("help-only output flags are rejected elsewhere and cannot be combined", () => {
	const cases: [string[], string][] = [
		[["agents", "--json"], "herdr-split: --json and --slash only work with help\n"],
		[["agents", "--slash"], "herdr-split: --json and --slash only work with help\n"],
		[["split", "--json", "--agent", "pi"], "herdr-split: --json and --slash only work with help\n"],
		[["--json"], "herdr-split: --json and --slash only work with help\n"],
		[["--slash"], "herdr-split: --json and --slash only work with help\n"],
		[["help", "--json", "--slash"], "herdr-split: --json and --slash cannot be combined\n"],
		[["--help", "--json", "--slash"], "herdr-split: --json and --slash cannot be combined\n"],
	];
	for (const [args, stderr] of cases) {
		const r = run(...args);
		assert.equal(r.status, 2, args.join(" "));
		assert.equal(r.stdout, "");
		assert.equal(r.stderr, stderr);
	}
});

test("agents without help flags keeps its output", () => {
	const r = run("agents");
	assert.equal(r.status, 0);
	assert.equal(r.stdout, "aider\taider\nclaude\tclaude\ncodex\tcodex\ngentle\tgentle-shell\npi\tpi\n");
});

test("drift: the README CLI reference matches the table", () => {
	const readme = readFileSync(README, "utf8");
	const section = readme.split("## CLI reference")[1]!.split("\n## ")[0]!;
	const block = section.split("```")[1]!.replace(/^\n/, "");
	assert.equal(block, synopsis().join("\n") + "\n");
	for (const c of COMMANDS.filter((c) => !c.internal)) assert.ok(section.includes(`- \`${c.name}\`: ${c.summary}`), `README misses ${c.name}`);
});

test("drift: the README usage shows /split with exactly the built-in agents and roles, and --name", () => {
	const usage = readFileSync(README, "utf8").split("## Usage")[1]!.split("\n## ")[0]!;
	const shown = [...new Set([...usage.matchAll(/^\/split (\S+)/gm)].map((m) => m[1]))].sort();
	assert.deepEqual(shown, [...listAgents().map((a) => a.name), ...listRoles(undefined, listAgents()).map((r) => r.name)].sort());
	assert.match(usage, /^\/split \S+ \S+/m);
	assert.match(usage, /--name <name>|--name \w+/);
	// an example line that ends in a free-text prompt: a word that is not an agent, role, option or option value
	const words = new Set([...listAgents().map((a) => a.name), ...listRoles(undefined, listAgents()).map((r) => r.name)]);
	const withPrompt = usage.split("\n").filter((l) => /^\/split \S+/.test(l)).map((l) => l.replace(/\s+#.*$/, "").trim().split(/\s+/).slice(1)).filter((t) => {
		const rest = t.filter((w, i) => !(w === "--name" || t[i - 1] === "--name"));
		return rest.length >= 2 && !words.has(rest[rest.length - 1]!) && !rest[rest.length - 1]!.startsWith("--");
	});
	assert.ok(withPrompt.length > 0, "README usage needs an example ending in a free-text prompt");
});

test("drift: the README documents roles.json and every option the table lists", () => {
	const readme = readFileSync(README, "utf8");
	assert.match(readme, /roles\.json/);
	assert.match(readme, /## Roles/);
	for (const name of Object.keys(OPTIONS).filter((n) => ["name", "role"].includes(n))) assert.ok(readme.includes(`--${name}`), `README misses --${name}`);
});

test("roles without help flags lists the roles from roles.json too", () => {
	const dir = mkdtempSync(join(tmpdir(), "herdr-split-help-"));
	mkdirSync(join(dir, "herdr-split"));
	writeFileSync(join(dir, "herdr-split", "roles.json"), JSON.stringify({ critic: { prompt: "Critique." } }));
	const r = spawnSync(BIN, ["help", "--slash"], { encoding: "utf8", env: { ...process.env, XDG_CONFIG_HOME: dir } });
	assert.equal(r.status, 0);
	assert.match(r.stdout, /roles: critic\|judge\)\n$/);
});

test("--help with --json after another command prints the help JSON", () => {
	const r = run("agents", "--help", "--json");
	assert.equal(r.status, 0);
	assert.equal(r.stderr, "");
	assert.equal(r.stdout, run("help", "--json").stdout);
});

test("S5: help text and the README say --agent is required unless --role is given", () => {
	assert.match(run("help").stdout, /--agent <name> +.*Required unless --role is given\./);
	assert.match(readFileSync(README, "utf8"), /`--agent` is required unless `--role` is given/);
});

test("S6: help, help --json and the README document --prompt and --args-from-transcript", () => {
	const text = run("help").stdout;
	assert.match(text, /--prompt <text> +.*4000/);
	assert.match(text, /--args-from-transcript +Read the \/split arguments .*Claude Code transcript/);
	assert.match(text, /\[--prompt <text>\]/);
	const doc = JSON.parse(run("help", "--json").stdout);
	for (const c of ["launch", "split"]) assert.ok(doc.commands.find((x: { name: string }) => x.name === c).options.some((o: { flag: string; value?: string }) => o.flag === "--prompt" && o.value === "<text>"), c);
	assert.ok(doc.commands.find((x: { name: string }) => x.name === "split").options.some((o: { flag: string }) => o.flag === "--args-from-transcript"));
	const readme = readFileSync(README, "utf8");
	assert.match(readme, /## Prompt/);
	for (const flag of ["--prompt", "--args-from-transcript"]) assert.ok(readme.includes(flag), `README misses ${flag}`);
	assert.match(readme.split("## Usage")[1]!.split("\n## ")[0]!, /^\/split gentle \S+ \S+/m);
});
