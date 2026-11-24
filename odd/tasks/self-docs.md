# herdr-split self-documentation

herdr-split documents itself from one table in `core`: help text, usage errors, machine-readable help, adapter hints and README stay in sync, guarded by drift tests.
Repo: `~/herdr-split`, branch `feat/self-docs` (from `origin/main` 33131de).

## Specs

- S1. "Una sola fuente en `core` con una tabla de comandos, opciones y descripciones. De ahí salen `herdr-split help`, `--help` y los errores de uso." — `herdr-split help` and `herdr-split --help` print the usage generated from that table (stdout, exit 0); the unknown-command error is generated from the same table (stderr, exit 2).
- S2. "`/split` sin argumento, en cualquier adaptador, muestra los agentes que devuelve `herdr-split agents`, incluidos los de `agents.json`." — the Claude command and the Pi command list the agents of `herdr-split agents` (built-ins plus `agents.json`) instead of a fixed `<claude|gentle|pi|codex>`; Pi completions include `agents.json` agents.
- S3. "`herdr-split help --json`, para que cualquier agente pueda leer qué sabe hacer la herramienta sin que se lo expliquemos en un prompt." — JSON with the commands, their options and the known agents.
- S4. "Un test de drift que falla si el README o los adaptadores no coinciden con la tabla. Así la documentación no se desactualiza sin que nadie se entere." — tests fail when the CLI parser options, the README CLI reference or the adapters disagree with the table.

## Tasks

- T1 [S1, S3, S4] core help table, `help`/`--help`/`help --json`, generated usage error, parser and README drift tests — inline — commit: pending
- T2 [S2, S4] adapters: Claude `/split` without a valid name relays `herdr-split help --slash`; Pi description and completions from the agent list; adapter drift test — inline — Risk: item 2 (Claude command allowed-tools) — commit: pending

## Log

- L1. User request (verbatim): "Bien, hice el merge a main, otra cosa que me gustaria explorar es self-documentation para esto. Que sugieres? podemos aplicarlo a todos los agentes?"
- L2. User choice (verbatim): "Si, justamente a eso. Me parece bien A" — accepts proposal A items 1-4 (quoted in S1-S4); B (notice line) and Codex as a source are out of scope.
