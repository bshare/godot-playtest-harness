#!/usr/bin/env node
/**
 * export_build.mjs — produce the web debug export, so "have a web export"
 * stops being a prerequisite the user satisfies by hand.
 *
 *   node src/export_build.mjs                         # from the game repo root
 *   node src/export_build.mjs --preset "Web" --project . --dry-run
 *   node src/export_build.mjs --config path/to/playtest.config.json
 *
 * Reads playtest.config.json (in cwd, or wherever --config points), finds a
 * Godot binary, and runs:
 *
 *   <godot> --headless --path <project> --export-debug <preset> <build_dir>/index.html
 *
 * Debug export, always — the bridge only registers when OS.is_debug_build()
 * is true, and a release export is what players receive, never what this
 * harness drives (see README "Security"). There is deliberately no
 * --export-release option here.
 *
 * Binary lookup order: the GODOT_BIN environment variable, then `godot` and
 * `godot4` on PATH (with .exe/.cmd/.bat tried on Windows, where the shell's
 * PATHEXT resolution doesn't apply to a no-shell spawn). Godot installs are
 * unusually often NOT on PATH — a downloaded zip run from Downloads/, or
 * Steam — which is why GODOT_BIN exists and why the not-found error spells
 * out both options instead of just saying "not found".
 *
 * The export preset must already exist in the game's export_presets.cfg with
 * thread_support OFF (the harness's server sends no COOP/COEP headers, so a
 * threaded build hangs the boot silently — see SETUP_SKILL.md). This tool
 * runs the preset; creating it is the `init` scaffold's job (ROADMAP.md
 * Tier 1 item 3).
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./batch.mjs";

/**
 * Find a Godot binary: GODOT_BIN wins outright (trusted as given — if it's
 * wrong, the export fails with Godot's own error, which names the path), then
 * a PATH scan for godot/godot4. Returns null rather than throwing, so the
 * caller decides whether "none" is fatal (a real export) or fine (--dry-run).
 */
export function locateGodot(env = process.env) {
    if (env.GODOT_BIN) return env.GODOT_BIN;
    const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
    const exts = process.platform === "win32" ? [".exe", ""] : [""];
    // .cmd/.bat deliberately NOT scanned: Node spawn() without a shell cannot
    // execute batch files (EINVAL), and adding shell:true would reopen the
    // argument-injection risk this file documents. A batch-file-only install
    // falls through to the "none found" error, which names the env override.
    for (const name of ["godot", "godot4"]) {
        for (const dir of dirs) {
            for (const ext of exts) {
                const candidate = path.join(dir, name + ext);
                if (existsSync(candidate)) return candidate;
            }
        }
    }
    return null;
}

/**
 * Everything decided before anything runs, in one testable place — the same
 * shape as play_run.mjs's resolveConfig. Precedence: flag over config over
 * default. Throws (rather than exiting) on a missing or unreadable config so
 * tests can assert the message.
 */
export function resolveExport({ argv = [], cwd = process.cwd() } = {}) {
    const opts = parseArgs(argv);
    const configPath = opts.config
        ? path.resolve(cwd, String(opts.config))
        : path.join(cwd, "playtest.config.json");
    if (!existsSync(configPath)) {
        throw new Error(
            `playtest.config.json not found at ${configPath}\n` +
            `Run from the game repo root, or point --config at it.`,
        );
    }
    let config;
    try {
        config = JSON.parse(readFileSync(configPath, "utf8"));
    } catch (e) {
        throw new Error(`${configPath} is not valid JSON: ${e.message}`);
    }
    const gameRoot = path.dirname(configPath);
    // The Godot project usually IS the game repo root (project.godot next to
    // playtest.config.json), but not always — hence --project and the
    // optional godot_project config key.
    const project = path.resolve(gameRoot, String(opts.project ?? config.godot_project ?? "."));
    const preset = String(opts.preset ?? config.export_preset ?? "Web");
    const buildDir = path.resolve(gameRoot, config.build_dir ?? "build/web-debug");
    return {
        project,
        preset,
        buildDir,
        target: path.join(buildDir, "index.html"),
        dryRun: opts["dry-run"] === true,
        godotArgs: [
            "--headless",
            "--path", project,
            "--export-debug", preset,
            path.join(buildDir, "index.html"),
        ],
    };
}

function main() {
    let plan;
    try {
        plan = resolveExport({ argv: process.argv.slice(2) });
    } catch (e) {
        console.error(`ERROR: ${e.message}`);
        process.exit(2);
    }

    if (!existsSync(path.join(plan.project, "project.godot"))) {
        console.error(`ERROR: no project.godot in ${plan.project}`);
        console.error(`Point --project at the Godot project directory (or set "godot_project" in playtest.config.json).`);
        process.exit(2);
    }

    const godot = locateGodot();

    if (plan.dryRun) {
        // Print exactly what a real run would execute — with a placeholder
        // where the binary would go if none was found, since a dry run is
        // precisely for machines that can't run the real thing.
        console.log([godot ?? "<godot>", ...plan.godotArgs].join(" "));
        if (!godot) console.log("(no Godot binary found — set GODOT_BIN, or put godot/godot4 on PATH)");
        process.exit(0);
    }

    if (!godot) {
        console.error("ERROR: no Godot binary found.");
        console.error("Set GODOT_BIN to the executable's full path, or put `godot` or `godot4` on PATH.");
        console.error("(--dry-run prints the export command without needing a binary.)");
        process.exit(1);
    }

    // Godot writes into the target directory but does not create it.
    mkdirSync(plan.buildDir, { recursive: true });

    console.log(`Exporting preset "${plan.preset}" -> ${plan.target}`);
    const result = spawnSync(godot, plan.godotArgs, { stdio: "inherit" });
    if (result.error) {
        console.error(`ERROR: failed to launch ${godot}: ${result.error.message}`);
        process.exit(1);
    }
    process.exit(result.status ?? 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main();
}
