import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkName, listRoles, resolveTarget } from "./roles.ts";
import { listAgents, UsageError } from "./split.ts";

function rolesFile(data: unknown): string {
	const f = join(mkdtempSync(join(tmpdir(), "herdr-split-roles-")), "roles.json");
	writeFileSync(f, JSON.stringify(data));
	return f;
}

test("the built-in judge role runs the judgment-day skill with gentle", () => {
	const judge = listRoles(undefined, listAgents()).find((r) => r.name === "judge")!;
	assert.equal(judge.agent, "gentle");
	assert.match(judge.prompt, /judgment-day/);
	assert.match(judge.prompt, /adversarial/);
	assert.match(judge.prompt, /pull request/);
});

test("roles.json adds roles and overrides built-ins, sorted by name", () => {
	const file = rolesFile({ critic: { prompt: "Critique." }, judge: { agent: "claude", prompt: "Mine." } });
	const roles = listRoles(file, listAgents());
	assert.deepEqual(roles, [
		{ name: "critic", agent: undefined, prompt: "Critique.", source: file },
		{ name: "judge", agent: "claude", prompt: "Mine.", source: file },
	]);
});

test("a role named like an agent is a UsageError naming it", () => {
	assert.throws(() => listRoles(rolesFile({ pi: { prompt: "x" } }), listAgents()), (e) => e instanceof UsageError && e.message === 'Role "pi" has the same name as an agent; rename it in roles.json');
});

test("invalid role entries are UsageErrors", () => {
	const cases: [unknown, string][] = [
		[{ critic: {} }, 'Role "critic" needs a prompt (roles.json)'],
		[{ critic: { prompt: "x", agent: "vim" } }, 'Role "critic" uses unknown agent "vim" (roles.json)'],
		[{ Critic: { prompt: "x" } }, 'Role name "Critic" must match ^[a-z][a-z0-9_-]{0,31}$ (roles.json)'],
	];
	for (const [data, message] of cases) assert.throws(() => listRoles(rolesFile(data), listAgents()), (e) => e instanceof UsageError && e.message === message);
});

test("resolveTarget: agent, role, agent + role, and the role-only fallback marker", () => {
	assert.equal(resolveTarget({ agent: "claude" }).agent?.name, "claude");
	assert.equal(resolveTarget({ agent: "claude" }).role, undefined);
	const judge = resolveTarget({ agent: "judge" });
	assert.equal(judge.role?.name, "judge");
	assert.equal(judge.agent?.name, "gentle");
	const both = resolveTarget({ agent: "pi", role: "judge" });
	assert.deepEqual([both.agent?.name, both.role?.name], ["pi", "judge"]);
	assert.equal(resolveTarget({ role: "judge" }).agent?.name, "gentle");
	const free = resolveTarget({ agent: "critic" }, undefined, rolesFile({ critic: { prompt: "x" } }));
	assert.equal(free.agent, undefined);
	assert.equal(free.role?.name, "critic");
});

test("resolveTarget errors", () => {
	assert.throws(() => resolveTarget({ agent: "vim" }), /^Error: Unknown agent "vim"\. Known agents: claude, codex, gentle, pi\. Known roles: judge$/);
	assert.throws(() => resolveTarget({ agent: "claude", role: "x" }), (e) => e instanceof UsageError && e.message === 'Unknown role "x". Known roles: judge');
	assert.throws(() => resolveTarget({}), (e) => e instanceof UsageError && e.message === "--agent or --role is required");
});

test("checkName accepts the documented pattern only", () => {
	assert.equal(checkName("reviewer"), "reviewer");
	assert.equal(checkName("a" + "b".repeat(31)), "a" + "b".repeat(31));
	assert.equal(checkName(undefined), undefined);
	for (const bad of ["", "Bad", "9a", "a.b", "a b", "a".repeat(33)]) assert.throws(() => checkName(bad), (e) => e instanceof UsageError && e.message === `--name must match ^[a-z][a-z0-9_-]{0,31}$, got "${bad}"`);
});

test("an agent named like a built-in role shadows it instead of failing", () => {
	const agents = [...listAgents(), { name: "judge", exec: "judge-cli", format: null }];
	const roles = listRoles(undefined, agents);
	assert.equal(roles.some((r) => r.name === "judge"), false);
});

test("S1: a malformed or non-object roles.json is a UsageError naming the file", () => {
	const dir = mkdtempSync(join(tmpdir(), "herdr-split-roles-"));
	const bad = join(dir, "roles.json");
	writeFileSync(bad, "{ not json");
	assert.throws(() => listRoles(bad, listAgents()), (e) => e instanceof UsageError && e.message.startsWith(`Cannot read ${bad}: `) && e.message.length > `Cannot read ${bad}: `.length);
	for (const content of ["[]", "null", "3"]) {
		writeFileSync(bad, content);
		assert.throws(() => listRoles(bad, listAgents()), (e) => e instanceof UsageError && e.message === `Cannot read ${bad}: expected a JSON object`, content);
	}
});

test("S3: resolveTarget throws a UsageError for an unknown agent, message unchanged", () => {
	assert.throws(() => resolveTarget({ agent: "vim" }), (e) => e instanceof UsageError && e.message === 'Unknown agent "vim". Known agents: claude, codex, gentle, pi. Known roles: judge');
});
