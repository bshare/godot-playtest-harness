#!/usr/bin/env node
/**
 * batch.mjs — run the headless sim tier over N seeds and aggregate the result.
 *
 *   node src/batch.mjs --game /path/to/game --runs 200 --seed 1 --policy random
 *   node src/batch.mjs --game /path/to/game --runs 200 --compare random,greedy
 *   node src/batch.mjs --game /path/to/game --runs 20 --verify-determinism
 *   node src/batch.mjs --game /path/to/game --runs 200 --game-arg=--tier=hard
 *
 * This is the cheap tier. A browser run costs seconds and produces screenshots;
 * a sim run costs milliseconds and produces numbers. Balance questions belong
 * here, and only here — asking "is the boss too hard" by watching twenty
 * browser runs is both slower and less conclusive than a thousand headless ones.
 *
 * WHAT THE NUMBERS MEAN, AND WHAT THEY DO NOT.
 * Agent win rate does not transfer to human difficulty — an agent that plays
 * nothing like a person can beat a level people find brutal, and vice versa.
 * Residual HP at the end of a fight DOES correlate strongly with human-perceived
 * difficulty (Xiao et al., arXiv:2410.02829, r=0.871), so `hp_fraction` is
 * reported as the headline difficulty signal rather than the win column.
 * The other trustworthy shape is a RATIO between two policies: "the optimiser
 * beats the greedy baseline by 2x" says the game has real decisions in it,
 * without either number needing to mean anything on its own.
 */

import { spawn } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { locateGodot } from "./export_build.mjs";

export const SIM_SCHEMA_VERSION = 1;

// Flags that may repeat, each occurrence kept in order. Everything else stays
// last-wins, because promoting EVERY repeat to an array would turn an
// accidental doubled --seed into NaN instead of a value.
const MULTI_FLAGS = new Set(["game-arg"]);

export function parseArgs(argv) {
    const out = { _: [] };
    const put = (key, value) => {
        if (MULTI_FLAGS.has(key)) (out[key] ??= []).push(value);
        else out[key] = value;
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith("--")) {
            const body = a.slice(2);
            // `--key=value` splits at the FIRST `=` only, so the value may
            // itself contain `=` — and may itself start with `--`, which the
            // space-separated form below cannot express. That is not a corner
            // case, it is the whole point of --game-arg: the values it carries
            // are flags (e.g. `--game-arg=--tier=hard`).
            const eq = body.indexOf("=");
            if (eq !== -1) { put(body.slice(0, eq), body.slice(eq + 1)); continue; }
            const next = argv[i + 1];
            if (next === undefined || next.startsWith("--")) {
                // A bare multi-flag would land here and REPLACE its accumulated
                // array with `true` — `--game-arg=--tier=hard --game-arg` used
                // to silently drop every game arg and measure the wrong game.
                // A repeatable flag with no value is a typo; say so.
                if (MULTI_FLAGS.has(body)) throw new Error(`--${body} requires a value: --${body}=<value>`);
                out[body] = true;
            } else { put(body, next); i++; }
        } else out._.push(a);
    }
    return out;
}

/**
 * Resolve an ABSOLUTE Godot binary path — never a bare "godot" handed to
 * spawn. On Windows, spawn with cwd set to the game directory searches that
 * cwd BEFORE PATH, so a bare name lets a malicious game repo's own
 * godot.exe run in place of the real engine. locateGodot() (export_build.mjs)
 * already does a PATH-only scan with the right extensions; GODOT is kept as
 * a legacy alias for its GODOT_BIN so an existing `GODOT=` override still
 * works. Throws instead of falling back to a bare name — a silent fallback
 * would reopen exactly the hole this closes.
 */
export function godotBinary(env = process.env) {
    const resolved = locateGodot({ ...env, GODOT_BIN: env.GODOT_BIN ?? env.GODOT });
    if (!resolved) {
        throw new Error(
            "no Godot binary found: set GODOT_BIN (or GODOT) to the executable's full path, " +
            "or put `godot` or `godot4` on PATH.",
        );
    }
    return resolved;
}

