#!/usr/bin/env node
/**
 * godot-playtest — the one entry point, so a stranger types `npx godot-playtest`
 * instead of learning where a clone lives and setting PLAYTEST_HOME.
 *
 *   npx godot-playtest validate scenarios/*.json
 *   npx godot-playtest run scenarios/first_repair.json
 *   npx godot-playtest export --dry-run
 *
 * This file is deliberately a thin dispatcher: it maps a subcommand to the
 * script that already does the work, re-invokes node on it, and passes every
 * remaining argument through untouched. All behaviour, all flags, and all
 * documentation stay with the scripts themselves — a `--help` here tells you
 * which script you are about to run, not what it does.
 *
 * Windows is the reason for two choices that look fussy:
 *   - children are spawned as `process.execPath` (the running node binary),
 *     never the string "node", so the dispatch works regardless of PATH and
 *     under whichever node the user invoked;
 *   - arguments go through as an array with no shell, so paths with spaces
 *     and PowerShell's quoting rules never enter the picture.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The harness repo root — this file lives in bin/, the scripts in src/. */
export const HARNESS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The mapping table, exported so the test suite can assert every entry points
 * at a script that exists without spawning anything long-running.
 */
export const SUBCOMMANDS = {
    validate: {
        script: "src/run_scenario.mjs",
        prepend: ["--validate"],
        summary: "check scenarios statically — no browser, no build, no export",
    },
    run: {
        script: "src/run_scenario.mjs",
        summary: "run one scenario against the served debug export",
    },
    play: {
        script: "src/play_run.mjs",
        summary: "turn-by-turn browser play from legal_moves; --parity checks the sim tier",
    },
    batch: {
        script: "src/batch.mjs",
        summary: "N seeded sim-tier runs with an aggregate report",
    },
    coverage: {
        script: "src/coverage.mjs",
        summary: "what a pass of run bundles never touched",
    },
    diff: {
        script: "src/diff_run.mjs",
        summary: "semantic diff between two run bundles' states (or session snapshots)",
    },
    prune: {
        script: "src/prune_run.mjs",
        summary: "evidence retention — keep what the report cites, tombstone the rest",
    },
    sweep: {
        script: "src/sweep_runs.mjs",
        summary: "age and budget sweep over runs/",
    },
    export: {
        script: "src/export_build.mjs",
        summary: "produce the web debug export via godot --headless",
    },
    init: {
        script: "src/init.mjs",
        summary: "scaffold a game repo: addon, config, catalog, preset, smoke scenario",
    },
};

export function usage() {
    const lines = [
        "Usage: godot-playtest <subcommand> [args...]",
        "",
        "Subcommands:",
    ];
    for (const [name, def] of Object.entries(SUBCOMMANDS)) {
        lines.push(`  ${name.padEnd(10)}${def.summary}`);
    }
    lines.push("");
    lines.push("  --version print the harness version and exit");
    lines.push("");
    lines.push("Every subcommand forwards its remaining arguments to the underlying");
    lines.push("script unchanged; run one with --help (or read its header comment)");
    lines.push("for its flags. `node <harness>/src/<script>` still works identically.");
    return lines.join("\n");
}

/**
 * Pure decision step, separated from the spawn so it can be unit-tested:
 * argv in, one of {help, unknown, spawn} out.
 */
export function resolveInvocation(argv) {
    const [name, ...rest] = argv;
    if (name === undefined || name === "--help" || name === "-h" || name === "help") {
        return { kind: "help", explicit: name !== undefined };
    }
    if (name === "--version" || name === "-v" || name === "version") {
        return { kind: "version" };
    }
    const def = SUBCOMMANDS[name];
    if (!def) return { kind: "unknown", name };
    return {
        kind: "spawn",
        script: path.join(HARNESS_ROOT, def.script),
        args: [...(def.prepend ?? []), ...rest],
    };
}

function main() {
    const decision = resolveInvocation(process.argv.slice(2));

    if (decision.kind === "help") {
        // Asked-for help goes to stdout and exits 0; bare invocation is a
        // usage error and says so on stderr.
        if (decision.explicit) {
            console.log(usage());
            process.exit(0);
        }
        console.error(usage());
        process.exit(2);
    }

    if (decision.kind === "version") {
        // Read lazily so the common spawn path never touches package.json.
        const pkg = JSON.parse(readFileSync(path.join(HARNESS_ROOT, "package.json"), "utf8"));
        console.log(`godot-playtest ${pkg.version}`);
        process.exit(0);
    }

    if (decision.kind === "unknown") {
        console.error(`Unknown subcommand "${decision.name}".\n`);
        console.error(usage());
        process.exit(2);
    }

    const child = spawn(process.execPath, [decision.script, ...decision.args], {
        stdio: "inherit",
    });
    child.on("error", (err) => {
        console.error(`Failed to launch ${decision.script}: ${err.message}`);
        process.exit(1);
    });
    child.on("close", (code, signal) => {
        // A signal death has no exit code; 1 is the honest translation.
        process.exit(signal ? 1 : (code ?? 1));
    });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main();
}
