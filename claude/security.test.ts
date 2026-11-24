import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const doc = readFileSync(new URL("./split.md", import.meta.url), "utf8");

test("slash-command arguments never reach a shell injection", () => {
	// Claude Code substitutes $ARGUMENTS textually, so any `!` command containing it is injectable.
	for (const m of doc.matchAll(/!`([^`]*)`/g)) assert.doesNotMatch(m[1]!, /\$ARGUMENTS|\$\d|\$\{?ARGUMENTS/);
});

test("the agent name is validated before Bash runs and passed single-quoted", () => {
	assert.match(doc, /\^\[a-z\]\[a-z0-9_-\]\{0,31\}\$/);
	assert.match(doc, /herdr-split split --source-kind claude --session-id "\$\{CLAUDE_SESSION_ID\}" --source-agent claude --agent '<name>'/);
	assert.match(doc, /^allowed-tools: Bash\(herdr-split split:\*\), Bash\(herdr-split help --slash\)$/m);
});

test("without a valid agent name the command relays the generated usage instead of a fixed list", () => {
	assert.match(doc, /^argument-hint: <agent>$/m);
	assert.match(doc, /run this single Bash command: `herdr-split help --slash`/);
	assert.doesNotMatch(doc, /claude\|gentle|gentle\|pi|pi\|codex/);
});
