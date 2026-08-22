// Tests for the state diff (src/diff_run.mjs): the pure diff engine, state
// extraction from both manifest shapes, and the CLI's diff(1) exit codes.
// No Godot, no browser — fixture bundles only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { diffStates, loadState } from "../src/diff_run.mjs";

const DIFF = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "diff_run.mjs");

// ---------------------------------------------------------------------------
// The diff engine
// ---------------------------------------------------------------------------

test("identical states diff to an empty list", () => {
	const s = { version: 1, run: { day: 3 }, log: ["a", "b"] };
	assert.deepEqual(diffStates(s, structuredClone(s)), []);
});

test("added, removed, changed, and type_changed are all told apart", () => {
	const a = { gold: 10, hp: 5, gone: true, shape: 3 };
	const b = { gold: 12, hp: 5, fresh: "x", shape: "three" };
	const d = diffStates(a, b);
	assert.deepEqual(d.find((x) => x.path === "gold"), { path: "gold", kind: "changed", from: 10, to: 12 });
	assert.equal(d.find((x) => x.path === "gone").kind, "removed");
	assert.equal(d.find((x) => x.path === "fresh").kind, "added");
	assert.equal(d.find((x) => x.path === "shape").kind, "type_changed");
	assert.equal(d.length, 4, "an unchanged key must produce no entry");
});

test("nested paths use the predicate vocabulary's dotted+[i] syntax", () => {
	const a = { grid: { modules: [{ x: 1 }, { x: 2 }] } };
	const b = { grid: { modules: [{ x: 1 }, { x: 9 }] } };
	assert.deepEqual(diffStates(a, b), [{ path: "grid.modules[1].x", kind: "changed", from: 2, to: 9 }]);
});

test("array tails report as added/removed at their index — exact for appends", () => {
	const d = diffStates({ log: ["a", "b"] }, { log: ["a", "b", "c"] });
	assert.deepEqual(d, [{ path: "log[2]", kind: "added", to: "c" }]);
	const r = diffStates({ log: ["a", "b"] }, { log: ["a"] });
	assert.deepEqual(r, [{ path: "log[1]", kind: "removed", from: "b" }]);
});

test("array-vs-object and null-vs-value are type changes, not crashes", () => {
	assert.equal(diffStates({ v: [1] }, { v: { 0: 1 } })[0].kind, "type_changed");
	assert.equal(diffStates({ v: null }, { v: 3 })[0].kind, "changed",
		"null-to-value on matching scalar kind reports as changed with both sides visible");
	assert.equal(diffStates({ v: NaN }, { v: NaN }).length, 0, "two NaNs are no change");
});

// ---------------------------------------------------------------------------
// State extraction from bundles
// ---------------------------------------------------------------------------

function makeBundle(dir, manifest) {
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
}

test("a scenario bundle yields its LAST recorded step state; play_run yields final_state", () => {
	const root = mkdtempSync(path.join(tmpdir(), "diff-test-"));
	try {
		makeBundle(path.join(root, "scen"), {
			steps: [
				{ action: "dump_state", state: { day: 1 } },
				{ action: "end_turn" },
				{ action: "dump_state", state: { day: 2 } },
			],
		});
		assert.deepEqual(loadState(path.join(root, "scen")).state, { day: 2 });

		makeBundle(path.join(root, "play"), { kind: "play_run", final_state: { day: 7 } });
		assert.deepEqual(loadState(path.join(root, "play")).state, { day: 7 });

		makeBundle(path.join(root, "empty"), { steps: [{ action: "wait" }] });
		assert.throws(() => loadState(path.join(root, "empty")), /no step in this bundle recorded a dump_state/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a JSON file is taken as the state itself; garbage is a named error", () => {
	const root = mkdtempSync(path.join(tmpdir(), "diff-test-"));
	try {
		writeFileSync(path.join(root, "snap.json"), JSON.stringify({ seed: 5 }));
		assert.deepEqual(loadState(path.join(root, "snap.json")).state, { seed: 5 });
		// PowerShell 5.1's default file writes carry a UTF-8 BOM; a snapshot
		// hand-saved from a Windows shell is a first-class input here.
		writeFileSync(path.join(root, "bom.json"), "\uFEFF" + JSON.stringify({ seed: 6 }));
		assert.deepEqual(loadState(path.join(root, "bom.json")).state, { seed: 6 });
		writeFileSync(path.join(root, "bad.json"), "{nope");
		assert.throws(() => loadState(path.join(root, "bad.json")), /not valid JSON/);
		assert.throws(() => loadState(path.join(root, "ghost.json")), /does not exist/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// CLI exit codes — diff(1) semantics, pinned so CI can rely on them
// ---------------------------------------------------------------------------

test("exit 0 identical, 1 differences, 2 usage — and --json is machine-readable", () => {
	const root = mkdtempSync(path.join(tmpdir(), "diff-test-"));
	try {
		writeFileSync(path.join(root, "a.json"), JSON.stringify({ version: 1, gold: 10 }));
		writeFileSync(path.join(root, "same.json"), JSON.stringify({ version: 1, gold: 10 }));
		writeFileSync(path.join(root, "b.json"), JSON.stringify({ version: 2, gold: 12 }));

		const run = (...args) => spawnSync(process.execPath, [DIFF, ...args], { encoding: "utf8" });

		assert.equal(run(path.join(root, "a.json"), path.join(root, "same.json")).status, 0);

		const differs = run(path.join(root, "a.json"), path.join(root, "b.json"), "--json");
		assert.equal(differs.status, 1);
		const report = JSON.parse(differs.stdout);
		assert.equal(report.identical, false);
		assert.equal(report.difference_count, 2);
		assert.match(differs.stderr, /schema versions differ/, "a version mismatch warns, never refuses");

		assert.equal(run(path.join(root, "a.json")).status, 2, "one input is a usage error");
		assert.equal(run(path.join(root, "a.json"), path.join(root, "ghost.json")).status, 2);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
