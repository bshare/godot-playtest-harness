// Self-tests for the harness. Run: npm test
//
// These need no browser, no Godot, and no game — they drive the validator and
// the retention tools directly against fixtures.
//
// WHY THIS EXISTS: the validator is what every game and every agent depends on,
// and the three cases in "silent failures" below are not hypothetical. Each one
// shipped, passed, and produced a false conclusion in a real playtest:
//
//   * x/y as top-level step keys instead of under args — a scenario ran
//     "14/14 succeeded" while every mouse action silently clicked (0, 0),
//     producing a false BLOCKER verdict that cost a full diagnosis cycle.
//   * args.ms on a wait step — eleven checked-in scenarios were silently
//     sleeping 1000ms instead of what they asked for, and one playtest reported
//     a critical bug that did not exist as a result.
//   * an unknown action name — silently doing nothing.
//
// If any of these ever stops being a hard error, every result the harness
// produces afterwards is worthless. That is what these tests are guarding.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = path.join(ROOT, "src", "run_scenario.mjs");
const PRUNE = path.join(ROOT, "src", "prune_run.mjs");

const CATALOG = {
	catalog_version: 1,
	game: "fixture",
	actions: {
		do_thing: {
			fn: "godotDebugDoThing",
			positional: [{ name: "thing_id" }, { name: "count", default: 1 }],
			required: ["thing_id"],
			optional: ["count"],
		},
		set_stuff: {
			fn: "godotDebugSetStuff",
			positional: [{ name: "stuff", encode: "json", default: {} }],
			required: ["stuff"],
			optional: [],
		},
	},
	runner_actions: {
		dump_state: { required: [], optional: [] },
		screenshot: { required: [], optional: [] },
		mouse_click: { required: ["x", "y"], optional: ["steps"] },
	},
};

