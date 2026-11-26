import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitRoot, listRoles, loadRoles, resolveTarget } from "./roles.ts";
import { listAgents, UsageError } from "./split.ts";

/** A config dir (roles.json optional, personal role files) and a git project with project role files. */
function fixture(opts: { rolesJson?: unknown; personal?: Record<string, string>; project?: Record<string, string>; git?: boolean } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "herdr-split-role-files-"));
	const cfg = join(dir, "cfg", "herdr-split");
	mkdirSync(join(cfg, "roles"), { recursive: true });
	const rolesFile = join(cfg, "roles.json");
	if (opts.rolesJson !== undefined) writeFileSync(rolesFile, JSON.stringify(opts.rolesJson));
	for (const [file, text] of Object.entries(opts.personal ?? {})) writeFileSync(join(cfg, "roles", file), text);
	const project = join(dir, "repo");
	mkdirSync(join(project, ".herdr-split", "roles"), { recursive: true });
	if (opts.git !== false) mkdirSync(join(project, ".git"));
	for (const [file, text] of Object.entries(opts.project ?? {})) writeFileSync(join(project, ".herdr-split", "roles", file), text);
	const cwd = join(project, "src", "deep");
	mkdirSync(cwd, { recursive: true });
	return { rolesFile, personalDir: join(cfg, "roles"), projectDir: join(project, ".herdr-split", "roles"), project, cwd };
}

test("gitRoot walks up to the directory holding .git (a dir or a worktree file)", () => {
	const f = fixture();
	assert.equal(gitRoot(f.cwd), f.project);
	const wt = mkdtempSync(join(tmpdir(), "herdr-split-wt-"));
	writeFileSync(join(wt, ".git"), "gitdir: /elsewhere\n");
	assert.equal(gitRoot(wt), wt);
	assert.equal(gitRoot(fixture({ git: false }).cwd), undefined);
});

test("S2: a role file's body is the prompt and its front-matter pins the agent", () => {
	const f = fixture({
		project: { "critic.md": "---\nagent: claude\n---\n\n# Critic\n\nReview the plan.\n\n- Each finding stands alone.\n" },
		personal: { "notes.md": "Take notes.\n" },
	});
	const roles = listRoles(f.rolesFile, listAgents(), f.cwd);
	assert.deepEqual(roles.find((r) => r.name === "critic"), {
		name: "critic",
		agent: "claude",
		prompt: "# Critic\n\nReview the plan.\n\n- Each finding stands alone.",
		source: join(f.projectDir, "critic.md"),
	});
	assert.deepEqual(roles.find((r) => r.name === "notes"), { name: "notes", agent: undefined, prompt: "Take notes.", source: join(f.personalDir, "notes.md") });
	assert.equal(roles.find((r) => r.name === "judge")?.source, "built-in");
	assert.deepEqual(roles.map((r) => r.name), ["critic", "judge", "notes"]);
});

test("S1: outside a git repository there are no project roles", () => {
	const f = fixture({ git: false, project: { "critic.md": "Review." } });
	assert.deepEqual(listRoles(f.rolesFile, listAgents(), f.cwd).map((r) => r.name), ["judge"]);
});

test("S3: personal file > roles.json > built-in", () => {
	const f = fixture({ rolesJson: { judge: { prompt: "From json." }, critic: { prompt: "Json critic." } }, personal: { "critic.md": "File critic." } });
	const { roles, skipped } = loadRoles(f.rolesFile, listAgents(), f.cwd);
	assert.deepEqual(skipped, []);
	assert.deepEqual(roles.map((r) => [r.name, r.prompt, r.source]), [
		["critic", "File critic.", join(f.personalDir, "critic.md")],
		["judge", "From json.", f.rolesFile],
	]);
});

test("S3: a project role cannot replace a personal, roles.json or built-in role; it is skipped with the reason", () => {
	const f = fixture({
		rolesJson: { critic: { prompt: "Json critic." } },
		personal: { "notes.md": "Mine." },
		project: { "judge.md": "Hostile judge.", "critic.md": "Hostile critic.", "notes.md": "Hostile notes.", "fresh.md": "New." },
	});
	const { roles, skipped } = loadRoles(f.rolesFile, listAgents(), f.cwd);
	assert.deepEqual(roles.map((r) => [r.name, r.source]), [
		["critic", f.rolesFile],
		["fresh", join(f.projectDir, "fresh.md")],
		["judge", "built-in"],
		["notes", join(f.personalDir, "notes.md")],
	]);
	assert.deepEqual(skipped, [
		{ name: "critic", source: join(f.projectDir, "critic.md"), reason: `a project role cannot replace the "critic" role from ${f.rolesFile}` },
		{ name: "judge", source: join(f.projectDir, "judge.md"), reason: 'a project role cannot replace the "judge" role from built-in' },
		{ name: "notes", source: join(f.projectDir, "notes.md"), reason: `a project role cannot replace the "notes" role from ${join(f.personalDir, "notes.md")}` },
	]);
});