/**
 * One engine boot, N runs. Boot dominates a single run's cost, so batching
 * in-process is the whole reason this tier is fast — and it is also why a game
 * whose reset() leaks state between runs produces a drifting batch rather than
 * an obvious failure. --verify-determinism is how you find that out.
 */
async function runBatch({ gameDir, runs, seed, policy, maxTurns, outPath, trace, gameArgs = [] }) {
    const args = [
        "--headless", "-s", "res://tools/sim/sim_runner.gd", "--",
        `--runs=${runs}`, `--seed=${seed}`, `--policy=${policy}`,
        `--max-turns=${maxTurns}`, `--out=${outPath}`,
        // H-3: per-cell game-side flags (a difficulty profile, an act cap).
        // Passed through verbatim; the game's own strict arg parsing is the
        // guard against a typo'd flag silently measuring the wrong game.
        ...gameArgs,
    ];
    if (trace) args.push("--trace");

    // A wedged engine must eventually become a RED run, not a CI job that sits
    // at the timeout ceiling forever. 30 minutes is far beyond any legitimate
    // batch (this tier's whole selling point is milliseconds per run);
    // PLAYTEST_SIM_TIMEOUT_MS overrides for a game that genuinely needs more.
    const timeoutMs = Number(process.env.PLAYTEST_SIM_TIMEOUT_MS) > 0
        ? Number(process.env.PLAYTEST_SIM_TIMEOUT_MS) : 30 * 60 * 1000;
    await new Promise((res, rej) => {
        const proc = spawn(godotBinary(), args, { cwd: gameDir, stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        const timer = setTimeout(() => {
            proc.kill();
            rej(new Error(`godot produced no exit within ${timeoutMs}ms — killed. ` +
                `A hung sim is a red run, not a silent stall. Raise PLAYTEST_SIM_TIMEOUT_MS if the batch is legitimately this slow.`));
        }, timeoutMs);
        proc.stderr.on("data", (d) => { stderr += d.toString(); });
        proc.on("close", (code) => {
            clearTimeout(timer);
            // Godot exits non-zero on a script error; the JSONL will be short or
            // absent. Surfacing stderr here is the difference between "the batch
            // found nothing" and "the batch never ran".
            if (code !== 0) rej(new Error(`godot exited ${code}\n${stderr.slice(-2000)}`));
            else res();
        });
        proc.on("error", (err) => { clearTimeout(timer); rej(err); });
    });

    if (!existsSync(outPath)) throw new Error(`sim produced no output at ${outPath}`);
    const records = parseSimRecords(readFileSync(outPath, "utf8"));
    // The count is part of the contract. An engine that exits 0 having written
    // an empty (or truncated) file would otherwise flow into every downstream
    // verification as a vacuous pass: compareDeterminism over zero rows is
    // all_match=true, and "determinism OK, runs: 0" is a lie with a green tick.
    if (records.length !== runs) {
        throw new Error(`sim wrote ${records.length} records to ${outPath} but ${runs} were requested — ` +
            `refusing to aggregate a truncated batch.`);
    }
    return records;
}

/** Parse a JSONL batch output, refusing any record from a different schema. */
export function parseSimRecords(text) {
    const records = text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    for (const r of records) {
        if (r.version !== SIM_SCHEMA_VERSION) {
            throw new Error(
                `sim record schema v${r.version}, expected v${SIM_SCHEMA_VERSION}. ` +
                `Aggregating across a schema change silently averages fields whose meaning moved.`
            );
        }
    }
    return records;
}

export function pct(n, total) { return total === 0 ? 0 : Math.round((n / total) * 1000) / 10; }
export function mean(xs) { return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length; }
export function median(xs) {
    if (xs.length === 0) return 0;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
}

/**
 * Nearest-rank, no interpolation: sorted[floor(q*n)], clamped. Deliberately the
 * SAME convention as the game-side sweep tools (a real game's sweep script `_pct`),
 * and consistent with `median` above at q=0.5 — when a certification
 * cross-checks this report against a game-side sweep over the same records, a
 * half-Air disagreement must mean the data differs, never the quantile.
 */
export function quantile(xs, q) {
    if (xs.length === 0) return 0;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

/** Read "a.b.c" out of a nested object, tolerating a missing branch. */
export function readPath(obj, pathExpr) {
    return pathExpr.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

export function summarise(records, metricPaths) {
    const outcomes = {};
    for (const r of records) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;

    const hpFractions = records
        .map((r) => r.state?.player?.hp_fraction)
        .filter((v) => typeof v === "number");

    // Optional adapter field, reported when present. It exists because the first
    // real comparison this tool ran returned "30/30 LOST, mean hp_fraction 1.0",
    // which reads as a broken metric — every one of those deaths was starvation,
    // and HP was never going to say so. If your game can lose in more than one
    // way, put the reason in state and it shows up here.
    const causes = {};
    for (const r of records) {
        const cause = r.state?.death_cause;
        if (cause) causes[cause] = (causes[cause] ?? 0) + 1;
    }

    return {
        runs: records.length,
        outcomes,
        ...(Object.keys(causes).length ? { death_causes: causes } : {}),
        win_rate_pct: pct(outcomes.WON ?? 0, records.length),
        turns_mean: Math.round(mean(records.map((r) => r.turns))),
        turns_median: median(records.map((r) => r.turns)),
        // The headline difficulty number. See the note at the top of this file.
        hp_fraction_mean: Math.round(mean(hpFractions) * 1000) / 1000,
        hp_fraction_median: Math.round(median(hpFractions) * 1000) / 1000,
        // Health of the MEASUREMENT, not of the game. A non-zero rejection count
        // means legal_moves() offered something dispatch() refused, so the runs
        // above are partly measuring a broken adapter.
        rejections_total: records.reduce((a, r) => a + r.rejected, 0),
        errored_runs: records.filter((r) => r.error).length,
        errors: records.filter((r) => r.error).map((r) => ({ seed: r.seed, error: r.error })),
        ms_per_run: Math.round(mean(records.map((r) => r.duration_ms))),
        ...summariseMetrics(records, metricPaths),
    };
}

/**
 * Game-declared aggregates, from `sim_metrics` in playtest.config.json:
 *
 *   "sim_metrics": ["resources.lifetime_scrap", "systems.repaired_this_run_count"]
 *
 * Everything above this line describes a game that can be won, lost, and killed
 * in — which is most games and not all of them. An idle game has no win rate and
 * no residual HP; its pacing lives in "how much had you earned by minute 15" and
 * "how many systems were repaired". Reporting only the built-in fields for such a
 * game produces a table of zeroes that looks like a broken harness.
 *
 * The built-ins stay because they are the ones with published grounding
 * (residual HP tracking human difficulty). These are unweighted: mean and median
 * of whatever numeric path you name.
 */
export function summariseMetrics(records, metricPaths) {
    if (!metricPaths?.length) return {};
    const metrics = {};
    for (const pathExpr of metricPaths) {
        const raw = records.map((r) => readPath(r.state, pathExpr));
        const nums = raw.filter((v) => typeof v === "number");
        // Strings and booleans aggregate as a SHARE TABLE rather than not at
        // all. This is how a per-stratum §7 row reaches this tool (a real
        // certification case): "share of losses landing on the boss" is not a mean of
        // anything — it is the share of a categorical key the game emits
        // ("s2-boss"). The game derives the category, because only the game
        // knows what a boss is; this side only counts.
        const cats = raw.filter((v) => typeof v === "string" || typeof v === "boolean").map(String);

        if (nums.length && cats.length) {
            // One path, two types, is a measurement bug — averaging the numeric
            // half would silently drop the runs that disagree about what the
            // field IS.
            metrics[pathExpr] = { error: `path is a number in ${nums.length} run(s) and a string/bool in ${cats.length} — one field, one type` };
            continue;
        }
        if (!nums.length && !cats.length) {
            // Naming a path that never resolves is a config bug, and a silent
            // omission here reads as "the game didn't do that" rather than
            // "nobody measured it". An ARRAY gets its own message because the
            // fix is different: dotted numeric segments address elements
            // (`run.air_at_boss_by_act.2` is the act-3 entry), and a run whose
            // array is too short simply drops out of that element's sample —
            // which is exactly the §7 conditioning "of the runs that reached
            // boss 3", with `n` and `present_pct` reporting the conditional
            // sample rather than hiding it.
            if (raw.some((v) => Array.isArray(v))) {
                metrics[pathExpr] = { error: `path resolves to an array; address one element per metric — "${pathExpr}.0", "${pathExpr}.1", ...` };
                continue;
            }
            // An ELEMENT path that resolved for zero runs is not a typo when
            // its parent is an array somewhere: it is a measured zero — the
            // first real batch after this shape landed had two Squall runs,
            // neither reached boss 1, and ".0" reported a config error about a
            // reach share of 0%. n and present_pct say so; no mean/median,
            // because statistics over nobody would have to lie to exist (a
            // quartile target against this correctly FAILS as missing — there
            // is no Air to certify when nothing arrived).
            const lastDot = pathExpr.lastIndexOf(".");
            const parentIsArray = lastDot !== -1 && /^\d+$/.test(pathExpr.slice(lastDot + 1))
                && records.some((r) => Array.isArray(readPath(r.state, pathExpr.slice(0, lastDot))));
            metrics[pathExpr] = parentIsArray
                ? { n: 0, present_pct: 0 }
                : { error: "path missing from state in every run" };
            continue;
        }

        // The share of runs where the path resolved AT ALL. For an
        // always-present field this is 100 and says nothing; for a conditional
        // one it is itself the metric — `run.air_at_boss_by_act.2` present in
        // 61% of runs IS the reach-boss-3 share.
        const present_pct = pct(nums.length + cats.length, records.length);

        if (cats.length) {
            const counts = {};
            for (const c of cats) counts[c] = (counts[c] ?? 0) + 1;
            // Shares are out of the PRESENT runs, not all runs: a death key
            // absent on wins should read "62% of losses hit the boss", not a
            // number diluted by the runs that never died. present_pct carries
            // the base, so nothing is hidden by the choice.
            metrics[pathExpr] = {
                n: cats.length,
                present_pct,
                shares: Object.fromEntries(Object.entries(counts)
                    .sort((a, b) => b[1] - a[1])
                    .map(([k, v]) => [k, pct(v, cats.length)])),
            };
            continue;
        }

        metrics[pathExpr] = {
            mean: Math.round(mean(nums) * 1000) / 1000,
            median: Math.round(median(nums) * 1000) / 1000,
            // §7-shaped bands are quartile bands ("the IQR sits inside 40–60"),
            // so a summary without quartiles cannot carry a certification row —
            // which is why a real per-stratum plan could not run through matrix mode.
            p25: quantile(nums, 0.25),
            p75: quantile(nums, 0.75),
            min: Math.min(...nums),
            max: Math.max(...nums),
            n: nums.length,
            present_pct,
        };
    }
    return { metrics };
}

/**
 * Run the same seeds twice and compare state hashes. This is not a nice-to-have:
 * an unseeded RNG stream anywhere in the game turns every aggregate above into
 * noise, and the failure is invisible — the numbers still look plausible. On the
 * first game this ran against, three separate RNG streams needed seeding, and
 * two of them were only found by this check.
 */
export function compareDeterminism(a, b) {
    // Pairing is BY POSITION but verified BY SEED: if the two arms emitted
    // records in different orders, that is itself an anomaly this check must
    // surface, not silently mis-pair. And the terminal hash alone claims less
    // than "deterministic" — two runs can converge on one final hash having
    // taken different paths, so outcome and turn count are compared too.
    const rows = a.map((x, i) => ({
        seed: x.seed,
        match: Boolean(b[i]) && x.seed === b[i].seed && x.state_hash === b[i].state_hash
            && x.outcome === b[i].outcome && x.turns === b[i].turns,
        a: x.state_hash,
        b: b[i]?.state_hash ?? null,
    }));
    return { all_match: rows.length === b.length && rows.every((r) => r.match), diverged: rows.filter((r) => !r.match), rows };
}

/**
 * H-3: matrix mode. One invocation sweeps policy x variant (a variant is a
 * labelled set of game-side flags -- a difficulty profile, an act cap) and
 * produces ONE consolidated report with a per-cell verdict against declared
 * targets, and per-cell determinism when asked.
 *
 * SEED WINDOWS DO NOT OVERLAP BETWEEN CELLS. Each cell takes its own
 * `runs`-wide slice starting at `seed`, in cell order, and the report states
 * both the per-cell windows and the full span -- the ledger unit users
 * account in. Two cells sharing seeds would look "paired" while differing on
 * two axes at once, which is not a comparison anyone can read.
 */
export function resolveMatrix(raw, defaults = {}) {
    const runs = Number(raw.runs ?? defaults.runs ?? 50);
    const seed = Number(raw.seed ?? defaults.seed ?? 1);
    const policies = raw.policies;
    const variants = raw.variants ?? [{ label: "base", game_args: [] }];
    if (!Array.isArray(policies) || policies.length === 0) {
        throw new Error("matrix: `policies` must be a non-empty array");
    }
    if (!Array.isArray(variants) || variants.length === 0) {
        throw new Error("matrix: `variants` must be a non-empty array");
    }
    const seen = new Set();
    for (const v of variants) {
        if (!v.label) throw new Error("matrix: every variant needs a `label`");
        if (seen.has(v.label)) throw new Error(`matrix: duplicate variant label '${v.label}'`);
        seen.add(v.label);
        if (v.game_args !== undefined && !Array.isArray(v.game_args)) {
            throw new Error(`matrix: variant '${v.label}' game_args must be an array of flags`);
        }
    }
    const cells = [];
    let i = 0;
    for (const policy of policies) {
        for (const v of variants) {
            const first = seed + i * runs;
            cells.push({
                id: `${policy}/${v.label}`, policy, variant: v.label,
                gameArgs: v.game_args ?? [], runs, seed: first,
                seedWindow: { first, last: first + runs - 1 },
            });
            i++;
        }
    }
    return {
        runs, seed, cells,
        verifyDeterminism: Boolean(raw.verify_determinism),
        targets: raw.targets ?? {},
        seedWindow: { first: seed, last: seed + cells.length * runs - 1 },
    };
}

/**
 * Resolve one target expression against a cell summary.
 *
 * `readPath` alone CANNOT do this, and until 2026-08-18 cellVerdict used it
 * alone: declared metrics are stored under their full dotted path as ONE key
 * (`summary.metrics["run.air"]`), so splitting "metrics.run.air.mean" on every
 * dot walks into `metrics.run` and finds nothing. The doc-comment's own example
 * never resolved — every metrics.* target ever written would have FAILED as
 * "missing". Loud, so no verdict lied; but it means no game-declared metric was
 * ever usable as a matrix target, which is half of why a real per-stratum plan
 * bypassed matrix mode. Resolution: longest declared-path match first, then the
 * remainder (a stat name, or `shares.<value>`) inside that entry.
 *
 * A share the table does not list is 0, not missing: "0% of losses hit the
 * boss" is a measured answer, and failing it as absent would make a band with a
 * 0 lower bound unsatisfiable exactly when the game is at its cleanest.
 */
export function readSummaryStat(summary, expr) {
    const direct = readPath(summary, expr);
    if (typeof direct === "number") return direct;
    if (expr.startsWith("metrics.") && summary?.metrics) {
        const rest = expr.slice("metrics.".length);
        const keys = Object.keys(summary.metrics).sort((a, b) => b.length - a.length);
        for (const key of keys) {
            if (!rest.startsWith(key + ".")) continue;
            const entry = summary.metrics[key];
            const stat = rest.slice(key.length + 1);
            const value = readPath(entry, stat);
            if (typeof value === "number") return value;
            if (stat.startsWith("shares.") && entry?.shares && typeof entry.shares === "object"
                && !(stat.slice("shares.".length) in entry.shares)) return 0;
            return undefined;
        }
    }
    return undefined;
}

/**
 * One cell against its target bands: each key is a stat expression into the
 * cell's summary, each value [lo, hi] inclusive. A missing metric FAILS rather
 * than passing vacuously -- a target against a number that stopped being
 * reported is drift, not success.
 *
 * The expressions §7-shaped rows need, all real:
 *   "win_rate_pct":                                    [5, 20]
 *   "metrics.run.air_at_boss_by_act.2.p75":            [40, 60]   Air IQR cap, boss 3
 *   "metrics.run.air_at_boss_by_act.2.present_pct":    [55, 85]   reach share, boss 3
 *   "metrics.run.death_key.shares.s2-boss":            [40, 70]   boss-loss share, stratum 2
 * The middle two live on the same declared metric; the last needs the game to
 * emit the categorical key, because only the game knows what a boss is.
 */
export function cellVerdict(summary, bands) {
    const failures = [];
    for (const [metric, band] of Object.entries(bands ?? {})) {
        const value = readSummaryStat(summary, metric);
        if (typeof value !== "number") {
            failures.push({ metric, value: null, band, reason: "metric missing from summary" });
            continue;
        }
        // A band that is not exactly [lo, hi] with two finite numbers must FAIL,
        // not pass: `[20]` destructures to hi === undefined, and `value > undefined`
        // is false for every value — a certification row that was never actually
        // checked would green-light itself. Same doctrine as the missing-metric
        // case above: fail rather than pass vacuously.
        if (!Array.isArray(band) || band.length !== 2 || !Number.isFinite(band[0]) || !Number.isFinite(band[1])) {
            failures.push({ metric, value, band, reason: "malformed band — expected [lo, hi], two finite numbers" });
            continue;
        }
        const [lo, hi] = band;
        if (value < lo || value > hi) failures.push({ metric, value, band });
    }
    return { pass: failures.length === 0, targets_defined: Boolean(bands && Object.keys(bands).length), failures };
}

/**
 * Everything the CLI decides before any engine boots, in one testable place:
 * defaults, the seed window the batch will consume ([seed, seed+runs-1] —
 * the ledger unit this repo's users account in), the policy list, and where
 * the game-declared metric paths come from.
 */
export function resolveBatchOptions(opts, cwd = process.cwd()) {
    const gameDir = resolve(opts.game ?? cwd);
    const runs = Number(opts.runs ?? 50);
    const seed = Number(opts.seed ?? 1);
    const maxTurns = Number(opts["max-turns"] ?? 2000);
    const outDir = resolve(opts.out ?? join(gameDir, "runs", "sim"));
    // Declared by the game, because only the game knows what its pacing looks
    // like. --metrics overrides for a one-off question.
    // A game can have the sim tier without the browser tier, so the config is
    // read if present and its absence is not an error. Making it mandatory here
    // broke a game whose harness config lives elsewhere entirely — the sim tier
    // needs nothing from that file but this one optional key.
    const metricPaths = opts.metrics
        ? String(opts.metrics).split(",").map((m) => m.trim())
        : (() => {
            const configPath = join(gameDir, "playtest.config.json");
            if (!existsSync(configPath)) return [];
            return JSON.parse(readFileSync(configPath, "utf8")).sim_metrics ?? [];
        })();
    const policies = String(opts.compare ?? opts.policy ?? "random").split(",").map((s) => s.trim());
    // A real fix: the game-args passthrough existed, was documented, and
    // was wired to exactly one caller — resolveMatrix. Outside matrix mode
    // `--tier=` had no route to the game, so no per-tier floor could be
    // measured through this tool. `--game-arg=--tier=hard`, repeatable, in
    // order. In matrix mode these PREPEND to every cell's variant args: the CLI
    // flag is the hold-this-fixed axis, the variant is the varied one.
    const gameArgs = [].concat(opts["game-arg"] ?? []).filter((v) => typeof v === "string");
    return {
        gameDir, runs, seed, maxTurns, outDir, metricPaths, policies, gameArgs,
        seedWindow: { first: seed, last: seed + runs - 1 },
    };
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const { gameDir, runs, seed, maxTurns, outDir, metricPaths: METRIC_PATHS, policies, gameArgs } = resolveBatchOptions(opts);
    mkdirSync(outDir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");

    // Each --verify-* flag is a complete mode that exits when done. Accepting
    // both and running only whichever branch comes first would silently drop
    // the other check — the caller believes both properties were verified.
    if (opts["verify-isolation"] && opts["verify-determinism"]) {
        console.error("ERROR: --verify-isolation and --verify-determinism are separate modes; run them one at a time.");
        process.exit(2);
    }

    if (opts["verify-isolation"]) {
        // Determinism and isolation are DIFFERENT properties, and the first does
        // not imply the second. --verify-determinism runs the same batch twice
        // and compares; if reset() leaks state between runs, BOTH batches leak
        // identically and it passes clean. That is not hypothetical — an idle
        // game's altitude climbed monotonically across six "independent" runs
        // (150, 300, ... 900) while determinism reported OK, because the
        // adapter's reset() rebuilt the scene but never reset the autoloads
        // holding that value.
        //
        // This check asks the only question that catches it: does the last seed
        // in a batch reach the same state when it is run ALONE?
        const policy = String(opts.policy ?? "random");
        const shared = { gameDir, maxTurns, policy, gameArgs, trace: false };
        const batched = await runBatch({ ...shared, runs, seed, outPath: join(outDir, `iso-batch-${stamp}.jsonl`) });
        const lastSeed = batched[batched.length - 1].seed;
        const [alone] = await runBatch({ ...shared, runs: 1, seed: lastSeed, outPath: join(outDir, `iso-alone-${stamp}.jsonl`) });
        const inBatch = batched[batched.length - 1];
        const ok = inBatch.state_hash === alone.state_hash;
        console.log(JSON.stringify(ok
            ? { isolation: "OK", seed: lastSeed, position_in_batch: batched.length }
            : {
                isolation: "FAILED",
                seed: lastSeed,
                detail: "this seed reaches a different state as run #" + batched.length +
                        " of a batch than it does run alone — reset() is leaking state between runs, " +
                        "and every aggregate from a batch is contaminated by run order",
                hash_in_batch: inBatch.state_hash,
                hash_alone: alone.state_hash,
            }, null, 2));
        process.exit(ok ? 0 : 1);
    }

    if (opts["verify-determinism"]) {
        const policy = String(opts.policy ?? "random");
        const shared = { gameDir, runs, seed, policy, maxTurns, gameArgs, trace: false };
        const a = await runBatch({ ...shared, outPath: join(outDir, `det-a-${stamp}.jsonl`) });
        const b = await runBatch({ ...shared, outPath: join(outDir, `det-b-${stamp}.jsonl`) });
        const result = compareDeterminism(a, b);
        console.log(JSON.stringify(result.all_match
            ? { determinism: "OK", runs: a.length }
            : { determinism: "FAILED", diverged: result.diverged }, null, 2));
        process.exit(result.all_match ? 0 : 1);
    }

    if (opts.matrix) {
        const matrix = resolveMatrix(JSON.parse(readFileSync(String(opts.matrix), "utf8")), { runs, seed });
        const report = {
            generated: stamp, game: gameDir, mode: "matrix",
            ...(gameArgs.length ? { cli_game_args: gameArgs } : {}),
            seed_window: matrix.seedWindow, cells: {},
        };
        let allPass = true;
        for (const cell of matrix.cells) {
            const slug = `${cell.policy}-${cell.variant}`;
            const outPath = join(outDir, `matrix-${slug}-${stamp}.jsonl`);
            const shared = { gameDir, runs: cell.runs, seed: cell.seed, policy: cell.policy, maxTurns, gameArgs: [...gameArgs, ...cell.gameArgs], trace: false };
            const records = await runBatch({ ...shared, outPath });
            const summary = summarise(records, METRIC_PATHS);
            // Per-cell targets first, `*` as the family fallback.
            const verdict = cellVerdict(summary, matrix.targets[cell.id] ?? matrix.targets["*"]);
            let determinism = null;
            if (matrix.verifyDeterminism) {
                const again = await runBatch({ ...shared, outPath: join(outDir, `matrix-${slug}-b-${stamp}.jsonl`) });
                determinism = compareDeterminism(records, again).all_match ? "OK" : "FAILED";
                if (determinism !== "OK") { verdict.pass = false; verdict.failures.push({ metric: "determinism", reason: "arms diverged on identical seeds" }); }
            }
            if (!verdict.pass) allPass = false;
            report.cells[cell.id] = { seed_window: cell.seedWindow, game_args: cell.gameArgs, ...summary, verdict, determinism, jsonl: outPath };
            console.log(`${cell.id}: ${verdict.pass ? "PASS" : "FAIL"}${determinism ? ` (determinism ${determinism})` : ""}  win ${summary.win_rate_pct}%  seeds ${cell.seedWindow.first}-${cell.seedWindow.last}${verdict.targets_defined ? "" : "  (no targets declared)"}`);
        }
        // A plan whose target keys match NO cell must not read as green: with
        // every key typo'd (and no "*" fallback) each cell prints "(no targets
        // declared)" and the run exits 0 — an entirely mis-keyed certification
        // plan producing a fully passing CI run. Unmatched keys are a plan
        // error, and a plan error fails the run.
        const cellIds = new Set(matrix.cells.map((c) => c.id));
        const unmatchedTargets = Object.keys(matrix.targets ?? {}).filter((k) => k !== "*" && !cellIds.has(k));
        if (unmatchedTargets.length > 0) {
            allPass = false;
            report.unmatched_targets = unmatchedTargets;
            console.error(`ERROR: targets declared for cells that do not exist: ${unmatchedTargets.join(", ")}\n` +
                `       cells in this plan: ${[...cellIds].join(", ")}`);
        }
        const reportPath = join(outDir, `matrix-${stamp}.json`);
        writeFileSync(reportPath, JSON.stringify(report, null, 2));
        console.log(`
matrix report: ${reportPath}`);
        process.exit(allPass ? 0 : 1);
    }

    const report = { generated: stamp, game: gameDir, runs, seed, max_turns: maxTurns,
        ...(gameArgs.length ? { game_args: gameArgs } : {}), policies: {} };

    for (const policy of policies) {
        const outPath = join(outDir, `${policy}-${stamp}.jsonl`);
        const records = await runBatch({ gameDir, runs, seed, policy, maxTurns, outPath, gameArgs, trace: Boolean(opts.trace) });
        report.policies[policy] = { ...summarise(records, METRIC_PATHS), jsonl: outPath };
    }

    if (policies.length > 1) {
        // A ratio between policies is the comparison that survives the fact that
        // an agent is not a player. Reported against the FIRST policy listed, so
        // put the baseline first.
        const [baseName, ...rest] = policies;
        const base = report.policies[baseName];
        report.ratios = Object.fromEntries(rest.map((p) => [
            `${p}/${baseName}`,
            {
                turns: base.turns_mean === 0 ? null : Math.round((report.policies[p].turns_mean / base.turns_mean) * 100) / 100,
                hp_fraction: base.hp_fraction_mean === 0 ? null : Math.round((report.policies[p].hp_fraction_mean / base.hp_fraction_mean) * 100) / 100,
                // The ratio is the point for declared metrics too — "the builder
                // earns 12x what idling does" is the shape of claim that survives
                // an agent not playing like a person.
                ...Object.fromEntries(METRIC_PATHS.map((m) => {
                    const b = base.metrics?.[m]?.mean, o = report.policies[p].metrics?.[m]?.mean;
                    return [m, (typeof b === "number" && typeof o === "number" && b !== 0)
                        ? Math.round((o / b) * 100) / 100 : null];
                })),
            },
        ]));
    }

    const reportPath = join(outDir, `batch-${stamp}.json`);
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    console.log(`\nreport: ${reportPath}`);
}

// Import-safe: running a batch on import is how a "--help" probe once burnt a
// two-thousand-seed ledger window. main() fires only when this file IS the program.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((err) => { console.error(err.message); process.exit(1); });
}
