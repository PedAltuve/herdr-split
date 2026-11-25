# herdr-split

`/split <agent>` branches your current agent conversation at a message you choose and continues it in a new [Herdr](https://herdr.dev) pane, running the agent you ask for.

## Requirements

- Herdr (the `herdr` CLI, and run inside a Herdr pane)
- Node >= 23.6 (runs the TypeScript core directly)
- `fzf` (branch-point picker when the source is Claude Code)

## Install

```sh
./install.sh
```

Links `herdr-split` into `~/.local/bin`, adds the `/split` extension to your Pi homes (`~/.gentle-shell/agent`, `~/.pi/agent`, `$PI_CODING_AGENT_DIR`) and the command to `~/.claude/commands/split.md`. It never overwrites files it did not create (`skip <path>: exists`). Make sure `~/.local/bin` is on `PATH`.

## Usage

```
/split claude
/split gentle     # gentle-shell
/split pi
/split codex
/split judge                      # a role: adversarial review of the PR (gentle + judgment-day)
/split gentle judge               # an agent plus a role
/split gentle --name reviewer     # name the split
```

- From **Pi / gentle-shell**: a native picker asks for the branch point.
- From **Claude Code**: the new pane opens an `fzf` picker for the branch point.
- Without arguments, Pi asks for an agent or role and Claude Code replies with the usage. Both list the agents from `herdr-split agents` and the roles from `herdr-split roles`, including your `agents.json` and `roles.json` ones.

## Names

`--name <name>` (`^[a-z][a-z0-9_-]{0,31}$`; anything else exits 2 before any pane is touched) labels the new pane with `herdr pane rename`, names the agent with `herdr agent rename` once it is ready (best effort: a failure is logged in the notify log and the notice is still submitted), and the notice tells the agent its name. Without a name nothing is renamed.

## Roles

A role is a name plus an instruction for the agent that gets the split, and optionally an agent.

- `/split <role>` uses the role's agent; a role without an agent splits into the same agent as the source conversation (the agent Herdr detects in the source pane, e.g. `gentle-shell` → `gentle`; otherwise `pi`/`claude`).
- `/split <agent> <role>` uses that agent with the role's instruction.
- The split is named after the role unless `--name` is given.
- Built-in: `judge` → agent `gentle`, asks to run the `judgment-day` skill for an adversarial review of the pull request discussed in the conversation.
- Add or override roles in `~/.config/herdr-split/roles.json` (or under `$XDG_CONFIG_HOME`):

```json
{
  "critic": { "prompt": "Critique the plan discussed so far and list its weakest assumptions." },
  "judge": { "agent": "claude", "prompt": "Review the pull request discussed in this conversation." }
}
```

`agent` is optional; `prompt` is required. A role named like an agent is a configuration error (exit 2) that names it.

## What happens

```
/split <agent>
   │  pick the turn to branch at
   ▼
herdr-split ──► split the calling pane (right or down)
   │            start <agent> with the branched conversation
   ▼
poll `herdr agent get` until the agent is idle
   │
   ▼
herdr pane run  ──►  split notice (typed + Enter; `agent prompt`
                   only accepts agents started by `herdr agent start`)
```

## Source → target

| Source | Target | How the branch is passed |
| --- | --- | --- |
| Pi | Pi / gentle-shell | native branched session (`--session`) |
| Claude | Claude | native truncated copy (`--resume`) |
| any | any other | markdown transcript in `$TMPDIR/herdr-split`, referenced by the notice |

## The split notice

Once the target is ready it receives a message saying the conversation is a split of another one still in progress. It tells the agent to:

1. not act on any earlier message;
2. expect that the original conversation keeps changing files in the working tree;
3. acknowledge and wait for your instructions, or, with a role, carry out the role's instruction instead.

With `--name` it also states the split's name.

If it did not arrive, check `$TMPDIR/herdr-split/*-notify.log`.

## Layout

Dwindle, like Hyprland/bspwm: the calling pane is split **right** when its width > 2× height (cells are about twice as tall as wide), otherwise **down**.

- `--ratio <0..1>` size of the split (default `0.5`)
- `--no-focus` keep focus on the original pane

## Adding agents

Create `~/.config/herdr-split/agents.json` (or under `$XDG_CONFIG_HOME`):

```json
{
  "aider": { "exec": "aider", "format": null },
  "my-pi": { "exec": "my-pi --some-flag", "format": "pi" }
}
```

`exec` starts the agent; `format` is the session format it resumes natively (`"pi"`, `"claude"`) or `null` to get a transcript.

## CLI reference

```
herdr-split launch (--agent <name> | --role <name>) --source-kind pi|claude --session <file> --cut <id>
                   [--branched <file>] [--name <name>] [--source-agent <name>]
                   [--ratio 0.5] [--no-focus]
herdr-split split  (--agent <name> | --role <name>) --source-kind pi|claude (--session <file> | --session-id <id>)
                   [--name <name>] [--source-agent <name>] [--ratio 0.5] [--no-focus]
herdr-split agents
herdr-split roles
herdr-split help [--json | --slash]
```

- `launch`: Split at a branch point the adapter already chose (Pi).
- `split`: Split and pick the branch point with fzf in the new pane (Claude Code).
- `agents`: List the known agents and the command each one runs.
- `roles`: List the known roles, the agent each uses and its prompt.
- `help`: Show this help, as JSON, or as the /split usage line.

`--agent` is required unless `--role` is given; it may name an agent or a role. `--role` adds a role to an agent (alone, it uses the role's agent); `--name` names the split. `--name` and `--role` can each be given once. A malformed `agents.json` or `roles.json` exits 2 with `Cannot read <path>: <reason>`.

`herdr-split help` (or `--help`, `-h`) lists every option and the known agents and roles, including those from `agents.json` and `roles.json`. `herdr-split help --json` gives the same as JSON, so an agent can learn the tool by running it. This section is checked against that help by `core/help.test.ts`.

## Uninstall

```sh
./install.sh --uninstall
```

Removes only the links and stubs it created.
