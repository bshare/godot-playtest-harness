// mcp_server.mjs's timeout kill must reach the WHOLE process tree, not just
// the immediate node child it spawned (finding D).
//
// A real tool (batch.mjs, play_run.mjs's sim tier) spawns `godot --headless`
// as a grandchild of the process runTool() itself spawns. The old timeout
// handler did `child.kill("SIGKILL")` — TerminateProcess on Windows, which
// does not cascade to children at all, so the grandchild survives the
// timeout indefinitely. No Godot is needed to prove this: a fixture script
// (test/fixtures/grandchild_sleeper.mjs) stands in for the tool and spawns a
// plain node grandchild that just idles, exactly reproducing the shape.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runTool } from "../src/mcp_server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = path.join(ROOT, "src");
const FIXTURE = path.join(ROOT, "test", "fixtures", "grandchild_sleeper.mjs");

function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

test("a timed-out tool's grandchild process is killed too, not just the immediate child", async (t) => {
	const projectDir = mkdtempSync(path.join(tmpdir(), "mcp-grandchild-"));
	const pidFile = path.join(projectDir, "grandchild.pid");
	try {
		const tool = {
			name: "grandchild_sleeper",
			// runTool joins SRC_DIR with tool.script — escape back out to the
			// fixture, which lives outside src/ like every other test fixture.
			script: path.relative(SRC_DIR, FIXTURE),
			inputSchema: { required: [], properties: {} },
			argv: () => [pidFile],
		};

		const result = await runTool(tool, { project_dir: projectDir, timeout_ms: 300 });
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /TIMEOUT/);

		// The fixture writes the grandchild's pid before it ever idles, so by
		// the time runTool has resolved (after killing its immediate child),
		// the file must exist.
		assert.ok(existsSync(pidFile), "fixture never got to spawn its grandchild");
		const grandchildPid = Number(readFileSync(pidFile, "utf8").trim());
		assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0);

		// Killing a process tree is not instantaneous (taskkill on Windows is
		// itself a spawned process); poll briefly rather than asserting the
		// instant runTool resolves.
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline && isAlive(grandchildPid)) {
			await sleep(100);
		}
		assert.equal(isAlive(grandchildPid), false,
			"the grandchild outlived the timeout — only the immediate child was killed");
	} finally {
		rmSync(projectDir, { recursive: true, force: true });
	}
});
