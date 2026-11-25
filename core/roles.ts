/**
 * Roles: a name for a split plus an instruction for the agent that gets it, optionally pinned
 * to an agent. Built-ins live here; `roles.json` next to `agents.json` adds or overrides them.
 */
import { existsSync, readFileSync } from "node:fs";
import { listAgents, UsageError, type Agent } from "./split.ts";

export interface Role {
	name: string;
	/** Agent the role splits into; without it the split uses the source conversation's agent. */
	agent?: string;
	prompt: string;
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

/** Built-in roles plus `{ "<role>": { "agent"?: "<agent>", "prompt": "<text>" } }` from the config file. */
export function listRoles(rolesFile: string | undefined, agents: Agent[]): Role[] {
	const roles: Record<string, Omit<Role, "name">> = { ...BUILTIN };
	if (rolesFile && existsSync(rolesFile)) {
		const extra = JSON.parse(readFileSync(rolesFile, "utf8")) as Record<string, { agent?: unknown; prompt?: unknown }>;
		for (const [name, value] of Object.entries(extra)) {
			if (!NAME_RE.test(name)) throw new UsageError(`Role name "${name}" must match ${NAME_PATTERN} (roles.json)`);
			if (typeof value?.prompt !== "string" || !value.prompt.trim()) throw new UsageError(`Role "${name}" needs a prompt (roles.json)`);
			if (value.agent !== undefined && !agents.some((a) => a.name === value.agent)) throw new UsageError(`Role "${name}" uses unknown agent "${String(value.agent)}" (roles.json)`);
			roles[name] = { agent: value.agent as string | undefined, prompt: value.prompt };
		}
	}
	for (const name of Object.keys(roles)) {
		if (agents.some((a) => a.name === name)) throw new UsageError(`Role "${name}" has the same name as an agent; rename it in roles.json`);
	}
	return Object.keys(roles)
		.sort()
		.map((name) => ({ name, ...roles[name]! }));
}

export interface Target {
	/** Undefined for a role without an agent: the caller falls back to the source agent. */
	agent?: Agent;
	role?: Role;
}

/** `agent` may name an agent or a role; `role` is a role used with that agent. */
export function resolveTarget(sel: { agent?: string; role?: string }, agentsFile?: string, rolesFile?: string): Target {
	if (!sel.agent && !sel.role) throw new UsageError("--agent or --role is required");
	const agents = listAgents(agentsFile);
	const roles = listRoles(rolesFile, agents);
	const roleNames = roles.map((r) => r.name).join(", ");
	const roleNamed = (name: string) => {
		const found = roles.find((r) => r.name === name);
		if (!found) throw new UsageError(`Unknown role "${name}". Known roles: ${roleNames}`);
		return found;
	};
	let agent: Agent | undefined;
	let role: Role | undefined;
	if (sel.agent) {
		agent = agents.find((a) => a.name === sel.agent);
		if (!agent) {
			role = roles.find((r) => r.name === sel.agent);
			if (!role) throw new Error(`Unknown agent "${sel.agent}". Known agents: ${agents.map((a) => a.name).join(", ")}. Known roles: ${roleNames}`);
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
