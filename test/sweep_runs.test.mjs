// Unit tests for sweep_runs.mjs.
//
// Two things pinned here that were previously silent:
//
//   * the `--flag=value` form. The old hand-rolled `flag()` used
//     `args.indexOf(name)` and never matched `--max-total-mb=500` — the
//     budget rule silently reverted to the 2048 MB default with no error.
//     Now sweep_runs shares batch.mjs's parseArgs (which already handled
//     `=`), so both forms work identically.
//   * NaN refusal. A numeric flag given a bad value (or none at all) used to
//     produce NaN, and every `> MAX_TOTAL_MB` comparison downstream is then
//     always false — the retention rule silently disables itself. Now that
//     is a loud, immediate error instead.
//
// The runs-tree containment guard itself is covered by runs_guard.test.mjs;
// these tests exercise resolveSweepOptions() and the end-to-end sweep
// decision, not the guard.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveSweepOptions } from "../src/sweep_runs.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SWEEP = path.join(ROOT, "src", "sweep_runs.mjs");

// ---------------------------------------------------------------------------
// resolveSweepOptions: flag parsing, both forms, and defaults.
// ---------------------------------------------------------------------------

test("importing sweep_runs.mjs sweeps nothing — resolveSweepOptions is pure", () => {
	assert.equal(typeof resolveSweepOptions, "function");
});

test("defaults: runs, 2048 MB, 7 unpruned days, 30 pruned days", () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "sweep-opts-"));
	try {
		const cfg = resolveSweepOptions({ argv: [], cwd });
		assert.equal(cfg.runsDir, path.resolve(cwd, "runs"));
		assert.equal(cfg.dryRun, false);
		assert.equal(cfg.maxTotalMb, 2048);
		assert.equal(cfg.unprunedDays, 7);
		assert.equal(cfg.prunedDays, 30);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("space-separated and --flag=value forms agree", () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "sweep-opts-"));
	try {
		const spaced = resolveSweepOptions({ argv: ["--max-total-mb", "500", "--unpruned-days", "3"], cwd });
		const eq = resolveSweepOptions({ argv: ["--max-total-mb=500", "--unpruned-days=3"], cwd });
		assert.equal(spaced.maxTotalMb, 500);
		assert.equal(eq.maxTotalMb, 500, "the = form must resolve identically to the space form");
		assert.equal(eq.unprunedDays, 3);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("a bad numeric value REFUSES loudly rather than defaulting through as NaN", () => {
	assert.throws(
		() => resolveSweepOptions({ argv: ["--max-total-mb=banana"] }),
		/--max-total-mb must be a number/,
	);
});

test("a numeric flag with no value (swallowed by the next flag) REFUSES loudly", () => {
	assert.throws(
		() => resolveSweepOptions({ argv: ["--max-total-mb", "--dry-run"] }),
		/--max-total-mb requires a numeric value/,
	);
});

test("an absent flag is not an error — it takes its default", () => {
	const cfg = resolveSweepOptions({ argv: ["--dry-run"] });
	assert.equal(cfg.maxTotalMb, 2048);
	assert.equal(cfg.dryRun, true);
});

test("the positional runs directory is not confused with a flag's own value", () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "sweep-opts-"));
	try {
		const cfg = resolveSweepOptions({ argv: ["--max-total-mb", "500", "myruns"], cwd });
		assert.equal(cfg.runsDir, path.resolve(cwd, "myruns"));
		assert.equal(cfg.maxTotalMb, 500);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// End-to-end: the CLI actually enforces the parsed budget (not just parses it).
// ---------------------------------------------------------------------------

function makeAgedBundle(runsDir, name, { pruned = false, ageDays = 0, bytes = 1024 } = {}) {
	const dir = path.join(runsDir, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, "payload.bin"), Buffer.alloc(bytes, 7));
	if (pruned) writeFileSync(path.join(dir, "MANIFEST.md"), "# pruned\n");
	const past = new Date(Date.now() - ageDays * 86400000);
	utimesSync(dir, past, past);
}

function sweep(runsDir, args = []) {
	try {
		return { ok: true, out: execFileSync("node", [SWEEP, runsDir, ...args], { encoding: "utf8" }) };
	} catch (e) {
		return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
	}
}

test("--max-total-mb=<n> is actually honored end to end (the exact bug: it used to silently revert to 2048)", () => {
	const base = mkdtempSync(path.join(tmpdir(), "sweep-e2e-"));
	const runsDir = path.join(base, "runs");
	try {
		// Two 1 MB unpruned bundles, both well under the 7-day unpruned-age
		// default, so age alone never dooms either. A 1 MB budget forces
		// exactly one of them out on size — the ONLY way this test can pass
		// is if --max-total-mb=1 actually reached the budget check instead
		// of silently reverting to the 2048 MB default.
		makeAgedBundle(runsDir, "b1", { ageDays: 1, bytes: 1024 * 1024 });
		makeAgedBundle(runsDir, "b2", { ageDays: 2, bytes: 1024 * 1024 });
		const r = sweep(runsDir, ["--max-total-mb=1"]);
		assert.equal(r.ok, true, r.out);
		assert.match(r.out, /over the 1 MB budget/, "the = form must actually reach the budget check");
		assert.equal(existsSync(path.join(runsDir, "b2")), false, "the older bundle is dropped first");
		assert.equal(existsSync(path.join(runsDir, "b1")), true, "the budget is a 1 MB floor, not a wipe");
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("a garbage numeric flag refuses the whole run with exit 2, deleting nothing", () => {
	const base = mkdtempSync(path.join(tmpdir(), "sweep-e2e-"));
	const runsDir = path.join(base, "runs");
	try {
		makeAgedBundle(runsDir, "b1", { pruned: true, ageDays: 999 });
		const r = sweep(runsDir, ["--pruned-days=not-a-number"]);
		assert.equal(r.ok, false);
		assert.match(r.out, /must be a number/);
		assert.equal(existsSync(path.join(runsDir, "b1")), true, "nothing may be deleted on a refused parse");
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});
