/** Pure logic of Pi's /split: pick agent and turn, optionally branch natively, delegate to the core CLI. */
import { readSession } from "../core/sessions.ts";
import { slashUsage } from "../core/help.ts";
import { checkName, listRoles, resolveTarget, type Role } from "../core/roles.ts";
import { listAgents, type Agent } from "../core/split.ts";

/**
 * Agents and roles for hints only: an unreadable or malformed config falls back to the built-ins
 * so /split still registers; `problem` says why (running /split reports the error too).
 */
function hints(configFile: string | undefined, rolesFile: string | undefined): { agents: Agent[]; roles: Role[]; problem?: string } {
	const problems: string[] = [];
	let agents: Agent[];
	try {
		agents = listAgents(configFile);
	} catch (error) {
		agents = listAgents();
		problems.push(`ignoring ${configFile}: ${error instanceof Error ? error.message : String(error)}`);
	}
	let roles: Role[];
	try {
		roles = listRoles(rolesFile, agents);
	} catch (error) {
		roles = listRoles(undefined, agents);
		problems.push(`ignoring ${rolesFile}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return { agents, roles, problem: problems.length ? problems.join("; ") : undefined };
}

/** What Pi registers for /split: description and completions both list the configured agents and roles. */
export function splitCommandInfo(configFile: string | undefined, rolesFile?: string) {
	const { agents, roles, problem } = hints(configFile, rolesFile);
	return {
		description: `Branch this conversation into another agent in a new Herdr pane: ${slashUsage(agents, roles)}${problem ? ` (${problem})` : ""}`,
		getArgumentCompletions: (prefix: string) => agentCompletions(prefix, configFile, rolesFile),
	};
}

/** First word: agents and roles; second word (after an agent): roles. */
export function agentCompletions(prefix: string, configFile?: string, rolesFile?: string): { value: string; label: string }[] | null {
	const { agents, roles } = hints(configFile, rolesFile);
	const words = prefix.split(/\s+/);
	const last = words.pop()!;
	const before = words.filter(Boolean);
	let names: string[];
	if (before.length === 0) names = [...agents.map((a) => a.name), ...roles.map((r) => r.name)];
	else if (before.length === 1 && agents.some((a) => a.name === before[0])) names = roles.map((r) => r.name);
	else return null;
	const items = names.filter((n) => n.startsWith(last)).map((n) => ({ value: [...before, n].join(" "), label: n }));
	return items.length ? items : null;
}

const USAGE = "Usage: /split <agent> [<role>] [--name <name>] (at most two words)";

/** `<word> [<word>] [--name <name>]`; the core CLI validates what the words mean. */
export function parseSplitArgs(args: string): { words: string[]; name?: string; error?: string } {
	const words: string[] = [];
	let name: string | undefined;
	const tokens = args.split(/\s+/).filter(Boolean);
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i]!;
		if (t === "--name" || t.startsWith("--name=")) {
			const value = t === "--name" ? tokens[++i] : t.slice("--name=".length);
			if (!value) return { words, error: "--name needs a value" };
			name = value;
		} else if (t.startsWith("--")) return { words, error: `Unknown option "${t.split("=")[0]}"` };
		else words.push(t);
	}
	const result = name === undefined ? { words } : { words, name };
	return words.length > 2 ? { ...result, error: USAGE } : result;
}

export interface SplitDeps {
	env: Record<string, string | undefined>;
	sessionFile: string;
	leafId: string | undefined;
	configFile: string | undefined;
	rolesFile?: string;
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
		const parsed = parseSplitArgs(args);
		if (parsed.error) {
			deps.notify(parsed.error, "error");
			return;
		}
		let words = parsed.words;
		if (!words.length) {
			const agents = listAgents(deps.configFile);
			const picked = await deps.select("Split into which agent or role?", [...agents.map((a) => a.name), ...listRoles(deps.rolesFile, agents).map((r) => r.name)]);
			if (!picked) {
				deps.notify("Split cancelled.", "info");
				return;
			}
			words = [picked];
		}
		let resolved;
		try {
			checkName(parsed.name);
			resolved = resolveTarget({ agent: words[0], role: words[1] }, deps.configFile, deps.rolesFile);
		} catch (error) {
			deps.notify(error instanceof Error ? error.message : String(error), "error");
			return;
		}
		// A role without an agent splits into the source agent, which in Pi is a Pi-format agent.
		const piFormat = (resolved.agent?.format ?? "pi") === "pi";

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

		const launchArgs = ["launch", "--agent", words[0]!, ...(words[1] ? ["--role", words[1]] : []), "--source-kind", "pi", "--session", deps.sessionFile, "--cut", turn.cutId];
		if (piFormat) launchArgs.push("--branched", deps.branch(deps.sessionFile, turn.cutId));
		if (parsed.name) launchArgs.push("--name", parsed.name);
		const { pane, agent } = await deps.launch(launchArgs);
		deps.notify(`Split opened in pane ${pane} with ${agent ?? resolved.agent?.name ?? words.at(-1)}.`, "info");
	} catch (error) {
		deps.notify(`/split failed: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}
