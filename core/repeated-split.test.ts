import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSession } from "./sessions.ts";

test("later splits retain turns after an earlier split", () => {
	const file = join(mkdtempSync(join(tmpdir(), "split-repeat-")), "s.jsonl");
	const texts = ["first task", "<command-name>/split</command-name>", "new task after split", "<command-name>/split</command-name>"];
	writeFileSync(
		file,
		texts
			.map((content, i) => JSON.stringify({ type: "user", uuid: `u${i}`, parentUuid: i ? `u${i - 1}` : null, message: { role: "user", content } }))
			.join("\n"),
	);
	const turns = readSession("claude", file).turns;
	assert.deepEqual(turns.map((t) => t.prompt), ["first task", "new task after split"]);
	// the earlier /split belongs to the first turn; the trailing /split is excluded
	assert.deepEqual(turns.map((t) => t.cutId), ["u1", "u2"]);
});
