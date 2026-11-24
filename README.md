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
```

- From **Pi / gentle-shell**: a native picker asks for the branch point.
- From **Claude Code**: the new pane opens an `fzf` picker for the branch point.

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
3. acknowledge and wait for your instructions.

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
herdr-split launch --agent <name> --source-kind pi|claude --session <file> --cut <id>
                   [--branched <file>] [--source-agent <name>] [--ratio 0.5] [--no-focus]
herdr-split split  --agent <name> --source-kind pi|claude (--session <file> | --session-id <id>)
                   [--source-agent <name>] [--ratio 0.5] [--no-focus]
herdr-split agents
herdr-split help [--json | --slash]
```

- `launch`: Split at a branch point the adapter already chose (Pi).
- `split`: Split and pick the branch point with fzf in the new pane (Claude Code).
- `agents`: List the known agents and the command each one runs.
- `help`: Show this help, as JSON, or as the /split usage line.

`herdr-split help` (or `--help`, `-h`) lists every option and the known agents, including those from `agents.json`. `herdr-split help --json` gives the same as JSON, so an agent can learn the tool by running it. This section is checked against that help by `core/help.test.ts`.

## Uninstall

```sh
./install.sh --uninstall
```

Removes only the links and stubs it created.
