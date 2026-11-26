/**
 * Roles: a name for a split plus an instruction for the agent that gets it, optionally pinned
 * to an agent. Built-ins live here; `roles.json` next to `agents.json` adds or overrides them,
 * personal role files (`roles/<name>.md` next to it) override both, and project role files
 * (`<git root>/.herdr-split/roles/<name>.md`) may only add new names.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { listAgents, readConfigObject, UsageError, type Agent } from "./split.ts";

export interface Role {
	name: string;
	/** Agent the role splits into; without it the split uses the source conversation's agent. */
	agent?: string;
	prompt: string;
	/** "built-in", or the file the role was read from. */
	source: string;
}

/** A role file that was not loaded, and why. */
export interface SkippedRole {
	name: string;
	source: string;
	reason: string;
}

const MAX_ROLE_FILE_BYTES = 64 * 1024;

/** Text from role files must not reach a terminal with escape sequences: drop C0/C1 controls (keeping \n and \t when asked). */
function stripControls(text: string, keepWhitespace = false): string {
	return text.replace(keepWhitespace ? /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g : /[\u0000-\u001f\u007f-\u009f]/g, "");
}

export const NAME_PATTERN = "^[a-z][a-z0-9_-]{0,31}$";
export const NAME_RE = new RegExp(NAME_PATTERN);

const BUILTIN: Record<string, Omit<Role, "name">> = {
	judge: {
		agent: "gentle",
		prompt:
			"Run the judgment-day skill for an adversarial review of the pull request discussed in this conversation, and report its verdict.",
	},
};

/** The name given with --name; undefined stays undefined. */
export function checkName(name: string | undefined): string | undefined {
	if (name === undefined) return undefined;
	if (!NAME_RE.test(name)) throw new UsageError(`--name must match ${NAME_PATTERN}, got "${name}"`);
	return name;
}

/** The nearest directory at or above `dir` holding `.git` (a directory, or a file in a worktree). */
export function gitRoot(dir: string): string | undefined {
	for (let at = dir; ; at = dirname(at)) {
		if (existsSync(join(at, ".git"))) return at;
		if (dirname(at) === at) return undefined;
	}
}

/** `---` / `agent: <name>` / `---` then the prompt; returns the reason when the file is not a usable role. */
function parseRoleFile(text: string, agents: Agent[]): { agent?: string; prompt: string } | string {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	let agent: string | undefined;
	let body = lines;
	if (lines[0]?.trim() === "---") {
		const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
		if (end < 0) return "the front-matter is not closed with ---";
		for (const line of lines.slice(1, end)) {
			if (!line.trim()) continue;
			const pair = /^([A-Za-z_-]+):(.*)$/.exec(line.trim());
			if (!pair) return `front-matter line "${line.trim()}" is not "key: value"`;
			if (pair[1] !== "agent") return `unknown front-matter key "${pair[1]}" (only "agent")`;
			agent = pair[2]!.trim();
			if (!agent) return 'front-matter "agent" needs a value';
		}
		body = lines.slice(end + 1);
	}
	const prompt = stripControls(body.join("\n"), true).trim();
	if (!prompt) return "it has no prompt after the front-matter";
	if (agent !== undefined && !agents.some((a) => a.name === agent)) return `it uses unknown agent "${agent}"`;
	return { agent, prompt };
}

function isSymlink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

/** Every `<name>.md` in `dir`, parsed; a missing directory has none. */
function readRoleDir(dir: string, agents: Agent[], project: boolean): { roles: Role[]; skipped: SkippedRole[]; invalidNames: string[] } {
	const roles: Role[] = [];
	const skipped: SkippedRole[] = [];
	/** Valid role names whose file was skipped (a bad file name is never one). */
	const invalidNames: string[] = [];
	let files: string[];
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
	} catch {
		return { roles, skipped, invalidNames };
	}
	for (const file of files) {
		const name = file.slice(0, -".md".length);
		const source = join(dir, file);
		const skip = (reason: string) => {
			skipped.push({ name: stripControls(name), source: stripControls(source), reason: stripControls(reason) });
			if (NAME_RE.test(name)) invalidNames.push(name);
		};
		if (!NAME_RE.test(name)) {
			skip(`the file name must match ${NAME_PATTERN} plus .md`);
			continue;
		}
		if (agents.some((a) => a.name === name)) {
			skip("it has the same name as an agent");
			continue;
		}
		let parsed;
		try {
			// Look before reading: a device or FIFO behind the name would hang readFileSync.
			if (project && lstatSync(source).isSymbolicLink()) {
				skip("it is a symlink; project role files must be regular files");
				continue;
			}
			const info = statSync(source);
			if (!info.isFile()) {
				skip("it is not a regular file");
				continue;
			}
			if (info.size > MAX_ROLE_FILE_BYTES) {
				skip("it is larger than 64 KiB");
				continue;
			}
			parsed = parseRoleFile(readFileSync(source, "utf8"), agents);
		} catch (error) {
			skip(`it cannot be read: ${(error as Error).message}`);
			continue;
		}
		if (typeof parsed === "string") skip(parsed);
		else roles.push({ name, agent: parsed.agent, prompt: parsed.prompt, source: stripControls(source) });
	}
	return { roles, skipped, invalidNames };
}

/**
 * Built-ins, then `{ "<role>": { "agent"?: "<agent>", "prompt": "<text>" } }` from roles.json, then
 * personal role files, then project role files that add new names. roles.json errors throw; role
 * files that cannot be used are returned in `skipped` so the other roles keep working.
 */
