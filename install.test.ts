import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";

const repo = dirname(fileURLToPath(import.meta.url));
let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "herdr-split-install-"));
	for (const d of [".gentle-shell/agent", ".pi/agent", ".claude"]) mkdirSync(join(home, d), { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function run(...args: string[]) {
	return runWithPath("/usr/bin:/bin", ...args);
}

function runWithPath(path: string, ...args: string[]) {
	const r = spawnSync("/bin/sh", [join(repo, "install.sh"), ...args], {
		env: { HOME: home, PATH: path },
		encoding: "utf8",
	});
	return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const stubOf = `export { default } from "${repo}/pi/index.ts";\n`;
const bin = () => join(home, ".local/bin/herdr-split");
const stubs = () => [".gentle-shell/agent", ".pi/agent"].map((d) => join(home, d, "extensions/split/index.ts"));
const cmd = () => join(home, ".claude/commands/split.md");
const installLines = () => [`link ${bin()}`, `write ${stubs()[0]}`, `write ${stubs()[1]}`, `link ${cmd()}`];

test("install creates links and stubs", () => {
	const r = run();
	assert.equal(r.code, 0);
	assert.equal(r.stdout, installLines().join("\n") + "\n");
	assert.equal(readlinkSync(bin()), join(repo, "bin/herdr-split"));
	assert.equal(readlinkSync(cmd()), join(repo, "claude/split.md"));
	for (const s of stubs()) assert.equal(readFileSync(s, "utf8"), stubOf);
});

test("install is idempotent", () => {
	run();
	const r = run();
	assert.equal(r.code, 0);
	assert.equal(r.stdout, installLines().join("\n") + "\n");
	assert.equal(readlinkSync(cmd()), join(repo, "claude/split.md"));
	assert.equal(readFileSync(stubs()[0]!, "utf8"), stubOf);
});

test("foreign files are skipped and left untouched; uninstall keeps them", () => {
	mkdirSync(dirname(stubs()[0]!), { recursive: true });
	writeFileSync(stubs()[0]!, "// mine\n");
	mkdirSync(dirname(cmd()), { recursive: true });
	writeFileSync(cmd(), "my command\n");
	const r = run();
	assert.equal(r.code, 0);
	assert.equal(r.stdout, [`link ${bin()}`, `skip ${stubs()[0]}: exists`, `write ${stubs()[1]}`, `skip ${cmd()}: exists`].join("\n") + "\n");
	assert.equal(readFileSync(stubs()[0]!, "utf8"), "// mine\n");
	assert.equal(readFileSync(cmd(), "utf8"), "my command\n");

	const u = run("--uninstall");
	assert.equal(u.code, 0);
	assert.equal(u.stdout, [`remove ${bin()}`, `remove ${stubs()[1]}`].join("\n") + "\n");
	assert.equal(readFileSync(stubs()[0]!, "utf8"), "// mine\n");
	assert.equal(readFileSync(cmd(), "utf8"), "my command\n");
	assert.equal(existsSync(bin()) || lstatSync(bin(), { throwIfNoEntry: false }) !== undefined, false);
});

test("uninstall removes what install created", () => {
	run();
	const r = run("--uninstall");
	assert.equal(r.code, 0);
	assert.equal(r.stdout, [`remove ${bin()}`, `remove ${stubs()[0]}`, `remove ${stubs()[1]}`, `remove ${cmd()}`].join("\n") + "\n");
	for (const p of [bin(), cmd(), ...stubs()]) assert.equal(lstatSync(p, { throwIfNoEntry: false }), undefined);
});

test("missing fzf and herdr only warn on stderr", () => {
	const tools = mkdtempSync(join(tmpdir(), "herdr-split-tools-"));
	try {
		for (const t of ["dirname", "readlink", "mkdir", "ln", "cat", "printf", "rm", "rmdir"]) {
			const found = ["/usr/bin", "/bin"].map((d) => join(d, t)).find((f) => existsSync(f));
			if (found) symlinkSync(found, join(tools, t));
		}
		const r = runWithPath(tools);
		assert.equal(r.code, 0);
		assert.equal(r.stderr, "warning: fzf not found on PATH\nwarning: herdr not found on PATH\n");
	} finally {
		rmSync(tools, { recursive: true, force: true });
	}
});
