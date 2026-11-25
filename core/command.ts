/**
 * The one parser for `/split` arguments, shared by every adapter:
 * `<agent|role> [<role>] [--name <name>] [<prompt...>]`.
 */
import type { Role } from "./roles.ts";
import { UsageError, type Agent } from "./split.ts";

export const PROMPT_LIMIT = 4000;

export interface SplitCommand {
	/** First word: an agent or a role; the caller resolves it. */
	agent?: string;
	role?: string;
	name?: string;
	/** One line, at most PROMPT_LIMIT characters. */
	prompt?: string;
}

/**
 * Remove C0 control characters (and DEL) other than whitespace, collapse whitespace runs to one space;
 * blank means no prompt. Over the limit is a UsageError.
 */
export function normalizePrompt(text: string | undefined): string | undefined {
	const prompt = (text ?? "").replace(/[\x00-\x08\x0e-\x1f\x7f]/g, "").replace(/\s+/g, " ").trim();
	if (!prompt) return undefined;
	if (prompt.length > PROMPT_LIMIT) throw new UsageError(`The prompt is ${prompt.length} characters long; the limit is ${PROMPT_LIMIT}`);
	return prompt;
}

/**
 * The first word is an agent or a role. After an agent, the next word is a role only when it names a
 * known role; otherwise it starts the prompt. `--name <name>` (or `--name=<name>`) is the only option
 * and is read only before the prompt starts; any other word starting with `-` starts the prompt, and
 * from the first prompt word on, everything is literal prompt text.
 */
export function parseSplitCommand(text: string, agents: Agent[], roles: Role[]): SplitCommand {
	const tokens = text.split(/\s+/).filter(Boolean);
	const out: SplitCommand = {};
	let at = 0;
	let decided = false;
	for (; at < tokens.length; at++) {
		const t = tokens[at]!;
		if (t === "--name" || t.startsWith("--name=")) {
			const value = t === "--name" ? tokens[++at] : t.slice("--name=".length);
			if (!value) throw new UsageError("--name needs a value");
			if (out.name !== undefined) throw new UsageError("--name can be given only once");
			out.name = value;
		} else if (t.startsWith("-")) break;
		else if (out.agent === undefined) out.agent = t;
		else if (!decided && agents.some((a) => a.name === out.agent) && roles.some((r) => r.name === t)) {
			out.role = t;
			decided = true;
		} else break;
	}
	const prompt = normalizePrompt(tokens.slice(at).join(" "));
	if (prompt !== undefined) out.prompt = prompt;
	return out;
}
