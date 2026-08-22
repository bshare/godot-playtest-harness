#!/usr/bin/env node
/**
 * coverage.mjs — what a pass of run bundles NEVER touched.
 *
 *   node src/coverage.mjs --game /path/to/game --runs /path/to/game/runs
 *   node src/coverage.mjs --game /path/to/game runs/bundleA runs/bundleB
 *
 * "No findings" and "never looked" produce the same empty findings list, and
 * only one of them is good news. A persona pass that files nothing against
 * the shop has either exercised the shop and found it sound, or never opened
 * it — and the roles themselves cannot tell you which, because a role does
 * not know what it didn't do. This tool reads the evidence bundles a pass
 * left behind and reports the complement: the catalog actions no bundle ever
 * attempted, and (per game-declared facet) the content — artifacts, elites,
 * difficulty tiers — no run ever met.
 *
 * COVERAGE IS NOT A VERDICT. An unexercised action is a question ("why did
 * three personas never land a `wreck_choose`?"), not a failure — some actions
 * are unreachable from some seeds, and inspection actions are exercised by
 * the runner rather than by choice. So a successful report never says
 * pass/fail and exits 0 regardless of what it found; it exists to make the
 * question visible. (A broken INVOCATION still exits 1 — zero readable
 * bundles, or an unusable facet spec, is "never looked", not "clean".)
 *
 * WHAT COUNTS AS TOUCHED. An ATTEMPT counts, including a refused one — a
 * persona that tried an illegal action and read the refusal has looked at
 * that surface (for the Envelope Surveyor the refusal IS the finding).
 * Refusals are still reported separately, because "exercised: 12 attempts,
 * all refused" describes a very different pass than "12 accepted".
 *
 * Two bundle shapes are understood, the same two prune_run.mjs knows:
 *   - scenario / persona bundles: manifest.json with steps[], each step an
 *     action name plus (for dump_state steps) a full state snapshot;
 *   - play_run bundles: manifest.json with kind:"play_run", turns[] each
 *     carrying chosen.action, and one final_state.
 * Facet coverage reads whatever snapshots the bundle carries. A play_run
 * bundle has only its final state, so mid-run-only content can hide from
 * facets there; the report says how many snapshots it read per bundle so a
 * thin basis is visible rather than silently authoritative.
 */

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, readPath } from "./batch.mjs";

/**
 * The action vocabulary is the game's own catalog — playtest.actions.json —
 * not a list this tool invents. `actions` are the bridge calls an agent can
 * choose; `runner_actions` (dump_state, screenshot) are how the runner looks
 * at the game rather than plays it, reported separately because "never
 * screenshotted" is a statement about the harness, not the persona.
 */
export function actionVocabulary(gameDir) {
    const configPath = join(gameDir, "playtest.config.json");
    const catalogName = existsSync(configPath)
        ? (JSON.parse(readFileSync(configPath, "utf8")).action_catalog ?? "playtest.actions.json")
        : "playtest.actions.json";
    const catalog = JSON.parse(readFileSync(join(gameDir, catalogName), "utf8"));
    return {
        actions: Object.keys(catalog.actions ?? {}),
        runner: Object.keys(catalog.runner_actions ?? {}),
    };
}

/** Game-declared facets, from playtest.config.json — see facetUniverse/collectFacet. */
export function facetSpecs(gameDir) {
    const configPath = join(gameDir, "playtest.config.json");
    if (!existsSync(configPath)) return [];
    const specs = JSON.parse(readFileSync(configPath, "utf8")).coverage_facets ?? [];
    // Facet names key every downstream map (touchedByFacet, the report's
    // facets object) — two facets sharing a name would silently collapse
    // into one, with the second's numbers overwriting the first's.
    const seen = new Set();
    for (const spec of specs) {
        if (seen.has(spec.name)) {
            throw new Error(`coverage_facets: duplicate facet name "${spec.name}" — facet names must be unique`);
        }
        seen.add(spec.name);
    }
    return specs;
}

/**
 * One bundle -> what it attempted and what it saw.
 * Unknown manifest shapes are reported as skipped rather than thrown on: a
 * runs/ tree accumulates debris (logs, probe JSON, half-written bundles) and
 * a coverage pass that dies on debris never reports anything.
 */
