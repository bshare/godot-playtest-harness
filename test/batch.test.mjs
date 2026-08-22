// Unit tests for batch.mjs — the README's own known gap, closed.
//
// Everything here was previously "verified end to end against a real game",
// which proves the happy path once and nothing else. These pin the three
// surfaces a batch caller actually depends on:
//
//   * arg parsing — a mis-read flag runs the WRONG batch, and a batch is not
//     free: it consumes a seed window a ledger somewhere accounts for.
//   * seed windowing — [seed, seed+runs-1] is the unit those ledgers trade in;
//     an off-by-one here burns or double-spends a window silently.
//   * aggregate math — every balance verdict downstream is a reading of these
//     numbers, so their rounding, filtering, and edge cases are contract.
//
// Also load-bearing: importing batch.mjs must run NOTHING. A "--help" probe
// once executed a real two-thousand-seed batch because main() ran on import.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
	SIM_SCHEMA_VERSION,
	parseArgs,
	resolveBatchOptions,
	resolveMatrix,
	cellVerdict,
	parseSimRecords,
	summarise,
	summariseMetrics,
	compareDeterminism,
	readPath,
	readSummaryStat,
	mean,
	median,
	quantile,
	pct,
	godotBinary,
} from "../src/batch.mjs";

// ---------------------------------------------------------------------------
// godotBinary: an ABSOLUTE path, never a bare name handed to spawn (E).
//
// On Windows, spawn with cwd set to the game directory searches that cwd
// BEFORE PATH — a bare "godot" lets a malicious game repo's own godot.exe
// run instead of the real engine. These are mapping-level: no real Godot
// binary is needed, just a fake executable file on a controlled PATH.
// ---------------------------------------------------------------------------

function fakeExe(dir, name) {
	const p = path.join(dir, name);
	writeFileSync(p, "");
	return p;
}

