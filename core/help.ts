/**
 * The single source of herdr-split's documentation: `help`, `--help`, `help --json`, the
 * usage error and the adapters' `/split` usage come from this table. Drift tests keep the CLI
 * parser and the README in line with it.
 */
import type { Role } from "./roles.ts";
import type { Agent } from "./split.ts";

interface OptionDoc {
	value?: string;
	description: string;
	default?: string;
	short?: string;
}

const OPTION_DOCS: Record<string, OptionDoc> = {
	agent: { value: "<name>", description: "Agent to start in the new pane (see `herdr-split agents`), or a role (see `herdr-split roles`). Required unless --role is given." },
	role: { value: "<name>", description: "Role for the new split: its prompt tells the agent what to do. Without an agent, the role's agent (else the source agent) is used." },
	name: { value: "<name>", description: "Name of the split: labels the pane and the agent, and the notice tells the agent. Must match ^[a-z][a-z0-9_-]{0,31}$." },
	prompt: { value: "<text>", description: "Instruction for the new agent to act on now, sent with the split notice. One line (whitespace collapsed), at most 4000 characters." },
	"prompt-file": { value: "<file>", description: "Internal: read the prompt from this file and delete it (how split hands the prompt to pick without typing it into a shell)." },
	"args-from-transcript": { description: "Read the /split arguments (agent, role, --name, prompt) from the last /split in the Claude Code transcript instead of --agent/--role/--name/--prompt; invalid or empty arguments print the /split usage and exit 2." },
	"source-kind": { value: "pi|claude", description: "Session format of the conversation being split." },
	session: { value: "<file>", description: "Session file of the conversation being split." },
	"session-id": { value: "<id>", description: "Claude Code session id; its file is found under ~/.claude/projects." },
	cut: { value: "<id>", description: "Entry id of the last turn the branch keeps." },
	branched: { value: "<file>", description: "Pi session already branched at --cut, resumed natively." },
	"source-agent": { value: "<name>", description: "Agent named in the split notice; Herdr detects it when omitted." },
	ratio: { value: "<0..1>", description: "Size of the new pane as a fraction of the calling pane.", default: "0.5" },
	"no-focus": { description: "Keep focus on the original pane." },
	json: { description: "Print the help as JSON for agents and scripts." },
	slash: { description: "Print only the /split usage line with the known agents." },
	help: { short: "-h", description: "Show this help (also after any command)." },
	"source-pane": { value: "<pane>", description: "Pane the conversation is split from." },
	pane: { value: "<pane>", description: "Pane that receives the notice." },
	"notice-file": { value: "<file>", description: "File holding the split notice." },
	timeout: { value: "<ms>", description: "How long to wait for the agent to be ready.", default: "120000" },
};

export interface CommandDoc {
	name: string;
	synopsis: string[];
	summary: string;
	options: { name: string; required?: boolean }[];
	/** Runs inside the new pane; not part of the documented interface. */
	internal?: boolean;
}

const SPLIT_OPTIONS = [{ name: "role" }, { name: "name" }, { name: "prompt" }, { name: "source-agent" }, { name: "ratio" }, { name: "no-focus" }];

export const COMMANDS: CommandDoc[] = [
	{
		name: "launch",
		synopsis: [
			"herdr-split launch (--agent <name> | --role <name>) --source-kind pi|claude --session <file> --cut <id>",
			"                   [--branched <file>] [--name <name>] [--prompt <text>] [--source-agent <name>]",
			"                   [--ratio 0.5] [--no-focus]",
		],
		summary: "Split at a branch point the adapter already chose (Pi).",
		options: [
			{ name: "agent" },
			{ name: "source-kind", required: true },
			{ name: "session", required: true },
			{ name: "cut", required: true },
			{ name: "branched" },
			...SPLIT_OPTIONS,
		],
	},
	{
		name: "split",
		synopsis: [
			"herdr-split split  (--agent <name> | --role <name> | --args-from-transcript) --source-kind pi|claude",
			"                   (--session <file> | --session-id <id>) [--name <name>] [--prompt <text>]",
			"                   [--source-agent <name>] [--ratio 0.5] [--no-focus]",
		],
		summary: "Split and pick the branch point with fzf in the new pane (Claude Code).",
		options: [{ name: "agent" }, { name: "source-kind", required: true }, { name: "session" }, { name: "session-id" }, { name: "args-from-transcript" }, ...SPLIT_OPTIONS],
	},
	{ name: "agents", synopsis: ["herdr-split agents"], summary: "List the known agents and the command each one runs.", options: [] },
	{ name: "roles", synopsis: ["herdr-split roles"], summary: "List the known roles, the agent each uses and its prompt.", options: [] },
	{
		name: "help",
		synopsis: ["herdr-split help [--json | --slash]"],
		summary: "Show this help, as JSON, or as the /split usage line.",
		options: [{ name: "json" }, { name: "slash" }, { name: "help" }],
	},
	{ name: "pick", synopsis: [], summary: "Choose the branch point with fzf, then start the agent.", options: [{ name: "source-pane" }, { name: "role" }, { name: "name" }, { name: "prompt" }, { name: "prompt-file" }], internal: true },
	{ name: "notify", synopsis: [], summary: "Submit the split notice once the agent is ready.", options: [{ name: "pane" }, { name: "notice-file" }, { name: "timeout" }, { name: "name" }], internal: true },
];