export function readBundle(dir) {
    const manifestPath = join(dir, "manifest.json");
    if (!existsSync(manifestPath)) return { name: basename(dir), skipped: "no manifest.json" };
    let manifest;
    try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); }
    catch { return { name: basename(dir), skipped: "manifest.json is not valid JSON" }; }

    const attempted = {};   // action -> attempts
    const refused = {};     // action -> attempts that reported failure
    const states = [];
    const note = (action, ok) => {
        if (!action) return;
        attempted[action] = (attempted[action] ?? 0) + 1;
        if (ok === false) refused[action] = (refused[action] ?? 0) + 1;
    };

    if (manifest.kind === "play_run") {
        for (const t of manifest.turns ?? []) note(t.chosen?.action, true);
        if (manifest.final_state) states.push(manifest.final_state);
        return { name: basename(dir), kind: "play_run", attempted, refused, states };
    }
    if (Array.isArray(manifest.steps)) {
        for (const s of manifest.steps) {
            note(s.action, s.ok);
            if (s.state) states.push(s.state);
        }
        return { name: basename(dir), kind: "scenario", attempted, refused, states };
    }
    return { name: basename(dir), skipped: "manifest has neither steps[] nor kind:play_run" };
}

/**
 * A facet's universe comes from the game's own data file, never from a list
 * in config — a hand-copied universe drifts the day an artifact is added,
 * and a coverage tool with a stale universe reports false completeness.
 *
 *   { "file": "data/artifacts.json", "path": "artifacts" }            -> keys
 *   { "file": "data/enemies.json", "path": "enemies", "having": "elite" }
 *
 * `path` is a dotted path to a dictionary; the universe is its keys, filtered
 * to entries that have the `having` key when one is named. An empty universe
 * is an error — it means the spec points at nothing, and unexercised-of-zero
 * would read as perfect coverage.
 */
export function facetUniverse(gameDir, spec) {
    const data = JSON.parse(readFileSync(join(gameDir, spec.universe.file), "utf8"));
    const dict = readPath(data, spec.universe.path);
    if (dict == null || typeof dict !== "object") {
        throw new Error(`facet '${spec.name}': nothing at ${spec.universe.path} in ${spec.universe.file}`);
    }
    const keys = Object.keys(dict).filter((k) =>
        spec.universe.having ? (dict[k] != null && typeof dict[k] === "object" && spec.universe.having in dict[k]) : true);
    if (keys.length === 0) throw new Error(`facet '${spec.name}': universe is empty — the spec points at nothing`);
    return keys;
}

/**
 * Collect a facet's touched values from state snapshots. `state_path` is a
 * dotted path with at most one `[*]` wildcard over an array:
 *
 *   "run.artifacts[*]"                       -> every owned artifact id seen
 *   "combat.enemies[*].id" + when:"elite"    -> ids of enemies met as elites
 *
 * `when` names a key that must be truthy on the wildcard element. Missing
 * branches contribute nothing — old bundles predate new state fields, and a
 * facet must not die on the history it is trying to read.
 */
export function collectFacet(states, spec) {
    const touched = new Set();
    // Exactly zero or one [*] — the resolver below supports no more. With two,
    // `tail` still contains "[*]", readPath can never resolve it, the touched
    // set comes back silently EMPTY, and every universe key reads as
    // "untouched_by_every_bundle": false never-looked findings from a spec
    // typo, in the one tool whose purpose is telling "never looked" apart
    // from "looked and clean". A spec beyond the supported shape is an error.
    const stars = String(spec.state_path).split("[*]").length - 1;
    if (stars > 1) {
        throw new Error(`facet "${spec.name}": state_path ${JSON.stringify(spec.state_path)} has ${stars} [*] wildcards — at most one is supported`);
    }
    const [head, tail] = String(spec.state_path).split("[*]");
    for (const state of states) {
        const base = readPath(state, head.replace(/\.$/, ""));
        if (tail === undefined) {
            // No wildcard: a scalar or an array of values.
            for (const v of Array.isArray(base) ? base : (base == null ? [] : [base])) touched.add(String(v));
            continue;
        }
        if (!Array.isArray(base)) continue;
        for (const el of base) {
            if (spec.when && !(el != null && typeof el === "object" && el[spec.when])) continue;
            const v = tail.startsWith(".") ? readPath(el, tail.slice(1)) : el;
            if (v != null) touched.add(String(v));
        }
    }
    return touched;
}