test("godotBinary: GODOT_BIN wins outright and is returned verbatim", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "godotbin-test-"));
	try {
		const fake = fakeExe(dir, "my-custom-godot");
		assert.equal(godotBinary({ GODOT_BIN: fake, PATH: "" }), fake);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("godotBinary: legacy GODOT env var is honored as a GODOT_BIN alias", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "godotbin-test-"));
	try {
		const fake = fakeExe(dir, "legacy-godot");
		assert.equal(godotBinary({ GODOT: fake, PATH: "" }), fake);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("godotBinary: resolves an ABSOLUTE path from PATH, not a bare name", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "godotbin-test-"));
	try {
		const name = process.platform === "win32" ? "godot.exe" : "godot";
		const fake = fakeExe(dir, name);
		const resolved = godotBinary({ PATH: dir });
		assert.equal(resolved, fake);
		assert.ok(path.isAbsolute(resolved), "must never be a bare name a spawn cwd could shadow");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("godotBinary: no GODOT_BIN/GODOT and a godot-less PATH throws, never falls back to a bare name", () => {
	assert.throws(() => godotBinary({ PATH: "" }), /no Godot binary found/);
});

// If this file runs at all, importing batch.mjs spawned no engine — the import
// at the top would have hung on a Godot boot otherwise. This test just states
// the property so a regression names itself.
test("importing batch.mjs runs no batch", () => {
	assert.equal(typeof resolveBatchOptions, "function");
});

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

test("parseArgs: values, bare flags, and positionals", () => {
	const o = parseArgs(["--runs", "200", "--verify-determinism", "--seed", "80000", "leftover"]);
	assert.equal(o.runs, "200");
	assert.equal(o.seed, "80000");
	assert.equal(o["verify-determinism"], true, "a flag followed by another flag is boolean true");
	assert.deepEqual(o._, ["leftover"]);
});

test("parseArgs: a flag at the end of argv is boolean true, not undefined", () => {
	assert.equal(parseArgs(["--trace"]).trace, true);
});

// ---------------------------------------------------------------------------
// Seed windowing and option resolution
// ---------------------------------------------------------------------------

test("defaults: 50 runs from seed 1, policy random, max-turns 2000", () => {
	const r = resolveBatchOptions(parseArgs([]), tmpdir());
	assert.equal(r.runs, 50);
	assert.equal(r.seed, 1);
	assert.equal(r.maxTurns, 2000);
	assert.deepEqual(r.policies, ["random"]);
	assert.deepEqual(r.seedWindow, { first: 1, last: 50 });
});

test("the seed window is [seed, seed+runs-1] — the ledger unit, exactly", () => {
	// The real shape of the claim "--runs 2000 --seed 80000 spends 80000-81999".
	// An off-by-one in either direction silently burns a neighbouring window.
	const r = resolveBatchOptions(parseArgs(["--runs", "2000", "--seed", "80000"]), tmpdir());
	assert.deepEqual(r.seedWindow, { first: 80000, last: 81999 });
});

test("adjacent windows do not overlap", () => {
	const a = resolveBatchOptions(parseArgs(["--runs", "2000", "--seed", "80000"]), tmpdir());
	const b = resolveBatchOptions(parseArgs(["--runs", "2000", "--seed", "82000"]), tmpdir());
	assert.equal(a.seedWindow.last + 1, b.seedWindow.first);
});

test("--compare splits, trims, and keeps the baseline FIRST", () => {
	// Ratios are reported against the first policy listed; reordering here
	// would silently invert every ratio in the report.
	const r = resolveBatchOptions(parseArgs(["--compare", " greedy , optimiser "]), tmpdir());
	assert.deepEqual(r.policies, ["greedy", "optimiser"]);
});

test("--compare outranks --policy; --policy alone is a one-element list", () => {
	const both = resolveBatchOptions(parseArgs(["--compare", "a,b", "--policy", "c"]), tmpdir());
	assert.deepEqual(both.policies, ["a", "b"]);
	const one = resolveBatchOptions(parseArgs(["--policy", "greedy"]), tmpdir());
	assert.deepEqual(one.policies, ["greedy"]);
});

test("metric paths: --metrics overrides, config supplies, absence is empty not an error", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "batch-test-"));
	try {
		// No config at all — the sim tier must not demand the browser tier's file.
		assert.deepEqual(resolveBatchOptions(parseArgs([]), dir).metricPaths, []);

		writeFileSync(path.join(dir, "playtest.config.json"),
			JSON.stringify({ sim_metrics: ["run.depth", "run.salvage"] }));
		assert.deepEqual(resolveBatchOptions(parseArgs([]), dir).metricPaths,
			["run.depth", "run.salvage"]);

		assert.deepEqual(
			resolveBatchOptions(parseArgs(["--metrics", " a.b , c.d "]), dir).metricPaths,
			["a.b", "c.d"],
			"--metrics must win over the config");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Aggregate math
// ---------------------------------------------------------------------------

const rec = (over = {}) => ({
	version: SIM_SCHEMA_VERSION,
	seed: 1,
	outcome: "LOST",
	turns: 10,
	rejected: 0,
	duration_ms: 4,
	state: { player: { hp_fraction: 0.5 } },
	...over,
});

test("summarise: win rate, turns, hp_fraction, rejections, errors", () => {
	const s = summarise([
		rec({ outcome: "WON", turns: 8, state: { player: { hp_fraction: 1 } } }),
		rec({ outcome: "LOST", turns: 12, rejected: 2 }),
		rec({ outcome: "LOST", turns: 10, error: "boom", seed: 3 }),
	], []);
	assert.equal(s.runs, 3);
	assert.deepEqual(s.outcomes, { WON: 1, LOST: 2 });
	assert.equal(s.win_rate_pct, 33.3, "one decimal, not floored");
	assert.equal(s.turns_mean, 10);
	assert.equal(s.rejections_total, 2, "a non-zero count means the adapter is lying about legal moves");
	assert.equal(s.errored_runs, 1);
	assert.deepEqual(s.errors, [{ seed: 3, error: "boom" }]);
	assert.equal(s.hp_fraction_mean, Math.round(((1 + 0.5 + 0.5) / 3) * 1000) / 1000);
});

test("summarise: a run whose state lacks hp_fraction is excluded, not counted as zero", () => {
	const s = summarise([rec(), rec({ state: {} })], []);
	assert.equal(s.hp_fraction_mean, 0.5, "the stateless run must not drag the mean down");
});

test("summarise: death causes appear only when the game reports any", () => {
	const with_ = summarise([rec({ state: { death_cause: "suffocated", player: {} } })], []);
	assert.deepEqual(with_.death_causes, { suffocated: 1 });
	assert.equal("death_causes" in summarise([rec()], []), false);
});

test("summariseMetrics: a path missing from every run is a named config bug, not a silent omission", () => {
	const m = summariseMetrics([rec()], ["no.such.path"]);
	assert.deepEqual(m.metrics["no.such.path"], { error: "path missing from state in every run" });
});

test("summariseMetrics: mean, median, quartiles, min, max, n, presence over the declared path", () => {
	const records = [1, 2, 3, 4].map((v) => rec({ state: { run: { depth: v } } }));
	const m = summariseMetrics(records, ["run.depth"]).metrics["run.depth"];
	// p25/p75 are nearest-rank (the game-side sweep convention), so 4 values give
	// s[1] and s[3], not interpolated 1.75/3.25 — see quantile()'s comment.
	assert.deepEqual(m, { mean: 2.5, median: 3, p25: 2, p75: 4, min: 1, max: 4, n: 4, present_pct: 100 });
});

test("empty inputs produce zeroes, not NaN", () => {
	assert.equal(mean([]), 0);
	assert.equal(median([]), 0);
	assert.equal(pct(0, 0), 0);
	const s = summarise([], []);
	assert.equal(s.win_rate_pct, 0);
	assert.equal(Number.isNaN(s.hp_fraction_mean), false);
});

test("readPath tolerates a missing branch", () => {
	assert.equal(readPath({ a: { b: 1 } }, "a.b"), 1);
	assert.equal(readPath({ a: {} }, "a.b.c"), undefined);
	assert.equal(readPath(null, "a"), undefined);
});

// ---------------------------------------------------------------------------
// Determinism comparison and the schema guard
// ---------------------------------------------------------------------------

test("compareDeterminism: identical hashes pass, one divergence is named by seed", () => {
	const a = [{ seed: 1, state_hash: "x" }, { seed: 2, state_hash: "y" }];
	assert.equal(compareDeterminism(a, [...a]).all_match, true);

	const r = compareDeterminism(a, [{ seed: 1, state_hash: "x" }, { seed: 2, state_hash: "DIFFERENT" }]);
	assert.equal(r.all_match, false);
	assert.equal(r.diverged.length, 1);
	assert.equal(r.diverged[0].seed, 2);
});

test("compareDeterminism: a missing counterpart run is a mismatch, not a pass", () => {
	const r = compareDeterminism([{ seed: 1, state_hash: "x" }], []);
	assert.equal(r.all_match, false);
});

test("parseSimRecords: refuses a record from a different schema version", () => {
	// Aggregating across a schema change silently averages fields whose
	// meaning moved — this must be a hard error, not a warning.
	const lines = [
		JSON.stringify(rec()),
		JSON.stringify(rec({ version: SIM_SCHEMA_VERSION + 1 })),
	].join("\n");
	assert.throws(() => parseSimRecords(lines), /schema/);
});

test("parseSimRecords: parses JSONL, ignoring blank lines", () => {
	const lines = `${JSON.stringify(rec())}\n\n${JSON.stringify(rec({ seed: 2 }))}\n`;
	const records = parseSimRecords(lines);
	assert.equal(records.length, 2);
	assert.equal(records[1].seed, 2);
});

// --- H-3: matrix mode ----------------------------------------------------------

test("resolveMatrix: cells are the policy x variant cross product, in order", () => {
	const m = resolveMatrix({
		runs: 100, seed: 1000,
		policies: ["greedy", "optimiser"],
		variants: [{ label: "base" }, { label: "hard", game_args: ["--profile=hard"] }],
	});
	assert.deepEqual(m.cells.map((c) => c.id),
		["greedy/base", "greedy/hard", "optimiser/base", "optimiser/hard"]);
	assert.deepEqual(m.cells[1].gameArgs, ["--profile=hard"]);
	assert.deepEqual(m.cells[0].gameArgs, []);
});

test("resolveMatrix: cell seed windows are disjoint and the span is stated", () => {
	// Two cells sharing seeds would look "paired" while differing on two axes
	// at once — the windows are consecutive runs-wide slices, ledger-ready.
	const m = resolveMatrix({ runs: 50, seed: 200, policies: ["a", "b"], variants: [{ label: "x" }] });
	assert.deepEqual(m.cells[0].seedWindow, { first: 200, last: 249 });
	assert.deepEqual(m.cells[1].seedWindow, { first: 250, last: 299 });
	assert.deepEqual(m.seedWindow, { first: 200, last: 299 });
});

test("resolveMatrix: refuses an empty policy list, a missing label, a duplicate label", () => {
	assert.throws(() => resolveMatrix({ policies: [] }), /policies/);
	assert.throws(() => resolveMatrix({ policies: ["a"], variants: [{}] }), /label/);
	assert.throws(() => resolveMatrix({ policies: ["a"], variants: [{ label: "x" }, { label: "x" }] }), /duplicate/);
	assert.throws(() => resolveMatrix({ policies: ["a"], variants: [{ label: "x", game_args: "--oops" }] }), /array/);
});

test("cellVerdict: passes inside the band, fails outside, names the number", () => {
	const summary = { win_rate_pct: 12, turns_mean: 300 };
	assert.equal(cellVerdict(summary, { win_rate_pct: [5, 20] }).pass, true);
	const fail = cellVerdict(summary, { win_rate_pct: [15, 45] });
	assert.equal(fail.pass, false);
	assert.deepEqual(fail.failures[0], { metric: "win_rate_pct", value: 12, band: [15, 45] });
});

test("cellVerdict: a target against a metric the summary stopped reporting FAILS", () => {
	// Passing vacuously here is drift wearing a green badge.
	const v = cellVerdict({ win_rate_pct: 12 }, { "metrics.run.air.mean": [10, 60] });
	assert.equal(v.pass, false);
	assert.equal(v.failures[0].reason, "metric missing from summary");
});

test("cellVerdict: no targets declared is a pass that says so", () => {
	const v = cellVerdict({ win_rate_pct: 12 }, undefined);
	assert.equal(v.pass, true);
	assert.equal(v.targets_defined, false);
});

// ---------------------------------------------------------------------------
// The per-stratum shapes a real certification plan needed and could not get
// ---------------------------------------------------------------------------
//
// A real plan row asked for "per-tier certification via H-3's matrix mode" and the
// mode could not carry one row of it: every §7 row is per-STRATUM (quartile
// bands, reach shares, boss-loss shares) and summariseMetrics reported
// whole-run scalar means. Worse, cellVerdict's own doc-comment example
// ("metrics.run.air.mean") had never resolved — metrics are stored under their
// full dotted path as ONE key, and readPath splits on every dot. Loud (targets
// FAILED as missing rather than passing vacuously), so no verdict ever lied;
// but no game-declared metric was ever addressable as a target either. These
// tests pin the repaired contract, each named for the §7 shape it carries.

test("parseArgs: --key=value splits at the FIRST = only, so the value may be a flag", () => {
	const o = parseArgs(["--game-arg=--tier=hard", "--out=runs/sim"]);
	assert.deepEqual(o["game-arg"], ["--tier=hard"], "the value keeps its own = and its leading --");
	assert.equal(o.out, "runs/sim");
});

test("parseArgs: --game-arg repeats and keeps order; other flags stay last-wins", () => {
	const o = parseArgs(["--game-arg=--tier=hard", "--game-arg=--act-cap=2", "--seed", "5", "--seed", "9"]);
	assert.deepEqual(o["game-arg"], ["--tier=hard", "--act-cap=2"]);
	assert.equal(o.seed, "9", "an accidental doubled --seed must not become an array (NaN downstream)");
});

test("resolveBatchOptions: game args ride along outside matrix mode", () => {
	const r = resolveBatchOptions(parseArgs(["--game-arg=--tier=hard"]), tmpdir());
	assert.deepEqual(r.gameArgs, ["--tier=hard"]);
	assert.deepEqual(resolveBatchOptions(parseArgs([]), tmpdir()).gameArgs, [], "absent means none, not undefined");
});

test("quantile: nearest-rank with no interpolation, matching the game-side sweep", () => {
	// the game-side sweep's _pct is sorted[floor(q*n)] clamped; the two instruments
	// must agree on the same records or a cross-check reads as a data bug.
	assert.equal(quantile([4, 1, 3, 2], 0.25), 2);
	assert.equal(quantile([4, 1, 3, 2], 0.75), 4);
	assert.equal(quantile([7], 0.75), 7, "clamped at the top, not out of range");
	assert.equal(quantile([], 0.5), 0);
	assert.equal(quantile([1, 2, 3, 4], 0.5), median([1, 2, 3, 4]), "q=0.5 IS the median, same convention");
});

test("summariseMetrics: a dotted numeric segment addresses one array element, and short arrays drop out — which IS the §7 conditioning", () => {
	// Three runs reach boss 1, two reach boss 2, one reaches boss 3. The
	// element metric's n is the conditional sample ("of the runs that reached
	// it") and present_pct is the reach share itself.
	const records = [
		rec({ state: { run: { air_at_boss_by_act: [50, 40, 30] } } }),
		rec({ state: { run: { air_at_boss_by_act: [52, 44] } } }),
		rec({ state: { run: { air_at_boss_by_act: [48] } } }),
		rec({ state: { run: { air_at_boss_by_act: [] } } }),
	];
	const m = summariseMetrics(records, ["run.air_at_boss_by_act.0", "run.air_at_boss_by_act.2"]).metrics;
	assert.equal(m["run.air_at_boss_by_act.0"].n, 3);
	assert.equal(m["run.air_at_boss_by_act.0"].present_pct, 75, "reach-boss-1 share, out of ALL runs");
	assert.equal(m["run.air_at_boss_by_act.2"].n, 1);
	assert.equal(m["run.air_at_boss_by_act.2"].present_pct, 25);
	assert.equal(m["run.air_at_boss_by_act.2"].median, 30, "aggregated over reachers only, never zero-padded");
});

test("summariseMetrics: an element nobody reached is a measured zero, not a config error", () => {
	// Found by the first real batch after element paths landed: two Squall runs,
	// neither reached boss 1, and ".0" reported "path missing" — but a reach
	// share of 0% is an answer, and the parent being an array is the tell that
	// the path is well-formed. A genuinely typo'd path still errors.
	const records = [rec({ state: { run: { air_at_boss_by_act: [] } } })];
	const m = summariseMetrics(records, ["run.air_at_boss_by_act.0", "run.no_such.0"]).metrics;
	assert.deepEqual(m["run.air_at_boss_by_act.0"], { n: 0, present_pct: 0 },
		"zero reach reports itself, with no mean/median to lie about nobody");
	assert.match(m["run.no_such.0"].error, /missing/, "a typo is still a typo");
});

test("summariseMetrics: naming the bare array path is an error that teaches the element syntax", () => {
	const m = summariseMetrics([rec({ state: { run: { air_at_boss_by_act: [50] } } })],
		["run.air_at_boss_by_act"]).metrics["run.air_at_boss_by_act"];
	assert.match(m.error, /address one element per metric/);
	assert.match(m.error, /air_at_boss_by_act\.0/, "the message must show the caller the fix");
});

test("summariseMetrics: a string path aggregates to a share table over the PRESENT runs", () => {
	// The boss-loss row: the key exists only on losses, so shares are out of
	// losses (the §7 denominator) and present_pct carries the loss rate.
	const records = [
		rec({ state: { run: { death_key: "s2-boss" } } }),
		rec({ state: { run: { death_key: "s2-boss" } } }),
		rec({ state: { run: { death_key: "s2-node" } } }),
		rec({ outcome: "WON", state: { run: {} } }),
	];
	const m = summariseMetrics(records, ["run.death_key"]).metrics["run.death_key"];
	assert.equal(m.n, 3);
	assert.equal(m.present_pct, 75);
	assert.deepEqual(m.shares, { "s2-boss": 66.7, "s2-node": 33.3 });
});

test("summariseMetrics: booleans join the share table as 'true'/'false'", () => {
	const m = summariseMetrics([
		rec({ state: { run: { landed: true } } }),
		rec({ state: { run: { landed: false } } }),
	], ["run.landed"]).metrics["run.landed"];
	assert.deepEqual(m.shares, { "true": 50, "false": 50 });
});

test("summariseMetrics: one path with two types is a named measurement bug", () => {
	const m = summariseMetrics([
		rec({ state: { run: { depth: 4 } } }),
		rec({ state: { run: { depth: "four" } } }),
	], ["run.depth"]).metrics["run.depth"];
	assert.match(m.error, /one field, one type/);
});

test("readSummaryStat: longest declared path wins, so 'run.air' cannot shadow 'run.air_at_boss_by_act.2'", () => {
	const summary = { metrics: {
		"run.air": { mean: 40 },
		"run.air_at_boss_by_act.2": { p75: 58, present_pct: 61.2 },
	} };
	assert.equal(readSummaryStat(summary, "metrics.run.air.mean"), 40);
	assert.equal(readSummaryStat(summary, "metrics.run.air_at_boss_by_act.2.p75"), 58);
	assert.equal(readSummaryStat(summary, "metrics.run.air_at_boss_by_act.2.present_pct"), 61.2);
	assert.equal(readSummaryStat(summary, "metrics.run.air.p75"), undefined, "a stat the entry lacks is missing, not zero");
});

test("readSummaryStat: a share the table does not list is 0, not missing", () => {
	const summary = { metrics: { "run.death_key": { n: 3, shares: { "s2-node": 100 } } } };
	assert.equal(readSummaryStat(summary, "metrics.run.death_key.shares.s2-boss"), 0,
		"zero occurrences is a measured answer — a [0, hi] band must be satisfiable");
	assert.equal(readSummaryStat(summary, "metrics.run.no_such.shares.x"), undefined,
		"an undeclared metric is still missing, not zero");
});

test("cellVerdict REGRESSION: the doc-comment's own example resolves at last", () => {
	// Before 2026-08-18 this exact target failed as "metric missing from
	// summary" with the metric present and in band.
	const summary = summarise([rec({ state: { run: { air: 30 } } }), rec({ state: { run: { air: 50 } } })], ["run.air"]);
	assert.equal(cellVerdict(summary, { "metrics.run.air.mean": [0, 100] }).pass, true);
	const fail = cellVerdict(summary, { "metrics.run.air.mean": [45, 100] });
	assert.equal(fail.pass, false);
	assert.equal(fail.failures[0].value, 40, "the verdict names the number, not just the miss");
});

test("cellVerdict: a full §7-shaped row set — quartile band, reach share, boss-loss share — in one verdict", () => {
	const records = [
		rec({ state: { run: { air_at_boss_by_act: [50, 44], death_key: "s2-boss" } } }),
		rec({ state: { run: { air_at_boss_by_act: [52, 47], death_key: "s2-boss" } } }),
		rec({ state: { run: { air_at_boss_by_act: [48], death_key: "s1-node" } } }),
		rec({ outcome: "WON", state: { run: { air_at_boss_by_act: [55, 49] } } }),
	];
	const summary = summarise(records, ["run.air_at_boss_by_act.1", "run.death_key"]);
	const v = cellVerdict(summary, {
		"metrics.run.air_at_boss_by_act.1.p75": [40, 60],
		"metrics.run.air_at_boss_by_act.1.present_pct": [55, 85],
		"metrics.run.death_key.shares.s2-boss": [40, 70],
	});
	assert.deepEqual(v.failures, []);
	assert.equal(v.pass, true);
});
