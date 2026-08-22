#!/usr/bin/env node
// sweep_runs.mjs — age and budget sweep over a runs/ directory.
//
// prune_run.mjs handles one finished bundle. This handles the accumulation:
// bundles whose report never arrived, and pruned bundles old enough that their
// findings are long closed. Enforced by the tool rather than remembered by an
// agent, because "remember to clean up" is not a policy.
//
// Reference point: the origin project reached 194 MB of committed playtest
// screenshots at 1–2 MB per capture. An unattended loop reaches that in days.

import path from "node:path";
import { existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveRunsRoot } from "./runs_guard.mjs";
import { parseArgs } from "./batch.mjs";

/**
 * A numeric CLI flag that REFUSES to default through a bad value. The bug
 * this replaces: the old hand-rolled `flag()` used `args.indexOf(name)`,
 * which never matches the `--name=value` form (parseArgs handles that
 * correctly), and on any unparseable value silently produced NaN — every
 * `> MAX_TOTAL_MB` comparison downstream is then always false, so a budget
 * rule intended to fire instead disables itself with no error at all. A
 * flag that is simply ABSENT still defaults normally; a flag that IS given
 * but is not a valid number is a hard error.
 */
function numericFlag(opts, name, dflt) {
    const raw = opts[name];
    if (raw === undefined) return dflt;
    if (raw === true) {
        throw new Error(`--${name} requires a numeric value (got no value — did it run into another flag?)`);
    }
    const n = Number(raw);
    if (Number.isNaN(n)) {
        throw new Error(`--${name} must be a number, got "${raw}"`);
    }
    return n;
}

/**
 * Everything decided before anything is swept, in one testable place — same
 * shape as play_run.mjs's resolveConfig and export_build.mjs's resolveExport.
 * Throws on a bad numeric flag rather than exiting, so tests can assert the
 * message; the CLI below turns that into a clean ERROR + exit 2.
 */
export function resolveSweepOptions({ argv = [], cwd = process.cwd() } = {}) {
    const opts = parseArgs(argv);
    return {
        runsDir: path.resolve(cwd, opts._[0] ?? "runs"),
        dryRun: opts["dry-run"] === true,
        maxTotalMb: numericFlag(opts, "max-total-mb", 2048),
        unprunedDays: numericFlag(opts, "unpruned-days", 7),
        prunedDays: numericFlag(opts, "pruned-days", 30),
    };
}

function main() {
    let cfg;
    try {
        cfg = resolveSweepOptions({ argv: process.argv.slice(2) });
    } catch (e) {
        console.error(`ERROR: ${e.message}`);
        process.exit(2);
    }
    const { runsDir, dryRun: DRY, maxTotalMb: MAX_TOTAL_MB, unprunedDays: UNPRUNED_DAYS, prunedDays: PRUNED_DAYS } = cfg;

    if (!existsSync(runsDir)) {
        console.log(`nothing to sweep — ${runsDir} does not exist`);
        process.exit(0);
    }
    // Guard: only ever operate on the project's OWN runs/ tree. See
    // runs_guard.mjs — the fix for the old "runs anywhere in the path" hole.
    try {
        resolveRunsRoot(runsDir, "root");
    } catch (e) {
        console.error(`ERROR: ${e.message}`);
        process.exit(2);
    }

    // A runs/ tree is live: another agent's run may be writing or deleting
    // entries while the sweep walks it. A file that vanishes between readdir
    // and stat counts as size 0 rather than killing the whole sweep.
    const dirSize = (p) => readdirSync(p, { withFileTypes: true }).reduce((n, e) => {
        const full = path.join(p, e.name);
        try {
            return n + (e.isDirectory() ? dirSize(full) : statSync(full).size);
        } catch {
            return n;
        }
    }, 0);

    const DAY = 86400000;
    const now = Date.now();

    const bundles = readdirSync(runsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
        .map((e) => {
            const full = path.join(runsDir, e.name);
            try {
                const pruned = existsSync(path.join(full, "MANIFEST.md"));
                return {
                    name: e.name,
                    full,
                    pruned,
                    ageDays: (now - statSync(full).mtimeMs) / DAY,
                    size: dirSize(full),
                };
            } catch {
                // Deleted between readdir and stat — no longer ours to sweep.
                return null;
            }
        })
        .filter(Boolean);

    const fmt = (b) => `${(b / 1024 / 1024).toFixed(1)} MB`;
    const total = bundles.reduce((n, b) => n + b.size, 0);

    const doomed = [];
    for (const b of bundles) {
        if (!b.pruned && b.ageDays > UNPRUNED_DAYS) {
            doomed.push({ ...b, why: `unpruned and ${b.ageDays.toFixed(0)}d old — the report is not coming` });
        } else if (b.pruned && b.ageDays > PRUNED_DAYS) {
            doomed.push({ ...b, why: `pruned and ${b.ageDays.toFixed(0)}d old` });
        }
    }

    // Over budget: drop the oldest *unpruned* bundles first — a pruned bundle has
    // already had its evidence selected, so it is worth more per byte.
    let projected = total - doomed.reduce((n, b) => n + b.size, 0);
    if (projected > MAX_TOTAL_MB * 1024 * 1024) {
        // MINIMUM-AGE FLOOR: age-based deletion has a stated policy window;
        // budget-based deletion must not quietly have none. A bundle created
        // today may have its report actively pending — being over budget is
        // not a reason to eat this morning's evidence. Bundles younger than a
        // day are never budget-swept; if the tree is still over budget after
        // sweeping everything older, that is reported, not forced.
        const rest = bundles
            .filter((b) => !doomed.some((d) => d.name === b.name) && b.ageDays >= 1)
            .sort((a, b) => (a.pruned === b.pruned ? b.ageDays - a.ageDays : a.pruned ? 1 : -1));
        for (const b of rest) {
            if (projected <= MAX_TOTAL_MB * 1024 * 1024) break;
            doomed.push({ ...b, why: `over the ${MAX_TOTAL_MB} MB budget` });
            projected -= b.size;
        }
        if (projected > MAX_TOTAL_MB * 1024 * 1024) {
            console.log(`  NOTE: still ${fmt(projected)} after sweeping everything eligible — bundles younger than a day are never budget-swept.`);
        }
    }

    console.log(`${DRY ? "[dry-run] " : ""}${runsDir}`);
    console.log(`  ${bundles.length} bundles, ${fmt(total)} total`);
    console.log(`  ${bundles.filter((b) => b.pruned).length} pruned, ${bundles.filter((b) => !b.pruned).length} unpruned`);

    if (doomed.length === 0) {
        console.log("  nothing to sweep");
        process.exit(0);
    }

    console.log(`\n  sweeping ${doomed.length}, freeing ${fmt(doomed.reduce((n, b) => n + b.size, 0))}:`);
    for (const d of doomed) console.log(`    ${d.name}  (${fmt(d.size)}) — ${d.why}`);

    if (DRY) {
        console.log("\n[dry-run] nothing changed.");
        process.exit(0);
    }
    for (const d of doomed) rmSync(d.full, { recursive: true, force: true });
    console.log(`\nswept ${doomed.length} bundles`);
}

// Import-safe: the sweep itself happens only when this file IS the program,
// so resolveSweepOptions is testable without ever touching a filesystem tree.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main();
}