/** Build a throwaway game repo and validate one scenario against it. */
function validate(steps, extra = {}) {
	const dir = mkdtempSync(path.join(tmpdir(), "harness-test-"));
	try {
		writeFileSync(path.join(dir, "playtest.actions.json"), JSON.stringify(CATALOG));
		writeFileSync(path.join(dir, "playtest.config.json"), JSON.stringify({
			game: "fixture",
			action_catalog: "playtest.actions.json",
			build_dir: "build/web-debug",
			...extra,
		}));
		const scenarioPath = path.join(dir, "s.json");
		writeFileSync(scenarioPath, JSON.stringify({ name: "s", steps }));
		try {
			const out = execFileSync("node", [RUNNER, "--validate", scenarioPath], {
				cwd: dir,
				env: { ...process.env, PLAYTEST_GAME_ROOT: dir },
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			});
			return { ok: true, out };
		} catch (e) {
			return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// The three silent failures. These are the load-bearing tests.
// ---------------------------------------------------------------------------

test("rejects an unknown action name", () => {
	const r = validate([{ action: "no_such_action" }]);
	assert.equal(r.ok, false, "an unknown action must be a hard error");
	assert.match(r.out, /unknown action/i);
});

test("rejects args.ms on a wait step — it must never silently sleep the default", () => {
	const r = validate([{ action: "wait", args: { ms: 5000 } }]);
	assert.equal(r.ok, false, "wait's ms is a TOP-LEVEL key; args.ms must be a hard error");
	assert.match(r.out, /ms/);
});

test("accepts the correct wait form", () => {
	const r = validate([{ action: "wait", ms: 5000 }]);
	assert.equal(r.ok, true, r.out);
});

test("rejects a top-level step key shaped like a misplaced argument", () => {
	// The motivating incident: x/y as siblings of "action" instead of nested
	// under args, which silently defaulted every mouse action to (0, 0).
	const r = validate([{ action: "mouse_click", x: 100, y: 200 }]);
	assert.equal(r.ok, false, "an arg-shaped top-level key must be a hard error");
	assert.match(r.out, /\bx\b/);
});

// ---------------------------------------------------------------------------
// Catalog-driven validation
// ---------------------------------------------------------------------------

test("accepts a valid scenario", () => {
	const r = validate([
		{ action: "dump_state", label: "before" },
		{ action: "do_thing", args: { thing_id: "widget" }, screenshot_after: true },
		{ action: "mouse_click", args: { x: 10, y: 20 } },
	]);
	assert.equal(r.ok, true, r.out);
});

test("rejects a missing required arg", () => {
	const r = validate([{ action: "do_thing", args: { count: 2 } }]);
	assert.equal(r.ok, false, "a missing required arg must be a hard error");
	assert.match(r.out, /thing_id/);
});

test("an explicit null satisfies a required arg — null is a legitimate value", () => {
	// Deliberate, and load-bearing: {op: "==", value: null} is how a scenario
	// asserts a field was cleared, and eight real scenarios depend on it.
	// Treating null as "missing" refuses those scenarios outright.
	const r = validate([{ action: "do_thing", args: { thing_id: null } }]);
	assert.equal(r.ok, true, r.out);
});

test("an optional arg may be omitted", () => {
	const r = validate([{ action: "do_thing", args: { thing_id: "w" } }]);
	assert.equal(r.ok, true, r.out);
});

test("an unknown args key warns but does not fail", () => {
	// Support-but-warn: probably a typo, but it could be a deliberately-ignored
	// extra some caller relies on, so it must not block a run.
	const r = validate([{ action: "do_thing", args: { thing_id: "w", typoo: 1 } }]);
	assert.equal(r.ok, true, r.out);
	assert.match(r.out, /warn/i);
});

test("fails loudly when the catalog is missing", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "harness-test-"));
	try {
		writeFileSync(path.join(dir, "playtest.config.json"), JSON.stringify({
			game: "fixture", action_catalog: "nope.json",
		}));
		writeFileSync(path.join(dir, "s.json"), JSON.stringify({ name: "s", steps: [] }));
		let failed = false;
		let out = "";
		try {
			execFileSync("node", [RUNNER, "--validate", path.join(dir, "s.json")], {
				cwd: dir, env: { ...process.env, PLAYTEST_GAME_ROOT: dir }, encoding: "utf8",
			});
		} catch (e) {
			failed = true;
			out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
		}
		assert.equal(failed, true, "a missing catalog must not be survivable");
		assert.match(out, /catalog/i);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("wait_for requires path and op", () => {
	const r = validate([{ action: "wait_for", args: { path: "a.b" } }]);
	assert.equal(r.ok, false, "wait_for without an op must be a hard error");
	assert.match(r.out, /op/);
});

test("wait_for accepts a full predicate", () => {
	const r = validate([
		{ action: "wait_for", args: { path: "combat.turn", op: ">=", value: 3, timeout_ms: 5000 } },
	]);
	assert.equal(r.ok, true, r.out);
});

test("wait_for counts as a judgement — no 'zero assertions' warning", () => {
	// A fatal wait_for fails the run if the condition never holds, so a scenario
	// using one is not unjudged.
	const r = validate([{ action: "wait_for", args: { path: "a.b", op: "exists" } }]);
	assert.equal(r.ok, true, r.out);
	assert.doesNotMatch(r.out, /zero assertions/);
});

// ---------------------------------------------------------------------------
// Evidence retention
// ---------------------------------------------------------------------------

function makeBundle({ withReport = true } = {}) {
	const base = mkdtempSync(path.join(tmpdir(), "harness-runs-"));
	const runDir = path.join(base, "runs", "critique_0001");
	mkdirSync(path.join(runDir, "screenshots"), { recursive: true });
	for (const n of ["a", "b", "c", "d"]) {
		writeFileSync(path.join(runDir, "screenshots", `beat_${n}.png`), Buffer.alloc(2048, 1));
	}
	if (withReport) {
		writeFileSync(path.join(runDir, "report.md"),
			"# Critique\n\n## F01 — thing is wrong\nEvidence: `beat_b.png` shows it.\n");
	}
	return { base, runDir };
}

function prune(runDir, args = []) {
	try {
		return { ok: true, out: execFileSync("node", [PRUNE, runDir, ...args], { encoding: "utf8" }) };
	} catch (e) {
		return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
	}
}

test("prune refuses to run without a report", () => {
	const { base, runDir } = makeBundle({ withReport: false });
	try {
		const r = prune(runDir);
		assert.equal(r.ok, false, "no report means the bundle is still live");
		assert.equal(readdirSync(path.join(runDir, "screenshots")).length, 4, "nothing may be deleted");
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("prune refuses a path outside a runs/ tree", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "harness-notruns-"));
	try {
		mkdirSync(path.join(dir, "screenshots"), { recursive: true });
		writeFileSync(path.join(dir, "report.md"), "# r\n");
		const r = prune(dir);
		assert.equal(r.ok, false, "a prune tool must not be pointable at arbitrary paths");
		assert.match(r.out, /runs/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("prune --dry-run changes nothing", () => {
	const { base, runDir } = makeBundle();
	try {
		const r = prune(runDir, ["--dry-run"]);
		assert.equal(r.ok, true, r.out);
		assert.equal(readdirSync(path.join(runDir, "screenshots")).length, 4);
		assert.equal(existsSync(path.join(runDir, "MANIFEST.md")), false);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("prune keeps cited evidence, deletes the rest, and leaves a tombstone", () => {
	const { base, runDir } = makeBundle();
	try {
		const r = prune(runDir);
		assert.equal(r.ok, true, r.out);

		const kept = readdirSync(path.join(runDir, "evidence"));
		assert.deepEqual(kept, ["F01_beat_b.png"], "the cited shot is kept and named for its finding");
		assert.equal(existsSync(path.join(runDir, "screenshots")), false, "uncited shots are gone");

		// The tombstone is the point: a later reader must be able to tell
		// "never captured" from "captured and pruned".
		const manifest = readFileSync(path.join(runDir, "MANIFEST.md"), "utf8");
		for (const gone of ["beat_a.png", "beat_c.png", "beat_d.png"]) {
			assert.match(manifest, new RegExp(gone), `${gone} must be recorded as deleted`);
		}
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Evidence retention — play_run bundles
//
// A play_run bundle differs from a scenario bundle in one way that matters to
// the pruner: its manifest.json turn records point at screenshots/ by path.
// Deleting the files without rewriting those pointers leaves the bundle's own
// machine-readable record full of dangling references, so a recognised
// play_run manifest gets rewritten in the same pass — kept shots point at
// their evidence/ home, deleted ones keep their NAME under screenshot_pruned.
// ---------------------------------------------------------------------------

function makePlayRunBundle({ withReport = true } = {}) {
	const base = mkdtempSync(path.join(tmpdir(), "harness-runs-"));
	const runDir = path.join(base, "runs", "play_optimiser_seed2_fixture");
	mkdirSync(path.join(runDir, "screenshots"), { recursive: true });
	for (const n of ["turn_00050.png", "turn_00100.png", "final.png"]) {
		writeFileSync(path.join(runDir, "screenshots", n), Buffer.alloc(2048, 1));
	}
	writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify({
		kind: "play_run",
		seed: 2,
		policy: "optimiser",
		turns: [
			{ turn: 50, chosen: "play_card", hash: "aaa", screenshot: "screenshots/turn_00050.png" },
			{ turn: 100, chosen: "end_turn", hash: "bbb", screenshot: "screenshots/turn_00100.png" },
			{ turn: 101, chosen: "end_turn", hash: "ccc" },
		],
		outcome: "WON",
	}, null, 2));
	if (withReport) {
		writeFileSync(path.join(runDir, "report.md"),
			"# Play run\n\n## F02 — the badge vanished\nEvidence: `turn_00050.png` shows it.\n");
	}
	return { base, runDir };
}

test("prune refuses a play_run bundle without a report — same rule as scenario bundles", () => {
	const { base, runDir } = makePlayRunBundle({ withReport: false });
	try {
		const r = prune(runDir);
		assert.equal(r.ok, false, "a manifest.json is a run record, not a report");
		assert.equal(readdirSync(path.join(runDir, "screenshots")).length, 3, "nothing may be deleted");
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("prune on a play_run bundle keeps cited shots and rewrites manifest.json's pointers", () => {
	const { base, runDir } = makePlayRunBundle();
	try {
		const r = prune(runDir);
		assert.equal(r.ok, true, r.out);

		assert.deepEqual(readdirSync(path.join(runDir, "evidence")), ["F02_turn_00050.png"]);
		assert.equal(existsSync(path.join(runDir, "screenshots")), false);

		const manifest = JSON.parse(readFileSync(path.join(runDir, "manifest.json"), "utf8"));
		const [cited, uncited, shotless] = manifest.turns;
		assert.equal(cited.screenshot, "evidence/F02_turn_00050.png",
			"the kept turn must point at the shot's new home");
		assert.equal("screenshot" in uncited, false, "a dangling path must not survive");
		assert.equal(uncited.screenshot_pruned, "turn_00100.png",
			"'pruned' must stay distinguishable from 'never captured'");
		assert.equal("screenshot" in shotless, false);
		assert.equal("screenshot_pruned" in shotless, false,
			"a turn that never had a shot must not claim one was pruned");
		assert.ok(manifest.pruned_at, "the rewrite is dated");
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("prune --dry-run leaves a play_run manifest untouched", () => {
	const { base, runDir } = makePlayRunBundle();
	try {
		const before = readFileSync(path.join(runDir, "manifest.json"), "utf8");
		const r = prune(runDir, ["--dry-run"]);
		assert.equal(r.ok, true, r.out);
		assert.equal(readFileSync(path.join(runDir, "manifest.json"), "utf8"), before);
		assert.equal(readdirSync(path.join(runDir, "screenshots")).length, 3);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("prune refuses a bundle whose own manifest.json is broken JSON", () => {
	const { base, runDir } = makePlayRunBundle();
	try {
		writeFileSync(path.join(runDir, "manifest.json"), "{ not json");
		const r = prune(runDir);
		assert.equal(r.ok, false, "pruning around a corrupt manifest would bake the corruption in");
		assert.match(r.out, /manifest/i);
		assert.equal(readdirSync(path.join(runDir, "screenshots")).length, 3, "nothing may be deleted");
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("prune warns rather than silently keeping nothing when a report cites no images", () => {
	const { base, runDir } = makeBundle();
	try {
		writeFileSync(path.join(runDir, "report.md"), "# Critique\n\nNothing cited at all.\n");
		const r = prune(runDir);
		assert.equal(r.ok, true, r.out);
		assert.match(r.out, /cites no screenshots/i);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("a catalog action named after a builtin pseudo-action draws a shadowing warning", () => {
	// The executor dispatches wait/dump_state/mouse_click/... by hardcoded
	// branch BEFORE consulting the catalog, so a catalog `actions:` entry
	// wearing one of those names can never run. The validator must say so.
	const dir = mkdtempSync(path.join(tmpdir(), "harness-test-"));
	try {
		const catalog = {
			...CATALOG,
			actions: { ...CATALOG.actions, wait: { fn: "godotDebugWait", positional: [], required: [], optional: [] } },
		};
		writeFileSync(path.join(dir, "playtest.actions.json"), JSON.stringify(catalog));
		writeFileSync(path.join(dir, "playtest.config.json"), JSON.stringify({
			game: "fixture", action_catalog: "playtest.actions.json", build_dir: "build/web-debug",
		}));
		const scenarioPath = path.join(dir, "s.json");
		writeFileSync(scenarioPath, JSON.stringify({ name: "s", steps: [{ action: "do_thing", args: { thing_id: "a" } }] }));
		const r = spawnSync("node", [RUNNER, "--validate", scenarioPath], {
			cwd: dir,
			env: { ...process.env, PLAYTEST_GAME_ROOT: dir },
			encoding: "utf8",
		});
		const out = `${r.stdout}${r.stderr}`;
		assert.equal(r.status, 0, out); // a warning, not an error — existing catalogs must keep validating
		assert.match(out, /collides with the runner's built-in/, out);
		assert.match(out, /"wait"/, out);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("prune repoints backslash pointers from pre-fix Windows bundles, on any OS", () => {
	// Manifests are written with forward slashes now, but bundles produced
	// before that fix carry win32 backslashes — and POSIX path.basename
	// treats a backslash as part of the filename, which would misfile every
	// such pointer as pruned. This runs on Linux in CI, where it matters.
	const { base, runDir } = makePlayRunBundle();
	try {
		const manifestPath = path.join(runDir, "manifest.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		for (const t of manifest.turns) {
			if (t.screenshot) t.screenshot = t.screenshot.replace(/\//g, "\\");
		}
		writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

		const r = prune(runDir);
		assert.equal(r.ok, true, r.out);
		const rewritten = JSON.parse(readFileSync(manifestPath, "utf8"));
		const [cited, uncited] = rewritten.turns;
		assert.equal(cited.screenshot, "evidence/F02_turn_00050.png");
		assert.equal(uncited.screenshot_pruned, "turn_00100.png");
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});
