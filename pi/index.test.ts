import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The Pi package is only present inside Pi; the extension needs nothing from it at registration.
registerHooks({
	resolve: (specifier, context, next) =>
		specifier === "@earendil-works/pi-coding-agent"
			? { url: "data:text/javascript,export const SessionManager = {};", shortCircuit: true }
			: next(specifier, context),
});

type Registered = { description: string; getArgumentCompletions(prefix: string): { value: string }[] | null; handler: unknown };

async function register(config: string | undefined): Promise<Record<string, Registered>> {
	const home = mkdtempSync(join(tmpdir(), "herdr-split-ext-"));
	if (config !== undefined) {
		mkdirSync(join(home, "herdr-split"));
		writeFileSync(join(home, "herdr-split", "agents.json"), config);
	}
	const saved = { xdg: process.env.XDG_CONFIG_HOME, child: process.env.GENTLE_PI_AGENTS_CHILD };
	process.env.XDG_CONFIG_HOME = home;
	delete process.env.GENTLE_PI_AGENTS_CHILD;
	try {
		const { default: extension } = await import("./index.ts");
		const commands: Record<string, Registered> = {};
		extension({ registerCommand: (name: string, options: Registered) => (commands[name] = options) } as never);
		return commands;
	} finally {
		if (saved.xdg === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = saved.xdg;
		if (saved.child !== undefined) process.env.GENTLE_PI_AGENTS_CHILD = saved.child;
	}
}

test("the extension registers /split with the agents from agents.json", async () => {
	const split = (await register(JSON.stringify({ aider: { exec: "aider", format: null } }))).split!;
	assert.equal(split.description, "Branch this conversation into another agent in a new Herdr pane: /split <aider|claude|codex|gentle|pi>");
	assert.deepEqual(split.getArgumentCompletions("a")?.map((i) => i.value), ["aider"]);
	assert.equal(typeof split.handler, "function");
});

test("without agents.json the extension registers /split with the built-ins", async () => {
	const split = (await register(undefined)).split!;
	assert.equal(split.description, "Branch this conversation into another agent in a new Herdr pane: /split <claude|codex|gentle|pi>");
	assert.deepEqual(split.getArgumentCompletions("")?.map((i) => i.value), ["claude", "codex", "gentle", "pi"]);
});

test("a malformed agents.json still registers /split and says why it is ignored", async () => {
	const split = (await register("{ not json")).split!;
	assert.match(split.description, /: \/split <claude\|codex\|gentle\|pi> \(ignoring .*agents\.json: .+\)$/);
	assert.deepEqual(split.getArgumentCompletions("g")?.map((i) => i.value), ["gentle"]);
});
