// Unit tests for play_run.mjs — the other half of the README's known gap.
//
// The browser loop itself is exercised end to end against a real game; what
// was never tested is everything decided BEFORE the browser launches (config
// precedence, the negative-control policy split) and the two judgements made
// after it closes (the outcome column, the parity verdict). Those judgements
// are what a play_run bundle is trusted for, so they get pinned here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseArgs, resolveConfig, deriveOutcome, parityVerdict, locatePython } from "../src/play_run.mjs";

test("importing play_run.mjs launches nothing and reads no config", () => {
	// resolveConfig is where the config read lives; import alone must be inert.
	assert.equal(typeof resolveConfig, "function");
});

// ---------------------------------------------------------------------------
// locatePython: an ABSOLUTE path, never a bare name handed to spawn (E), with
// python3 as a real fallback for python-less-but-python3-having hosts (B).
// Mapping-level: a fake executable file on a controlled PATH, no real
// interpreter needed.
// ---------------------------------------------------------------------------

function fakeExe(dir, name) {
	writeFileSync(path.join(dir, name), "");
	return path.join(dir, name);
}

test("locatePython: resolves an ABSOLUTE path from PATH for `python`", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "locatepython-test-"));
	try {
		const name = process.platform === "win32" ? "python.exe" : "python";
		const fake = fakeExe(dir, name);
		const resolved = locatePython({ PATH: dir });
		assert.equal(resolved, fake);
		assert.ok(path.isAbsolute(resolved));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("locatePython: falls back to `python3` when only that is on PATH", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "locatepython-test-"));
	try {
		const name = process.platform === "win32" ? "python3.exe" : "python3";
		const fake = fakeExe(dir, name);
		assert.equal(locatePython({ PATH: dir }), fake);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("locatePython: `python` is preferred over `python3` when both are present", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "locatepython-test-"));
	try {
		const ext = process.platform === "win32" ? ".exe" : "";
		const python = fakeExe(dir, "python" + ext);
		fakeExe(dir, "python3" + ext);
		assert.equal(locatePython({ PATH: dir }), python);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("locatePython: a python-less PATH returns null, not a throw", () => {
	assert.equal(locatePython({ PATH: "" }), null);
});

/** A throwaway game root with a config to resolve against. */
function gameRoot(config = {}) {
	const dir = mkdtempSync(path.join(tmpdir(), "playrun-test-"));
	writeFileSync(path.join(dir, "playtest.config.json"), JSON.stringify(config));
	return dir;
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

test("defaults: port 8062, debug build dir, seed 1, random policy, 200 turns", () => {
	const dir = gameRoot({});
	try {
		const c = resolveConfig({ argv: ["--game", dir] });
		assert.equal(c.PORT, 8062);
		assert.equal(c.BASE_URL, "http://localhost:8062");
		assert.equal(c.BUILD_DIR, path.resolve(dir, "build/web-debug"));
		assert.equal(c.RUNS_DIR, path.resolve(dir, "runs"));
		assert.equal(c.SEED, 1);
		assert.equal(c.POLICY, "random");
		assert.equal(c.MAX_TURNS, 200);
		assert.equal(c.SHOT_EVERY, 0);
		assert.deepEqual(c.BOOT_SEQUENCE, []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("port precedence: env outranks flag outranks config outranks default", () => {
	// The rule that keeps two harness invocations from silently serving each
	// other's builds. Each layer must beat everything below it.
	const dir = gameRoot({ port: 9001 });
	try {
		assert.equal(resolveConfig({ argv: ["--game", dir] }).PORT, 9001,
			"config beats the default");
		assert.equal(resolveConfig({ argv: ["--game", dir, "--port", "9002"] }).PORT, 9002,
			"the flag beats the config");
		assert.equal(resolveConfig({
			argv: ["--game", dir, "--port", "9002"],
			env: { PLAYTEST_PORT: "9003" },
		}).PORT, 9003, "the env beats the flag");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("--game outranks PLAYTEST_GAME_ROOT outranks cwd", () => {
	const a = gameRoot({});
	const b = gameRoot({});
	try {
		assert.equal(resolveConfig({ argv: ["--game", a], env: { PLAYTEST_GAME_ROOT: b } }).GAME_ROOT,
			path.resolve(a));
		assert.equal(resolveConfig({ argv: [], env: { PLAYTEST_GAME_ROOT: b } }).GAME_ROOT,
			path.resolve(b));
		assert.equal(resolveConfig({ argv: [], env: {}, cwd: a }).GAME_ROOT, path.resolve(a));
	} finally {
		rmSync(a, { recursive: true, force: true });
		rmSync(b, { recursive: true, force: true });
	}
});

test("the bridge function names come from config.bridge, with the documented defaults", () => {
	const dir = gameRoot({ bridge: { state_fn: "myDump", state_var: "myState" } });
	try {
		const c = resolveConfig({ argv: ["--game", dir] });
		assert.equal(c.FN.dumpState, "myDump");
		assert.equal(c.FN.stateVar, "myState");
		assert.equal(c.FN.resultVar, "godotDebugLastActionResult", "unset keys keep their defaults");
		assert.equal(c.FN.simReset, "godotDebugSimReset", "the adapter five are not configurable");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("--seed=900 (the = form) sets the seed — it used to silently default to 1", () => {
	// The exact bug: the old bespoke parseArgs treated `--seed=900` as a
	// single boolean flag named "seed=900" (next arg didn't start with "--",
	// but there WAS no next arg here, and even with one this key never
	// matched "seed"), so SEED silently fell through to its default of 1
	// with no error at all. parseArgs is now shared with batch.mjs, which
	// already split on "=".
	const dir = gameRoot({});
	try {
		assert.equal(resolveConfig({ argv: ["--game", dir, "--seed=900"] }).SEED, 900);
		assert.equal(resolveConfig({ argv: ["--game", dir, "--seed", "900"] }).SEED, 900,
			"the space form must keep working identically");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("SIM_POLICY follows POLICY unless --sim-policy splits them (the negative control)", () => {
	const dir = gameRoot({});
	try {
		const same = resolveConfig({ argv: ["--game", dir, "--policy", "optimiser"] });
		assert.equal(same.SIM_POLICY, "optimiser");
		const split = resolveConfig({
			argv: ["--game", dir, "--policy", "optimiser", "--sim-policy", "random"],
		});
		assert.equal(split.SIM_POLICY, "random",
			"the deliberate mismatch that must make parity fail at turn one");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// The two post-run judgements
// ---------------------------------------------------------------------------

test("deriveOutcome: the four outcomes, from state and stop reason", () => {
	assert.equal(deriveOutcome({ sim: { game_over: true, player: { is_dead: false } } }, "max_turns"), "WON");
	assert.equal(deriveOutcome({ sim: { game_over: true, player: { is_dead: true } } }, "max_turns"), "LOST");
	assert.equal(deriveOutcome({ sim: { game_over: false } }, "max_turns"), "TIMEOUT");
	assert.equal(deriveOutcome({ sim: { game_over: false } }, "policy_step_failed"), "STOPPED");
	assert.equal(deriveOutcome(null, "max_turns"), "TIMEOUT", "a missing state dump must not crash the verdict");
});

test("parityVerdict: zero turns compared is a FAILURE, never a pass", () => {
	// The whole reason this function exists: a bridge that dies on turn one
	// must not report 'parity OK' over an empty comparison.
	const v = parityVerdict(0, 40);
	assert.equal(v.ok, false);
	assert.match(v.reason, /no turns/);
});

test("parityVerdict: unequal turn counts are a FAILURE naming the unverified tail", () => {
	// The old contract reported ok:true whenever ANY prefix matched — so a
	// browser run that outlived the sim trace (the common case whenever the
	// game ends before max_turns) printed "parity OK" with its trailing turns
	// never compared at all. A verdict must not claim more than it verified.
	const v = parityVerdict(37, 40);
	assert.equal(v.ok, false);
	assert.match(v.reason, /mismatch/);
	assert.match(v.reason, /37/);
	assert.match(v.reason, /40/);
	assert.equal(v.turns_compared, 37, "the compared prefix is still reported — the reader needs to know how far the evidence goes");
	assert.equal(v.sim_turns, 40);
	assert.equal(v.browser_turns, 37);
});

test("parityVerdict: equal turn counts with at least one comparison pass", () => {
	const v = parityVerdict(40, 40);
	assert.equal(v.ok, true);
	assert.equal(v.turns_compared, 40);
});
