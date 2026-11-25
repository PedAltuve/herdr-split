import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { lastSplitArgs, readSession } from "./sessions.ts";

const BIN = fileURLToPath(new URL("../bin/herdr-split", import.meta.url));
const command = "<command-message>split</command-message>\n<command-name>/split</command-name>\n<command-args>gentle first</command-args>";

function selected(contents: unknown[]): string | undefined {
	const file = join(mkdtempSync(join(tmpdir(), "herdr-split-selection-")), "s.jsonl");
	writeFileSync(
		file,
		contents
			.map((content, i) => JSON.stringify({ type: "user", uuid: String(i), parentUuid: i ? String(i - 1) : null, message: { role: "user", content } }))
			.join("\n") + "\n",
	);
	return lastSplitArgs(readSession("claude", file));
}

test("the current /split invocation still resolves", () => {
	assert.equal(selected([command]), "gentle first");
});

test("a second command-args element is not an invocation", () => {
	assert.equal(selected([`${command}\n<command-args>gentle second</command-args>`]), undefined);
});

test("prose after an early closing args tag is not an invocation", () => {
	assert.equal(selected([`${command} trailing prose</command-args>`]), undefined);
});

test("a newer user message mixed with a tool result hides an older /split", () => {
	assert.equal(
		selected([command, [{ type: "text", text: "cancel split; ordinary request" }, { type: "tool_result", tool_use_id: "x", content: "ok" }]]),
		undefined,
	);
});

test("a tool-result-only entry after the /split is still ignored", () => {
	assert.equal(selected([command, [{ type: "tool_result", tool_use_id: "x", content: "ok" }]]), "gentle first");
});

for (const [flag, extra, owner] of [["--args-from-transcript", [], "split"], ["--prompt-file", ["/nonexistent"], "pick"]] as const) {
	test(`help rejects ${flag}`, () => {
		const r = spawnSync(BIN, ["help", flag, ...extra], { encoding: "utf8" });
		assert.equal(r.status, 2);
		assert.equal(r.stdout, "");
		assert.equal(r.stderr, `herdr-split: ${flag} only works with ${owner}\n`);
	});
}

test("split --help with --args-from-transcript still prints the help", () => {
	const r = spawnSync(BIN, ["split", "--help", "--args-from-transcript"], { encoding: "utf8" });
	assert.equal(r.status, 0);
	assert.equal(r.stderr, "");
	assert.match(r.stdout, /^herdr-split: /);
});