const PUBLIC = COMMANDS.filter((c) => !c.internal);

export function optionDoc(name: string): OptionDoc {
	const doc = OPTION_DOCS[name];
	if (!doc) throw new Error(`undocumented option --${name}`);
	return doc;
}

/** The synopsis lines of the public commands, as in the README CLI reference. */
export function synopsis(): string[] {
	return PUBLIC.flatMap((c) => c.synopsis);
}

/** One-line usage, used by the usage error. */
export function usageLine(): string {
	return `Usage: herdr-split <${PUBLIC.map((c) => c.name).join("|")}> [options]`;
}

/** How to call /split from an agent, with the agents that can be split into. */
export function slashUsage(agents: Agent[], roles: Role[]): string {
	const agentList = agents.map((a) => a.name).join("|");
	const roleList = roles.map((r) => r.name).join("|");
	return `/split <${[agentList, roleList].filter(Boolean).join("|")}> [<role>] [--name <name>] [<prompt>] (agents: ${agentList}; roles: ${roleList})`;
}

function flag(name: string): string {
	const doc = OPTION_DOCS[name]!;
	return `${doc.short ? `${doc.short}, ` : ""}--${name}${doc.value ? ` ${doc.value}` : ""}`;
}

export function helpText(agents: Agent[], roles: Role[]): string {
	const width = Math.max(...PUBLIC.map((c) => c.name.length)) + 2;
	const used = new Set(PUBLIC.flatMap((c) => c.options.map((o) => o.name)));
	const names = Object.keys(OPTION_DOCS).filter((n) => used.has(n));
	const flagWidth = Math.max(...names.map((n) => flag(n).length)) + 2;
	return [
		"herdr-split: branch an agent conversation into a new Herdr pane.",
		"",
		"Usage:",
		...synopsis().map((l) => `  ${l}`),
		"",
		"Commands:",
		...PUBLIC.map((c) => `  ${c.name.padEnd(width)}${c.summary}`),
		"",
		"Options:",
		...names.map((n) => {
			const doc = OPTION_DOCS[n]!;
			return `  ${flag(n).padEnd(flagWidth)}${doc.description}${doc.default ? ` Default: ${doc.default}.` : ""}`;
		}),
		"",
		`Agents: ${agents.map((a) => a.name).join(", ")}`,
		`Roles: ${roles.map((r) => r.name).join(", ")}`,
		`From an agent: ${slashUsage(agents, roles)}`,
		"",
	].join("\n");
}

export function helpJson(agents: Agent[], roles: Role[]) {
	return {
		name: "herdr-split",
		description: "Branch an agent conversation at a chosen message into a new Herdr pane running another agent.",
		slashCommand: slashUsage(agents, roles),
		commands: PUBLIC.map((c) => ({
			name: c.name,
			synopsis: c.synopsis.map((l) => l.trim()).join(" ").replace(/\s+/g, " "),
			summary: c.summary,
			options: c.options.map((o) => {
				const doc = OPTION_DOCS[o.name]!;
				return { flag: `--${o.name}`, value: doc.value, description: doc.description, default: doc.default, required: o.required ?? false };
			}),
		})),
		agents: agents.map((a) => ({ name: a.name, exec: a.exec, format: a.format })),
		roles: roles.map((r) => ({ name: r.name, agent: r.agent, prompt: r.prompt })),
	};
}
