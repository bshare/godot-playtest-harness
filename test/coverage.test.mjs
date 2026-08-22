// Unit tests for coverage.mjs — the tool that tells "no findings" apart from
// "never looked".
//
// The failure mode these pin against is FALSE COMPLETENESS: a coverage report
// that under-reads the vocabulary, over-reads the bundles, or silently drops a
// facet universe reports gaps as covered — which is worse than no report,
// because it retires the question it exists to keep open. So the tests bias
// toward the complement being right: what is listed as UNTOUCHED must really
// never have been attempted or seen.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
	actionVocabulary,
	facetSpecs,
	facetUniverse,
	readBundle,
	collectFacet,
	coverBundle,
	coverPass,
} from "../src/coverage.mjs";

// ---------------------------------------------------------------------------
// Fixture: a tiny game dir and two bundles, one of each shape.
// ---------------------------------------------------------------------------

function makeGame(root) {
	writeFileSync(path.join(root, "playtest.config.json"), JSON.stringify({
		action_catalog: "playtest.actions.json",
		coverage_facets: [
			{
				name: "artifacts",
				state_path: "run.artifacts[*]",
				universe: { file: "data/artifacts.json", path: "artifacts" },
			},
			{
				name: "elites",
				state_path: "combat.enemies[*].id",
				when: "elite",
				universe: { file: "data/enemies.json", path: "enemies", having: "elite" },
			},
		],
	}));
	writeFileSync(path.join(root, "playtest.actions.json"), JSON.stringify({
		actions: { start_run: {}, play_card: {}, end_turn: {}, shop_buy: {} },
		runner_actions: { dump_state: {}, screenshot: {} },
	}));
	mkdirSync(path.join(root, "data"));
	writeFileSync(path.join(root, "data", "artifacts.json"), JSON.stringify({
		artifacts: { brass_lung: {}, sounding_line: {}, rebreather_rig: {} },
	}));
	writeFileSync(path.join(root, "data", "enemies.json"), JSON.stringify({
		enemies: {
			silt_crab: { elite: { aura: "barbed" } },
			drift_jelly: { elite: { aura: "clinging" } },
			ballast_queen: { boss: true }, // no elite record -> not in the universe
		},
	}));
}

function makeScenarioBundle(root, name) {
	const dir = path.join(root, name);
	mkdirSync(dir);
	writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
		scenario: name,
		steps: [
			{ index: 0, action: "start_run", ok: true },
			{ index: 1, action: "dump_state", ok: true, state: {
				run: { artifacts: ["brass_lung"] },
				combat: { enemies: [
					{ id: "silt_crab", elite: true },
					{ id: "drift_jelly" }, // met, but NOT as an elite
				] },
			} },
			{ index: 2, action: "play_card", ok: true },
			{ index: 3, action: "play_card", ok: false }, // a refusal still counts as looked
		],
	}));
	return dir;
}

function makePlayRunBundle(root, name) {
	const dir = path.join(root, name);
	mkdirSync(dir);
	writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
		kind: "play_run",
		turns: [
			{ turn: 1, chosen: { action: "play_card", args: {} } },
			{ turn: 2, chosen: { action: "end_turn", args: {} } },
		],
		final_state: { run: { artifacts: ["brass_lung", "sounding_line"] } },
	}));
	return dir;
}

let root;
function setup() {
	root = mkdtempSync(path.join(tmpdir(), "coverage-test-"));
	makeGame(root);
	return root;
}

// ---------------------------------------------------------------------------
// Vocabulary and universes come from the game, not from this tool.
// ---------------------------------------------------------------------------

test("the vocabulary is the game's catalog, runner actions kept apart", () => {
	setup();
	const vocab = actionVocabulary(root);
	assert.deepEqual(vocab.actions, ["start_run", "play_card", "end_turn", "shop_buy"]);
	assert.deepEqual(vocab.runner, ["dump_state", "screenshot"]);
	rmSync(root, { recursive: true, force: true });
});

test("a facet universe is the data file's keys, filtered by `having`", () => {
	setup();
	const specs = facetSpecs(root);
	assert.equal(specs.length, 2);
	assert.deepEqual(facetUniverse(root, specs[0]), ["brass_lung", "sounding_line", "rebreather_rig"]);
	// The boss has no elite record, so it is not part of the elite universe —
	// an untouchable entry in the universe would be a permanent false gap.
	assert.deepEqual(facetUniverse(root, specs[1]), ["silt_crab", "drift_jelly"]);
	rmSync(root, { recursive: true, force: true });
});