/** One bundle against the vocabulary and facets. */
export function coverBundle(bundle, vocab, facets) {
    const exercised = Object.keys(bundle.attempted);
    return {
        bundle: bundle.name,
        kind: bundle.kind,
        snapshots_read: bundle.states.length,
        actions_exercised: bundle.attempted,
        actions_refused: bundle.refused,
        actions_unexercised: vocab.actions.filter((a) => !(a in bundle.attempted)),
        runner_unexercised: vocab.runner.filter((a) => !(a in bundle.attempted)),
        facets: Object.fromEntries(facets.map((f) => {
            const touched = collectFacet(bundle.states, f);
            return [f.name, {
                touched: [...touched].sort(),
                untouched: f.universe.keys.filter((k) => !touched.has(k)),
            }];
        })),
        _exercised_set: exercised, // internal, stripped before writing
    };
}

/**
 * The pass-level union is the row a coverage certification actually reads: a single bundle
 * missing the shop is routine; EVERY bundle of a pass missing the shop is
 * the finding. Facet unions likewise.
 */
export function coverPass(rows, vocab, facets) {
    const attempted = new Set(rows.flatMap((r) => r._exercised_set));
    const touchedByFacet = {};
    for (const f of facets) {
        touchedByFacet[f.name] = new Set(rows.flatMap((r) => r.facets[f.name].touched));
    }
    return {
        bundles: rows.length,
        actions_unexercised_by_every_bundle: vocab.actions.filter((a) => !attempted.has(a)),
        runner_unexercised_by_every_bundle: vocab.runner.filter((a) => !attempted.has(a)),
        facets: Object.fromEntries(facets.map((f) => [f.name, {
            universe: f.universe.keys.length,
            touched_by_some_bundle: [...touchedByFacet[f.name]].sort(),
            untouched_by_every_bundle: f.universe.keys.filter((k) => !touchedByFacet[f.name].has(k)),
        }])),
    };
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const gameDir = resolve(String(opts.game ?? process.cwd()));
    const vocab = actionVocabulary(gameDir);
    const facets = facetSpecs(gameDir).map((spec) => ({
        ...spec, universe: { ...spec.universe, keys: facetUniverse(gameDir, spec) },
    }));

    // Bundles: explicit dirs, or every child of --runs that has a manifest.
    const dirs = opts._.length
        ? opts._.map((d) => resolve(String(d)))
        : readdirSync(resolve(String(opts.runs ?? join(gameDir, "runs"))), { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => join(resolve(String(opts.runs ?? join(gameDir, "runs"))), e.name));

    const skipped = [];
    const rows = [];
    for (const dir of dirs) {
        const bundle = readBundle(dir);
        if (bundle.skipped) { skipped.push({ bundle: bundle.name, why: bundle.skipped }); continue; }
        rows.push(coverBundle(bundle, vocab, facets));
    }
    if (rows.length === 0) {
        console.error(`no readable bundles among ${dirs.length} candidates — nothing to report coverage on`);
        process.exit(1);
    }

    const report = {
        generated: new Date().toISOString(),
        game: gameDir,
        action_vocabulary: vocab,
        pass: coverPass(rows, vocab, facets),
        bundles: rows.map(({ _exercised_set, ...row }) => row),
        skipped,
    };

    for (const row of report.bundles) {
        console.log(`${row.bundle} (${row.kind}, ${row.snapshots_read} snapshots): ` +
            `${Object.keys(row.actions_exercised).length}/${vocab.actions.length} actions, ` +
            `unexercised: ${row.actions_unexercised.join(", ") || "none"}`);
    }
    const p = report.pass;
    console.log(`\nPASS of ${p.bundles} bundle(s) — untouched by every bundle:`);
    console.log(`  actions: ${p.actions_unexercised_by_every_bundle.join(", ") || "none"}`);
    for (const [name, f] of Object.entries(p.facets)) {
        console.log(`  ${name}: ${f.untouched_by_every_bundle.join(", ") || "none"} ` +
            `(${f.touched_by_some_bundle.length}/${f.universe} touched)`);
    }

    if (opts.out) {
        const outPath = resolve(String(opts.out));
        mkdirSync(resolve(outPath, ".."), { recursive: true });
        writeFileSync(outPath, JSON.stringify(report, null, 2));
        console.log(`\nreport: ${outPath}`);
    }
}

// Import-safe, same guard and same reason as batch.mjs: main() fires only
// when this file IS the program.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((err) => { console.error(err.message); process.exit(1); });
}
