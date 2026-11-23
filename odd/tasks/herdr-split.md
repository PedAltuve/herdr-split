# herdr-split

`/split <agent>` branches the current agent conversation at a chosen message and continues it in a new Herdr pane.
Shared Node core CLI plus thin adapters for Pi (gentle-shell, pi) and Claude Code. Repo: `~/herdr-split`, branch `feat/split`.

## Specs

- S1. "un command /split que me permita branchear de la conversacion actual y seleccionar desde que mensaje hacer el branch" — the user picks the branch point from a list of turns of the current conversation; the branch keeps everything up to the end of the picked turn.
- S2. "abre un nuevo pane en mi workspace de Herdr que inicia el agente dependiendo del que yo pida. Por ejemplo, /split claude o /split gentle (gentle-shell)" — the argument names the target agent (`claude` → `claude`, `gentle` → `gentle-shell`, `pi` → `pi`, `codex` → `codex`); an unknown name is rejected with the list of known agents.
- S3. "inyecta un mensaje al final de la conversacion explicando al agente que esta conversacion es un split de otra conversacion en proceso" — after the target agent is ready, a split notice is submitted to it through the Herdr CLI.
- S4. "Deberia evitar tambien actuar en cualquier mensaje anterior y estar consciente de que en esa conversacion probablemente se esten haciendo cambios" — the notice tells the agent not to act on earlier messages, that the original conversation is probably still changing the working tree, and to acknowledge and wait.
- S5. "Debe ser para herdr, no solo para gentle-shell" / chosen option "Ambos: núcleo + /split en cada agente" — a shared CLI core does the split via Herdr; `/split` exists in Pi and in Claude Code.
- S6. "Tienes que usar herdr cli, es lo que quiero usar para comunicar entre agentes" — pane creation, agent startup detection and the notice go through the `herdr` CLI.
- S7. "Primero derecha, luego abajo, puede ser siguiendo el golden ratio creo? Cual es la forma por defecto de hacer esto en tiling window managers?" — dwindle layout: split the calling pane right when it is wider than tall (in cells, width > 2×height approximates square), else down; ratio 0.5, configurable.
- S8. "Todas: Pi↔Pi, Claude↔Claude, cruzadas" — Pi→Pi resumes a native branched Pi session; Claude→Claude resumes a native truncated Claude session; cross-agent targets get a markdown transcript file referenced by the notice.

## Tasks

- T1 [S1, S8] core session readers (Pi, Claude) → turns; Claude truncated copy; transcript renderer — inline — commit: f275006 (done, 8 tests)
- T2 [S2, S3, S4, S6, S7] core CLI: agent registry, dwindle split, launch, readiness polling, notice, `--pick` fzf flow — inline — commit: T2COMMIT
- T3 [S1, S5] Pi extension `/split` (native select + createBranchedSession) — inline — commit: pending
- T4 [S5] Claude Code `/split` command, install script, README — inline — commit: pending

## Log

- L1. User request (verbatim): "Quiero hacer una extension con un command /split que me permita branchear de la conversacion actual y seleccionar desde que mensaje hacer el branch. Luego, abre un nuevo pane en mi workspace de Herdr que inicia el agente dependiendo del que yo pida. Por ejemplo, /split claude o /split gentle (gentle-shell). Luego, inyecta un mensaje al final de la conversacion explicando al agente que esta conversacion es un split de otra conversacion en proceso. Deberia evitar tambien actuar en cualquier mensaje anterior y estar consciente de que en esa conversacion probablemente se esten haciendo cambios"
- L2. Answers: location "Debe ser para herdr, no solo para gentle-shell"; Claude context "Tienes que usar herdr cli, es lo que quiero usar para comunicar entre agentes"; pane "Primero derecha, luego abajo, puede ser siguiendo el golden ratio creo? Cual es la forma por defecto de hacer esto en tiling window managers?"
- L3. Choices: "Ambos: núcleo + /split en cada agente"; location "Repo nuevo ~/herdr-split"; scope "Todas: Pi↔Pi, Claude↔Claude, cruzadas".
- L4. Evidence: `herdr agent wait` returns `agent_not_running` before Herdr detects the agent; readiness needs polling `herdr agent get` until `agent_status` is idle. Herdr detects gentle-shell as agent `gentle-shell`. Claude Code exposes `${CLAUDE_SESSION_ID}` in commands and `CLAUDE_CODE_SESSION_ID` in Bash.