export function loadRoles(rolesFile: string | undefined, agents: Agent[], cwd: string = process.cwd()): { roles: Role[]; skipped: SkippedRole[] } {
	// A user agent named like a built-in role shadows that role; only roles.json clashes are errors.
	const roles: Record<string, Omit<Role, "name">> = Object.fromEntries(
		Object.entries(BUILTIN)
			.filter(([name]) => !agents.some((a) => a.name === name))
			.map(([name, role]) => [name, { ...role, source: "built-in" }]),
	);
	if (rolesFile && existsSync(rolesFile)) {
		const extra = readConfigObject(rolesFile) as Record<string, { agent?: unknown; prompt?: unknown }>;
		for (const [name, value] of Object.entries(extra)) {
			if (!NAME_RE.test(name)) throw new UsageError(`Role name "${name}" must match ${NAME_PATTERN} (roles.json)`);
			if (agents.some((a) => a.name === name)) throw new UsageError(`Role "${name}" has the same name as an agent; rename it in roles.json`);
			if (typeof value?.prompt !== "string" || !value.prompt.trim()) throw new UsageError(`Role "${name}" needs a prompt (roles.json)`);
			if (value.agent !== undefined && !agents.some((a) => a.name === value.agent)) throw new UsageError(`Role "${name}" uses unknown agent "${String(value.agent)}" (roles.json)`);
			roles[name] = { agent: value.agent as string | undefined, prompt: value.prompt, source: rolesFile };
		}
	}
	const skipped: SkippedRole[] = [];
	if (rolesFile) {
		const personal = readRoleDir(join(dirname(rolesFile), "roles"), agents, false);
		for (const { name, ...role } of personal.roles) roles[name] = role;
		// An invalid personal file hides the lower role of its name rather than letting it quietly win.
		for (const name of personal.invalidNames) if (Object.hasOwn(roles, name)) delete roles[name];
		skipped.push(...personal.skipped);
	}
	const root = gitRoot(cwd);
	// A symlinked .herdr-split or roles directory could point outside the repository: project roles are then not read at all.
	const linked = root && [join(root, ".herdr-split"), join(root, ".herdr-split", "roles")].find((d) => isSymlink(d));
	if (root && linked) skipped.push({ name: "*", source: stripControls(linked), reason: "it is a symlink; project role directories must be real directories" });
	else if (root) {
		// Project files come with the repository, which may be someone else's: they never replace a role you have.
		const project = readRoleDir(join(root, ".herdr-split", "roles"), agents, true);
		for (const { name, ...role } of project.roles) {
			const existing = Object.hasOwn(roles, name) ? roles[name] : undefined;
			if (existing) skipped.push({ name, source: role.source, reason: `a project role cannot replace the "${name}" role from ${existing.source}` });
			else roles[name] = role;
		}
		skipped.push(...project.skipped);
	}
	return {
		roles: Object.keys(roles)
			.sort()
			.map((name) => ({ name, ...roles[name]! })),
		skipped: skipped.sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0)),
	};
}

/** The usable roles (see loadRoles); skipped role files are left out. */
export function listRoles(rolesFile: string | undefined, agents: Agent[], cwd?: string): Role[] {
	return loadRoles(rolesFile, agents, cwd).roles;
}

export interface Target {
	/** Undefined for a role without an agent: the caller falls back to the source agent. */
	agent?: Agent;
	role?: Role;
}

/** `agent` may name an agent or a role; `role` is a role used with that agent. */
export function resolveTarget(sel: { agent?: string; role?: string }, agentsFile?: string, rolesFile?: string, cwd?: string): Target {
	if (!sel.agent && !sel.role) throw new UsageError("--agent or --role is required");
	const agents = listAgents(agentsFile);
	const { roles, skipped } = loadRoles(rolesFile, agents, cwd);
	const roleNames = roles.map((r) => r.name).join(", ");
	/** A role asked for by name; a role file that was skipped explains why instead of "unknown". */
	const findRole = (name: string) => {
		const found = roles.find((r) => r.name === name);
		const bad = found ? undefined : skipped.find((s) => s.name === name);
		if (bad) throw new UsageError(`Role "${name}" cannot be used: ${bad.source}: ${bad.reason}`);
		return found;
	};
	const roleNamed = (name: string) => {
		const found = findRole(name);
		if (!found) throw new UsageError(`Unknown role "${name}". Known roles: ${roleNames}`);
		return found;
	};
	let agent: Agent | undefined;
	let role: Role | undefined;
	if (sel.agent) {
		agent = agents.find((a) => a.name === sel.agent);
		if (!agent) {
			role = findRole(sel.agent);
			if (!role) throw new UsageError(`Unknown agent "${sel.agent}". Known agents: ${agents.map((a) => a.name).join(", ")}. Known roles: ${roleNames}`);
			if (sel.role) throw new UsageError(`--agent ${sel.agent} is a role; it cannot be combined with --role`);
		}
	}
	if (sel.role) role = roleNamed(sel.role);
	if (!agent && role?.agent) agent = agents.find((a) => a.name === role.agent);
	return { agent, role };
}

/** The agent for a role without one: the herdr-split agent running what Herdr detected in the source pane, else the source kind. */
export function sourceAgentFor(detected: string, kind: string, agentsFile?: string): Agent {
	const agents = listAgents(agentsFile);
	const byName = (name: string) => agents.find((a) => a.name === name || a.exec === name || a.exec.split(" ")[0] === name);
	const found = byName(detected) ?? byName(kind);
	if (!found) throw new UsageError(`No agent matches the source agent "${detected}"; use an agent with this role`);
	return found;
}