test("S4: invalid role files are skipped with their reason, others still load", () => {
	const f = fixture({
		project: {
			"empty.md": "---\nagent: claude\n---\n  \n",
			"Bad.md": "x",
			"ghost.md": "---\nagent: vim\n---\nx",
			"open.md": "---\nagent: claude\nx",
			"odd.md": "---\nmodel: x\n---\nx",
			"junk.md": "---\nnot a pair\n---\nx",
			"blank.md": "---\nagent:\n---\nx",
			"pi.md": "x",
			"ok.md": "Fine.",
			"notes.txt": "not a role",
		},
	});
	const { roles, skipped } = loadRoles(undefined, listAgents(), f.cwd);
	assert.deepEqual(roles.map((r) => r.name), ["judge", "ok"]);
	const p = (n: string) => join(f.projectDir, n);
	assert.deepEqual(skipped, [
		{ name: "Bad", source: p("Bad.md"), reason: "the file name must match ^[a-z][a-z0-9_-]{0,31}$ plus .md" },
		{ name: "blank", source: p("blank.md"), reason: 'front-matter "agent" needs a value' },
		{ name: "empty", source: p("empty.md"), reason: "it has no prompt after the front-matter" },
		{ name: "ghost", source: p("ghost.md"), reason: 'it uses unknown agent "vim"' },
		{ name: "junk", source: p("junk.md"), reason: 'front-matter line "not a pair" is not "key: value"' },
		{ name: "odd", source: p("odd.md"), reason: 'unknown front-matter key "model" (only "agent")' },
		{ name: "open", source: p("open.md"), reason: "the front-matter is not closed with ---" },
		{ name: "pi", source: p("pi.md"), reason: "it has the same name as an agent" },
	]);
});

test("S4: asking for an invalid role is a UsageError naming the file; other roles still resolve", () => {
	const f = fixture({ project: { "ghost.md": "---\nagent: vim\n---\nx", "ok.md": "Fine." } });
	assert.throws(
		() => resolveTarget({ agent: "ghost" }, undefined, f.rolesFile, f.cwd),
		(e) => e instanceof UsageError && e.message === `Role "ghost" cannot be used: ${join(f.projectDir, "ghost.md")}: it uses unknown agent "vim"`,
	);
	assert.throws(() => resolveTarget({ agent: "claude", role: "ghost" }, undefined, f.rolesFile, f.cwd), /^Error: Role "ghost" cannot be used: /);
	assert.equal(resolveTarget({ agent: "ok" }, undefined, f.rolesFile, f.cwd).role?.prompt, "Fine.");
	assert.equal(resolveTarget({ agent: "claude" }, undefined, f.rolesFile, f.cwd).agent?.name, "claude");
});

test("S3: asking for a shadowed name gets the role that won", () => {
	const f = fixture({ project: { "judge.md": "Hostile." } });
	const { role } = resolveTarget({ agent: "judge" }, undefined, f.rolesFile, f.cwd);
	assert.equal(role?.source, "built-in");
	assert.match(role!.prompt, /judgment-day/);
});

test("S3: a project role named like an Object.prototype key is a new role, not a clash", () => {
	const f = fixture({ project: { "constructor.md": "Construct a plan.", "tostring.md": "x" } });
	const { roles, skipped } = loadRoles(f.rolesFile, listAgents(), f.cwd);
	assert.deepEqual(skipped, []);
	assert.equal(roles.find((r) => r.name === "constructor")?.prompt, "Construct a plan.");
});

test("roles.json errors still stop everything (unchanged)", () => {
	const f = fixture({ rolesJson: { pi: { prompt: "x" } }, project: { "ok.md": "Fine." } });
	assert.throws(() => listRoles(f.rolesFile, listAgents(), f.cwd), (e) => e instanceof UsageError && e.message === 'Role "pi" has the same name as an agent; rename it in roles.json');
});
