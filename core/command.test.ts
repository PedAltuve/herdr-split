import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSplitCommand, PROMPT_LIMIT } from "./command.ts";
import { listRoles } from "./roles.ts";
import { listAgents, UsageError } from "./split.ts";

const agents = listAgents();
const roles = listRoles(undefined, agents);
const parse = (text: string) => parseSplitCommand(text, agents, roles);
const fails = (text: string, message: string) => assert.throws(() => parse(text), (e) => e instanceof UsageError && e.message === message, text);

test("S1: an agent or role alone, with or without a role, a name and a prompt", () => {
	assert.deepEqual(parse(""), {});
	assert.deepEqual(parse("   \n "), {});
	assert.deepEqual(parse("gentle"), { agent: "gentle" });
	assert.deepEqual(parse("judge"), { agent: "judge" });
	assert.deepEqual(parse("gentle judge"), { agent: "gentle", role: "judge" });
	assert.deepEqual(parse("  gentle   judge --name rev "), { agent: "gentle", role: "judge", name: "rev" });
	assert.deepEqual(parse("--name=rev judge"), { agent: "judge", name: "rev" });
	assert.deepEqual(parse("gentle --name rev judge"), { agent: "gentle", role: "judge", name: "rev" });
});

test("S1: the second word is a role only when it names a known role, otherwise it starts the prompt", () => {
	assert.deepEqual(parse("gentle run a judge on PR X"), { agent: "gentle", prompt: "run a judge on PR X" });
	assert.deepEqual(parse("gentle judge only review PR 4"), { agent: "gentle", role: "judge", prompt: "only review PR 4" });
	// a first word that is a role has no second role: the rest is the prompt
	assert.deepEqual(parse("judge judge the PR"), { agent: "judge", prompt: "judge the PR" });
	// an unknown first word is left for the caller to reject
	assert.deepEqual(parse("vim judge"), { agent: "vim", prompt: "judge" });
	const custom = parseSplitCommand("claude critic fix it", agents, listRoles(undefined, agents).concat({ name: "critic", prompt: "x" }));
	assert.deepEqual(custom, { agent: "claude", role: "critic", prompt: "fix it" });
});

test("S1: --name is read only before the prompt; from the first prompt word on everything is literal", () => {
	assert.deepEqual(parse("gentle --name rev do something"), { agent: "gentle", name: "rev", prompt: "do something" });
	assert.deepEqual(parse("gentle do --name x something"), { agent: "gentle", prompt: "do --name x something" });
	assert.deepEqual(parse("gentle go --bogus"), { agent: "gentle", prompt: "go --bogus" });
});

test("S2: the prompt is collapsed to one line", () => {
	assert.deepEqual(parse("gentle  do\n\n  this \t and   that\n"), { agent: "gentle", prompt: "do this and that" });
});

test("S2: a prompt longer than the limit is rejected, the limit itself is accepted", () => {
	assert.equal(PROMPT_LIMIT, 4000);
	assert.equal(parse(`gentle ${"a".repeat(4000)}`).prompt?.length, 4000);
	fails(`gentle ${"a".repeat(4001)}`, "The prompt is 4001 characters long; the limit is 4000");
});

test("S1 preserve: the errors the old Pi parser gave still hold", () => {
	fails("gentle --name", "--name needs a value");
	fails("gentle --name=", "--name needs a value");
	fails("gentle --name a --name b", "--name can be given only once");
	fails("gentle --name a' --name b", "--name can be given only once");
});

test("S1: any other word starting with - starts the prompt; --name stays the only option before it", () => {
	assert.deepEqual(parse("gentle --security"), { agent: "gentle", prompt: "--security" });
	assert.deepEqual(parse("gentle --bogus=1 review"), { agent: "gentle", prompt: "--bogus=1 review" });
	assert.deepEqual(parse("gentle -x y"), { agent: "gentle", prompt: "-x y" });
	assert.deepEqual(parse("gentle --name rev --security"), { agent: "gentle", name: "rev", prompt: "--security" });
	assert.deepEqual(parse("gentle judge --security"), { agent: "gentle", role: "judge", prompt: "--security" });
	assert.deepEqual(parse("--security"), { prompt: "--security" });
});

test("S2: C0 control characters and DEL are removed from the prompt, whitespace still collapses", () => {
	assert.deepEqual(parse("gentle a\x15b\x03c\x1b[31md\x7fe\x00f"), { agent: "gentle", prompt: "abc[31mdef" });
	assert.deepEqual(parse("gentle a\x0bb\x0cc\r\nd\te"), { agent: "gentle", prompt: "a b c d e" });
	assert.deepEqual(parse("gentle \x15\x03"), { agent: "gentle" });
});
