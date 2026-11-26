/** Pure logic of Pi's /split: pick agent and turn, optionally branch natively, delegate to the core CLI. */
import { parseSplitCommand } from "../core/command.ts";
import { readSession } from "../core/sessions.ts";
import { slashUsage } from "../core/help.ts";
import { checkName, listRoles, loadRoles, resolveTarget, type Role } from "../core/roles.ts";
import { listAgents, type Agent } from "../core/split.ts";

/**
 * Agents and roles for hints only: an unreadable or malformed config falls back to the built-ins
 * so /split still registers; `problem` says why (running /split reports the error too).
 */
/** The reason a config failed to load, without the "Cannot read <file>: " prefix that `ignoring <file>` already says. */
function reason(error: unknown, file: string | undefined): string {
	const message = error instanceof Error ? error.message : String(error);
	const prefix = `Cannot read ${file}: `;
	return message.startsWith(prefix) ? message.slice(prefix.length) : message;
}

function hints(configFile: string | undefined, rolesFile: string | undefined, cwd?: string): { agents: Agent[]; roles: Role[]; problem?: string } {
	const problems: string[] = [];
	let agents: Agent[];
	try {
		agents = listAgents(configFile);
	} catch (error) {
		agents = listAgents();
		problems.push(`ignoring ${configFile}: ${reason(error, configFile)}`);
	}
	let roles: Role[];
	try {
		const loaded = loadRoles(rolesFile, agents, cwd);
		roles = loaded.roles;
		for (const s of loaded.skipped) problems.push(`ignoring ${s.source}: ${s.reason}`);
	} catch (error) {
		try {
			roles = listRoles(undefined, agents, cwd);
		} catch {
			roles = [];
		}
		problems.push(`ignoring ${rolesFile}: ${reason(error, rolesFile)}`);
	}
	return { agents, roles, problem: problems.length ? problems.join("; ") : undefined };
}

/**
 * What Pi registers for /split: description and completions both list the configured agents and roles.
 * Project roles come from the git root of `cwd` (default: the directory Pi runs in, read on each completion).
 */
export function splitCommandInfo(configFile: string | undefined, rolesFile?: string, cwd?: string) {
	const { agents, roles, problem } = hints(configFile, rolesFile, cwd);
	return {
		description: `Branch this conversation into another agent in a new Herdr pane: ${slashUsage(agents, roles)}${problem ? ` (${problem})` : ""}`,
		getArgumentCompletions: (prefix: string) => agentCompletions(prefix, configFile, rolesFile, cwd),
	};
}

/** First word: agents and roles; second word (after an agent): roles. A role's description is where it comes from. */
export function agentCompletions(prefix: string, configFile?: string, rolesFile?: string, cwd?: string): { value: string; label: string; description?: string }[] | null {
	const { agents, roles } = hints(configFile, rolesFile, cwd);
	const words = prefix.split(/\s+/);
	const last = words.pop()!;
	const before = words.filter(Boolean);
	let names: string[];
	if (before.length === 0) names = [...agents.map((a) => a.name), ...roles.map((r) => r.name)];
	else if (before.length === 1 && agents.some((a) => a.name === before[0])) names = roles.map((r) => r.name);
	else return null;
	const source = (n: string) => roles.find((r) => r.name === n && !agents.some((a) => a.name === n))?.source;
	const items = names.filter((n) => n.startsWith(last)).map((n) => ({ value: [...before, n].join(" "), label: n, description: source(n) }));
	return items.length ? items : null;
}

export interface SplitDeps {
	env: Record<string, string | undefined>;
	sessionFile: string;
	leafId: string | undefined;
	configFile: string | undefined;
	rolesFile?: string;
	/** Where /split runs; project roles come from its git root (default: process.cwd()). */
	cwd?: string;
	select(title: string, options: string[]): Promise<string | undefined>;
	notify(msg: string, level: "info" | "error"): void;
	branch(sessionFile: string, cutId: string): string;
	launch(args: string[]): Promise<{ pane: string; command: string; agent?: string }>;
}

export async function runSplit(args: string, deps: SplitDeps): Promise<void> {
	try {
		if (deps.env.HERDR_ENV !== "1" || !deps.env.HERDR_PANE_ID) {
			deps.notify("/split needs Herdr: run Pi inside a Herdr pane.", "error");
			return;
		}
		let parsed;
		try {
			const agents = listAgents(deps.configFile);
			const { roles, skipped } = loadRoles(deps.rolesFile, agents, deps.cwd);
			for (const s of skipped) deps.notify(`ignoring ${s.source}: ${s.reason}`, "info");
			parsed = parseSplitCommand(args, agents, roles);
		} catch (error) {
			deps.notify(error instanceof Error ? error.message : String(error), "error");
			return;
		}
		let first = parsed.agent;
		if (!first) {
			const agents = listAgents(deps.configFile);
			const picked = await deps.select("Split into which agent or role?", [...agents.map((a) => a.name), ...listRoles(deps.rolesFile, agents, deps.cwd).map((r) => r.name)]);
			if (!picked) {
				deps.notify("Split cancelled.", "info");
				return;
			}
			first = picked;
		}
		let resolved;
		try {
			checkName(parsed.name);
			resolved = resolveTarget({ agent: first, role: parsed.role }, deps.configFile, deps.rolesFile, deps.cwd);
		} catch (error) {
			deps.notify(error instanceof Error ? error.message : String(error), "error");
			return;
		}
		// A role without an agent splits into the source agent, which in Pi is a Pi-format agent;
		// a resolved agent branches natively only when it resumes Pi sessions (format null gets a transcript).
		const piFormat = resolved.agent ? resolved.agent.format === "pi" : true;

		const turns = readSession("pi", deps.sessionFile, deps.leafId).turns;
		if (!turns.length) {
			deps.notify("This conversation has no messages to branch from yet.", "info");
			return;
		}
		const labels = turns.map((t) => `${t.index}. ${t.prompt}`).reverse();
		const choice = await deps.select("Branch after which message? The branch keeps it and everything before it.", labels);
		const turn = choice === undefined ? undefined : turns[labels.length - 1 - labels.indexOf(choice)];
		if (!turn) {
			deps.notify("Split cancelled.", "info");
			return;
		}

		const launchArgs = ["launch", "--agent", first, ...(parsed.role ? ["--role", parsed.role] : []), "--source-kind", "pi", "--session", deps.sessionFile, "--cut", turn.cutId];
		if (piFormat) launchArgs.push("--branched", deps.branch(deps.sessionFile, turn.cutId));
		if (parsed.name) launchArgs.push("--name", parsed.name);
		if (parsed.prompt) launchArgs.push("--prompt", parsed.prompt);
		const { pane, agent } = await deps.launch(launchArgs);
		deps.notify(`Split opened in pane ${pane} with ${agent ?? resolved.agent?.name ?? parsed.role ?? first}.`, "info");
	} catch (error) {
		deps.notify(`/split failed: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}
