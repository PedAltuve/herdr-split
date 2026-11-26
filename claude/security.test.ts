import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const doc = readFileSync(new URL("./split.md", import.meta.url), "utf8");
const FIXED = 'herdr-split split --source-kind claude --session-id "${CLAUDE_SESSION_ID}" --source-agent claude --args-from-transcript';

test("no slash-command argument placeholder appears anywhere in the command file", () => {
	// Claude Code substitutes $ARGUMENTS textually, so any command containing it is injectable.
	assert.doesNotMatch(doc, /\$ARGUMENTS|\$\{?ARGUMENTS|\$\d/);
	for (const m of doc.matchAll(/!`([^`]*)`/g)) assert.fail(`inline shell command: ${m[1]}`);
});

test("the model runs exactly one fixed Bash command that carries no user text", () => {
	const commands = [...doc.matchAll(/`([^`]*herdr-split[^`]*)`/g)].map((m) => m[1]);
	assert.deepEqual(commands, [FIXED]);
	assert.doesNotMatch(FIXED, /--agent|--role|--name|--prompt|'/);
	assert.match(doc, /Run this single Bash command, exactly as written/);
	assert.match(doc, /Never copy any of the user's text into a command/);
});

test("allowed-tools stays minimal: only the split command", () => {
	assert.match(doc, /^allowed-tools: Bash\(herdr-split split:\*\)$/m);
	assert.equal([...doc.matchAll(/^allowed-tools:/gm)].length, 1);
});

test("the usage hint documents the prompt and the file names the transcript flag", () => {
	assert.match(doc, /^argument-hint: <agent\|role> \[<role>\] \[--name <name>\] \[<prompt>\]$/m);
	assert.match(doc, /reads the arguments from this conversation's transcript/);
	assert.doesNotMatch(doc, /claude\|gentle|gentle\|pi|pi\|codex/);
});
