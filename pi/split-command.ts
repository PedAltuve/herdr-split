/** Pure logic of Pi's /split: pick agent and turn, optionally branch natively, delegate to the core CLI. */
import { readSession } from "../core/sessions.ts";
import { listAgents, resolveAgent } from "../core/split.ts";

export function agentCompletions(prefix: string): { value: string; label: string }[] | null {
	const items = listAgents()
		.filter((a) => a.name.startsWith(prefix))
		.map((a) => ({ value: a.name, label: a.name }));
	return items.length ? items : null;
}

export interface SplitDeps {
	env: Record<string, string | undefined>;
	sessionFile: string;
	leafId: string | undefined;
	configFile: string | undefined;
	select(title: string, options: string[]): Promise<string | undefined>;
	notify(msg: string, level: "info" | "error"): void;
	branch(sessionFile: string, cutId: string): string;
	launch(args: string[]): Promise<{ pane: string; command: string }>;
}

export async function runSplit(args: string, deps: SplitDeps): Promise<void> {
	try {
		if (deps.env.HERDR_ENV !== "1" || !deps.env.HERDR_PANE_ID) {
			deps.notify("/split needs Herdr: run Pi inside a Herdr pane.", "error");
			return;
		}
		let name = args.trim();
		if (!name) {
			const picked = await deps.select("Split into which agent?", listAgents(deps.configFile).map((a) => a.name));
			if (!picked) {
				deps.notify("Split cancelled.", "info");
				return;
			}
			name = picked;
		}
		let agent;
		try {
			agent = resolveAgent(name, deps.configFile);
		} catch (error) {
			deps.notify(error instanceof Error ? error.message : String(error), "error");
			return;
		}

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

		const launchArgs = ["launch", "--agent", agent.name, "--source-kind", "pi", "--session", deps.sessionFile, "--cut", turn.cutId];
		if (agent.format === "pi") launchArgs.push("--branched", deps.branch(deps.sessionFile, turn.cutId));
		const { pane } = await deps.launch(launchArgs);
		deps.notify(`Split opened in pane ${pane} with ${agent.name}.`, "info");
	} catch (error) {
		deps.notify(`/split failed: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}
