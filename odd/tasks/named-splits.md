# herdr-split named splits and roles (issue #5)

A split can be named, and a role names a split with an agent and an instruction (`/split judge`, `/split agy critic`).
Repo: `~/herdr-split`, branch `feat/named-splits` (from `origin/main` 8205ca7). Prompt after the agent (#4) is out of scope.

## Specs

- S1. "Es posible darle nombre a los agentes?" / chosen "/split gentle --name reviewer" — `/split <agent> --name <name>` names the split: the new pane is labelled with `herdr pane rename`, the agent with `herdr agent rename` once it is ready (best effort, a failure is logged and never stops the split), and the notice tells the agent its name. Names match `^[a-z][a-z0-9_-]{0,31}$`; an invalid name exits 2 before any pane operation. Without a name, behavior is unchanged (no rename).
- S2. "si con un nombre especifico podemos activar un prompt interno directamente? ... /split judge con lo que seleccione deberia inferir que quiero un adversarial judge del PR x (es una skill de gentle)" / chosen "judge incluido" — a role has an optional agent and a prompt. Built-in role `judge`: agent `gentle`, prompt asking to run the `judgment-day` skill (adversarial review) on the pull request discussed in the conversation. Roles from `~/.config/herdr-split/roles.json` (`{ "<role>": { "agent"?: "<agent>", "prompt": "<text>" } }`) add roles or override built-ins.
- S3. "si dijera /split agy critic, esto active una skill critic (si existiera)" — `/split <agent> <role>` uses that agent with the role's prompt; `/split <role>` uses the role's agent. The split is named after the role unless `--name` is given.
- S4. chosen "El mismo de origen" — a role without an agent, used without an explicit agent, splits into the same agent as the source conversation (the herdr-split agent whose `exec` matches the agent Herdr detects in the source pane, e.g. `gentle-shell` → `gentle`; else the source kind `pi`/`claude`).
- S5. chosen "Error de configuración" — a role named like an agent is a configuration error naming the clashing name (exit 2, no pane operation).
- S6. With a role, the notice ends with the role's instruction for the agent to act on, instead of "acknowledge and wait"; the rule not to act on earlier messages and the warning about the original conversation changing files stay.
- S7. Self-documentation stays in sync: `herdr-split help`, `help --json`, `help --slash`, the `/split` completions/picker (Pi) and usage (Claude Code), and the README list roles and `--name`; the drift tests cover them. In Claude Code no user text reaches a shell: each word is validated against the name regex and passed single-quoted.

## Tasks

- T1 [S1-S7] core (roles, name, resolution, notice, herdr renames, CLI options, help table), Pi and Claude adapters, README, tests — worker — Risk: item 2 (Claude command argument path) — commit: see below (done, 97 tests)

## Log

- L1. User request (verbatim, issues): "Es posible darle nombre a los agentes?" / "Que tanto podemos hacer si es posible nombrar a los agentes? quiero decir, si con un nombre especifico podemos activar un prompt interno directamente? No se si esto sea mas de una skill o un prompt, pero basicamente ya que compartimos parte del contexto poder decir /split judge con lo que seleccione deberia inferir que quiero un adversarial judge del PR x (es una skill de gentle), por ej si dijera /split agy critic, esto active una skill critic (si existiera)". Issues: #4 (prompt), #5 (names and roles).
- L2. User (verbatim): "Vamos con los nombres y roles primero". Choices: naming "/split gentle --name reviewer"; built-in roles "judge incluido"; role without agent "El mismo de origen"; conflicts "Error de configuración".
- L3. Design (agent-owned): roles live in a separate `roles.json` next to `agents.json` (agents.json is a flat agent map, so a `roles` key would clash with an agent named `roles`). The role prompt names the skill; the target agent loads it its own way. Pane rename right after the split; agent rename after readiness, in `notify`.
- L4. Worker T1 done: core/roles.ts (registry, roles.json, resolveTarget, checkName, source fallback), pane rename after split and agent rename after readiness (both best effort), notice with name/role, `--name`/`--role`/`roles`, Pi and Claude adapters, README. 97/97 tests (RED 28 failing before implementation). One slice of ~600 lines: the rules share the resolution path, so it was not split.
