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
/split gentle run a judge on PR X           # a prompt: the new agent acts on it now
/split gentle judge only review PR 4        # agent + role + prompt
```

- From **Pi / gentle-shell**: a native picker asks for the branch point.
- From **Claude Code**: the new pane opens an `fzf` picker for the branch point.
- Text after the agent (and optional role and `--name`) is a [prompt](#prompt) for the new agent.
- Without arguments, Pi asks for an agent or role and Claude Code replies with the usage. Both list the agents from `herdr-split agents` and the roles from `herdr-split roles`, including your `agents.json`, `roles.json` and [role files](#role-files).

## Prompt

`/split <agent|role> [<role>] [--name <name>] [<prompt>]`: everything after the agent (and the optional role and `--name`) is a prompt for the new agent.

- The first word is an agent or a role. The second word is a role only when it names a known role (`/split gentle judge ...`); otherwise it starts the prompt (`/split gentle run a judge on PR X`).
- `--name <name>` is read only before the prompt; from the first prompt word on, everything (including `--name`) is literal prompt text. Any other word starting with `-` (for example `/split gentle --security`) starts the prompt too. Control characters (Ctrl-U, ESC, …) are removed from the prompt.
- The prompt is collapsed to one line (whitespace runs become one space) and may be at most 4000 characters; a longer one exits 2 before any pane is touched.
- The split notice then ends with the prompt as the instruction to act on now instead of "confirm and wait". With a role, the role's instruction comes first and the prompt follows as additional instruction. The rule not to act on earlier messages and the warning about the original conversation changing files stay.
- On the CLI it is `--prompt <text>` (`launch`, `split`; `split` hands it to `pick` in the new pane through an owner-only `--prompt-file`, never in the typed command). Pi passes it with `execFile`, so no shell sees it.
- Claude Code: the command file runs one fixed Bash command with no user text, `herdr-split split ... --args-from-transcript`, and the core reads the `<command-args>` of the last user entry in the session transcript, which must be exactly the `/split` invocation (an older `/split`, or markup with text after it, is refused), and parses them with the same parser. Empty or invalid arguments print the `/split` usage and exit 2 without touching a pane.

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

### Role files

A longer role fits better in a Markdown file, one per role, named `<name>.md`:

- Personal: `~/.config/herdr-split/roles/<name>.md` (or under `$XDG_CONFIG_HOME`), next to `roles.json`.
- Project: `<git root>/.herdr-split/roles/<name>.md`, where the git root is the nearest directory with a `.git` above the directory `/split` runs in (the source conversation's). Outside a git repository there are no project roles.

```md
---
agent: claude
---
Critique the plan discussed so far.

- List its weakest assumptions, one finding per line, each one usable on its own.
```

- The whole body after the optional front-matter is the role's instruction (collapsed to one line in the notice, like a prompt, and in `herdr-split roles`). The front-matter takes only `agent`; without it the role splits into the source agent.
- Order: a personal role file overrides `roles.json`, which overrides the built-ins.
- A project role only adds a new name: a project file named like a personal, `roles.json` or built-in role is ignored with a warning and your role wins, so a cloned repository cannot redefine `judge`.
- A role file that cannot be used (empty body, bad file name, a name like an agent, unknown agent, malformed front-matter) does not stop other splits: it is ignored with `herdr-split: ignoring <file>: <reason>` on stderr and listed by `herdr-split roles`. Asking for it (`/split <name>`) exits 2 with that reason before any pane is touched.
- The split notice names the file a role came from, and Pi's `/split` completions show it next to each role. In Pi, ignored role files are reported when `/split` runs and in the command description.
- Only regular files of at most 64 KiB are read. A project role file that is a symlink is ignored, and when `.herdr-split` or `.herdr-split/roles` is itself a symlink no project roles are read (listed by `herdr-split roles` as `*` with the reason), so a cloned repository cannot point a role at a device or a file outside it; a personal role file may be a symlink to a regular file. Directories, devices and FIFOs are never opened. Ignored files are reported like any invalid role file.
- Control characters (C0/C1, except newline and tab in the body) are removed from role prompts, and from every file name, path and reason printed, so a role file cannot put terminal escape sequences on your screen.
- An invalid personal role file hides the `roles.json` or built-in role of the same name: `/split <name>` exits 2 with the file's reason and `herdr-split roles` shows only the ignored line. An invalid project file never changes an existing role.

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
3. acknowledge and wait for your instructions, or, with a role, carry out the role's instruction instead; with a prompt, act on the prompt now (after the role's instruction when there is one).

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
                   [--branched <file>] [--name <name>] [--prompt <text>] [--source-agent <name>]
                   [--ratio 0.5] [--no-focus]
herdr-split split  (--agent <name> | --role <name> | --args-from-transcript) --source-kind pi|claude
                   (--session <file> | --session-id <id>) [--name <name>] [--prompt <text>]
                   [--source-agent <name>] [--ratio 0.5] [--no-focus]
herdr-split agents
herdr-split roles
herdr-split help [--json | --slash]
```

- `launch`: Split at a branch point the adapter already chose (Pi).
- `split`: Split and pick the branch point with fzf in the new pane (Claude Code).
- `agents`: List the known agents and the command each one runs.
- `roles`: List the known roles (name, agent, prompt, source), then the ignored role files and why.
- `help`: Show this help, as JSON, or as the /split usage line.

`--agent` is required unless `--role` is given; it may name an agent or a role. `--role` adds a role to an agent (alone, it uses the role's agent); `--name` names the split; `--prompt` sends the new agent an instruction (see [Prompt](#prompt)); `--args-from-transcript` (Claude Code, replaces `--agent`) reads all of these from the last `/split` in the transcript and cannot be combined with them. `--name` and `--role` can each be given once. A malformed `agents.json` or `roles.json` exits 2 with `Cannot read <path>: <reason>`.

`herdr-split help` (or `--help`, `-h`) lists every option and the known agents and roles, including those from `agents.json` and `roles.json`. `herdr-split help --json` gives the same as JSON, so an agent can learn the tool by running it. This section is checked against that help by `core/help.test.ts`.

## Uninstall

```sh
./install.sh --uninstall
```

Removes only the links and stubs it created.
