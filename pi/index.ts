/** Pi extension: /split branches this conversation into another agent in a new Herdr pane. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentCompletions, runSplit } from "./split-command.ts";

const BIN = join(dirname(realpathSync(fileURLToPath(import.meta.url))), "..", "bin", "herdr-split");

function launchCli(args: string[], cwd: string): Promise<{ pane: string; command: string }> {
	return new Promise((resolve, reject) => {
		execFile(BIN, args, { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
			if (error) {
				reject(new Error(String(stderr || error.message).trim().replace(/^herdr-split: /, "")));
				return;
			}
			try {
				resolve(JSON.parse(stdout));
			} catch {
				reject(new Error(`unexpected output from herdr-split: ${String(stdout).trim()}`));
			}
		});
	});
}

export default function (pi: ExtensionAPI) {
	if (process.env.GENTLE_PI_AGENTS_CHILD === "1") return;

	pi.registerCommand("split", {
		description: "Branch this conversation into another agent in a new Herdr pane: /split <claude|gentle|pi|codex>",
		getArgumentCompletions: agentCompletions,
		handler: async (args, ctx) => {
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) {
				ctx.ui.notify("/split needs a saved session.", "error");
				return;
			}
			const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
			await runSplit(args, {
				env: process.env,
				sessionFile,
				leafId: ctx.sessionManager.getLeafId() ?? undefined,
				configFile: join(configHome, "herdr-split", "agents.json"),
				select: (title, options) => ctx.ui.select(title, options),
				notify: (msg, level) => ctx.ui.notify(msg, level),
				// A separate manager keeps the live session untouched.
				branch: (file, cutId) => {
					const branched = SessionManager.open(file).createBranchedSession(cutId);
					if (!branched) throw new Error("could not create the branched session");
					return branched;
				},
				launch: (launchArgs) => launchCli(launchArgs, ctx.cwd),
			});
		},
	});
}