test("an empty universe is an error, not perfect coverage", () => {
	setup();
	assert.throws(
		() => facetUniverse(root, { name: "ghosts", universe: { file: "data/enemies.json", path: "enemies", having: "ghost" } }),
		/universe is empty/,
	);
	assert.throws(
		() => facetUniverse(root, { name: "nowhere", universe: { file: "data/enemies.json", path: "no.such.path" } }),
		/nothing at/,
	);
	rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Both bundle shapes, and debris.
// ---------------------------------------------------------------------------

test("a scenario bundle yields attempts, refusals, and its snapshots", () => {
	setup();
	const b = readBundle(makeScenarioBundle(root, "pass_a"));
	assert.equal(b.kind, "scenario");
	assert.deepEqual(b.attempted, { start_run: 1, dump_state: 1, play_card: 2 });
	assert.deepEqual(b.refused, { play_card: 1 });
	assert.equal(b.states.length, 1);
	rmSync(root, { recursive: true, force: true });
});

test("a play_run bundle yields its chosen actions and final state", () => {
	setup();
	const b = readBundle(makePlayRunBundle(root, "play_900"));
	assert.equal(b.kind, "play_run");
	assert.deepEqual(b.attempted, { play_card: 1, end_turn: 1 });
	assert.equal(b.states.length, 1);
	rmSync(root, { recursive: true, force: true });
});

test("debris is skipped with a reason, never thrown on", () => {
	setup();
	const empty = path.join(root, "not_a_bundle");
	mkdirSync(empty);
	assert.match(readBundle(empty).skipped, /no manifest/);
	const broken = path.join(root, "broken");
	mkdirSync(broken);
	writeFileSync(path.join(broken, "manifest.json"), "{nope");
	assert.match(readBundle(broken).skipped, /not valid JSON/);
	const alien = path.join(root, "alien");
	mkdirSync(alien);
	writeFileSync(path.join(alien, "manifest.json"), JSON.stringify({ hello: 1 }));
	assert.match(readBundle(alien).skipped, /neither steps/);
	rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Facet collection: wildcard, `when`, and tolerance of old bundles.
// ---------------------------------------------------------------------------

test("collectFacet honours the wildcard and the `when` filter", () => {
	const states = [{
		combat: { enemies: [{ id: "silt_crab", elite: true }, { id: "drift_jelly" }] },
	}];
	const touched = collectFacet(states, { state_path: "combat.enemies[*].id", when: "elite" });
	// drift_jelly was MET but not as an elite — counting it would report elite
	// coverage a pass never had.
	assert.deepEqual([...touched], ["silt_crab"]);
});

test("collectFacet reads plain array paths and survives missing branches", () => {
	const touched = collectFacet(
		[{ run: { artifacts: ["brass_lung"] } }, { run: {} }, {}],
		{ state_path: "run.artifacts[*]" },
	);
	assert.deepEqual([...touched], ["brass_lung"]);
});

// ---------------------------------------------------------------------------
// The report: per-bundle complement and the pass-level union.
// ---------------------------------------------------------------------------

test("unexercised is exactly the vocabulary minus the attempts", () => {
	setup();
	const vocab = actionVocabulary(root);
	const facets = facetSpecs(root).map((s) => ({ ...s, universe: { ...s.universe, keys: facetUniverse(root, s) } }));
	const row = coverBundle(readBundle(makeScenarioBundle(root, "pass_a")), vocab, facets);
	assert.deepEqual(row.actions_unexercised, ["end_turn", "shop_buy"]);
	assert.deepEqual(row.runner_unexercised, ["screenshot"]);
	assert.deepEqual(row.facets.artifacts.untouched, ["sounding_line", "rebreather_rig"]);
	assert.deepEqual(row.facets.elites.untouched, ["drift_jelly"]);
	rmSync(root, { recursive: true, force: true });
});

test("the pass union only reports what EVERY bundle missed", () => {
	setup();
	const vocab = actionVocabulary(root);
	const facets = facetSpecs(root).map((s) => ({ ...s, universe: { ...s.universe, keys: facetUniverse(root, s) } }));
	const rows = [
		coverBundle(readBundle(makeScenarioBundle(root, "pass_a")), vocab, facets),
		coverBundle(readBundle(makePlayRunBundle(root, "play_900")), vocab, facets),
	];
	const pass = coverPass(rows, vocab, facets);
	// end_turn was missed by the scenario but played by the play_run — a
	// pass-level gap it is not. shop_buy was missed by both.
	assert.deepEqual(pass.actions_unexercised_by_every_bundle, ["shop_buy"]);
	assert.deepEqual(pass.facets.artifacts.untouched_by_every_bundle, ["rebreather_rig"]);
	assert.deepEqual(pass.facets.elites.untouched_by_every_bundle, ["drift_jelly"]);
	rmSync(root, { recursive: true, force: true });
});

test("importing coverage.mjs runs nothing", () => {
	// Same property batch.mjs pins, same reason: a probe import must never
	// walk a runs/ tree or write a report.
	assert.ok(typeof coverPass === "function");
});

test("duplicate facet names are rejected, not silently collapsed", () => {
	// Facet names key every downstream map — two facets sharing a name would
	// merge into one report entry with the second's numbers winning.
	const dir = mkdtempSync(path.join(tmpdir(), "coverage-test-"));
	try {
		writeFileSync(path.join(dir, "playtest.config.json"), JSON.stringify({
			coverage_facets: [
				{ name: "cards", universe: { data: "d.json", key: "[*]" } },
				{ name: "cards", universe: { data: "e.json", key: "[*]" } },
			],
		}));
		assert.throws(() => facetSpecs(dir), /duplicate facet name "cards"/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
