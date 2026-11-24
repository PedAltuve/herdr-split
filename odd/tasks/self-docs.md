# herdr-split self-documentation

herdr-split documents itself from one table in `core`: help text, usage errors, machine-readable help, adapter hints and README stay in sync, guarded by drift tests.
Repo: `~/herdr-split`, branch `feat/self-docs` (from `origin/main` 33131de).

## Specs

- S1. "Una sola fuente en `core` con una tabla de comandos, opciones y descripciones. De ahí salen `herdr-split help`, `--help` y los errores de uso." — `herdr-split help` and `herdr-split --help` print the usage generated from that table (stdout, exit 0); the unknown-command error is generated from the same table (stderr, exit 2).
- S2. "`/split` sin argumento, en cualquier adaptador, muestra los agentes que devuelve `herdr-split agents`, incluidos los de `agents.json`." — the Claude command and the Pi command list the agents of `herdr-split agents` (built-ins plus `agents.json`) instead of a fixed `<claude|gentle|pi|codex>`; Pi completions include `agents.json` agents.
- S3. "`herdr-split help --json`, para que cualquier agente pueda leer qué sabe hacer la herramienta sin que se lo expliquemos en un prompt." — JSON with the commands, their options and the known agents.
- S4. "Un test de drift que falla si el README o los adaptadores no coinciden con la tabla. Así la documentación no se desactualiza sin que nadie se entere." — tests fail when the CLI parser options, the README CLI reference or the adapters disagree with the table.

## Tasks

- T1 [S1, S3, S4] core help table, `help`/`--help`/`help --json`, generated usage error, parser and README drift tests — inline — commit: a0feb66 (done, 7 tests)
- T2 [S2, S4] adapters: Claude `/split` without a valid name relays `herdr-split help --slash`; Pi description and completions from the agent list; adapter drift test — inline — Risk: item 2 (Claude command allowed-tools) — commit: 08edda3 (done, 3 tests)
- T3 [S1, S2, S4] verify findings: reject help-only flags elsewhere, Pi wiring and defaults drift tests, broken agents.json at load — inline — commit: see Log L4

## Log

- L1. User request (verbatim): "Bien, hice el merge a main, otra cosa que me gustaria explorar es self-documentation para esto. Que sugieres? podemos aplicarlo a todos los agentes?"
- L2. User choice (verbatim): "Si, justamente a eso. Me parece bien A" — accepts proposal A items 1-4 (quoted in S1-S4); B (notice line) and Codex as a source are out of scope.
- L3. Native review (lenses risk, readability, reliability) approved a0feb66..08edda3, lineage review-75b4e4fa947cae6e, with 3 non-blocking warnings. Independent verify: S1, S3 met; S2 met; S4 not fully met; Risk item 2 static check passed (exact-match `Bash(herdr-split help --slash)`, no `$ARGUMENTS` in Bash). Blocking: (1) `--json`/`--slash` silently ignored outside `help` and `help --json --slash` dropped `--slash`; (2) Pi registration wiring was not tested (reverting the completions wiring kept tests green). Also fixed: drift test compared option names only; a malformed agents.json broke Pi registration at load time.
- L4. Fixes: `--json`/`--slash` outside help and combined exit 2 with a usage error; Pi registers `...splitCommandInfo(configFile)` (tested, plus a structural wiring test); parser drift compares value/type, defaults and short flags; hints fall back to the built-ins on a broken agents.json. 59/59 tests.
- L5. Native review of 8108cb0 (lineage review-3729c750b788c346) approved with 2 advisories: blanket catch in hintAgents hides why agents.json is ignored; Pi wiring test was textual. User (verbatim): "Vale, hazlas en un commit aparte y luego push y pr". Fixes: the Pi description names the ignored agents.json and the error; pi/index.test.ts loads the real extension with a fake ExtensionAPI (stubbed Pi package via module hooks) and checks description and completions; an override of `description` after the spread fails all 3. 61/61 tests.
