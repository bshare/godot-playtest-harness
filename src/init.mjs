#!/usr/bin/env node
/**
 * init.mjs — the `godot-playtest init` scaffold (ROADMAP.md Tier 1 item 3).
 *
 *   node src/init.mjs --project path/to/game        # default: cwd
 *   node src/init.mjs --dry-run                     # print the plan, change nothing
 *   node src/init.mjs --force                       # overwrite what already exists
 *
 * Encodes the deterministic 80% of skills/SETUP_SKILL.md as code, so pointing
 * this at a Godot 4.x game repo gets it from zero to runnable in minutes. The
 * skill keeps the judgment calls (boot sequence, semantic actions, the sim
 * tier); this file does only what a machine can decide from the files alone:
 *
 *   1. detect the project (project.godot, config/features, config/name)
 *   2. copy addons/playtest_bridge/ in, and enable the plugin in project.godot
 *   3. write playtest.config.json + an empty-skeleton playtest.actions.json
 *   4. write export_presets.cfg (thread_support OFF — the boot-hang trap), or
 *      audit an existing one for thread_support=true
 *   5. cover runs/ in .gitignore
 *   6. write scenarios/smoke.json, the smallest scenario that proves the loop
 *
 * Every step is idempotent and individually reported: "did" (or "would" under
 * --dry-run), "skipped-exists", or "needs-you" for the parts only a human (or
 * a Godot editor) can finish. Nothing here runs Godot; the final summary says
 * exactly what still has to happen and in what order.
 *
 * project.godot is edited SURGICALLY — the existing text is kept byte for byte
 * and only the [editor_plugins] enabled list is inserted or extended. Godot
 * rewrites this file itself on save with its own ordering and quoting; a
 * scaffold that reformatted the whole file would fight the editor and turn
 * every init into a wall-of-diff commit.
 *
 * Without --force, nothing that already exists is overwritten: conflicting
 * targets are reported and the run exits 1 naming each one. --force replaces
 * them. (project.godot and .gitignore are never "overwritten" in this sense —
 * they only ever gain the one missing entry, and skip when it is present.)
 */

import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./batch.mjs";

/** The harness repo root — this file lives in src/, the addon in addons/. */
export const HARNESS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PLUGIN_CFG_RES = "res://addons/playtest_bridge/plugin.cfg";
const PORT_RANGE = { first: 8060, last: 8079 };

// ---------------------------------------------------------------------------
// project.godot parsing — the two facts init needs, nothing more
// ---------------------------------------------------------------------------

/**
 * Pulls config/name and the 4.x feature string out of project.godot text.
 * Returns { name, version } with null for whichever is absent. Deliberately
 * regex-level, not a full INI parser: these are single well-known lines, and
 * a parser that normalizes the file is exactly what the surgical-edit rule
 * forbids ever writing back.
 */
export function parseProjectGodot(source) {
    const nameMatch = source.match(/^config\/name="((?:[^"\\]|\\.)*)"/m);
    let version = null;
    const featMatch = source.match(/^config\/features=PackedStringArray\(([^)]*)\)/m);
    if (featMatch) {
        for (const q of featMatch[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
            if (/^4\.\d+/.test(q[1])) { version = q[1]; break; }
        }
    }
    return { name: nameMatch ? nameMatch[1] : null, version };
}

// ---------------------------------------------------------------------------
// The surgical [editor_plugins] edit
// ---------------------------------------------------------------------------

/**
 * Returns { content, changed, how } where `content` is `source` with the
 * playtest_bridge plugin present in [editor_plugins]/enabled and every other
 * byte untouched. Three cases:
 *   - already listed            -> changed: false
 *   - enabled= line exists      -> the one line gains one entry
 *   - section/line missing      -> section and/or line appended, nothing moved
 * Line endings follow the file's own (CRLF-dominant files stay CRLF).
 */
export function enablePluginInProjectGodot(source) {
    if (source.includes(PLUGIN_CFG_RES)) {
        return { content: source, changed: false, how: "already enabled" };
    }
    const eol = source.includes("\r\n") ? "\r\n" : "\n";
    const lines = source.split("\n");

    // Locate the [editor_plugins] section header and its extent.
    let sectionStart = -1;
    let sectionEnd = lines.length; // exclusive; index of the NEXT section header
    for (let i = 0; i < lines.length; i++) {
        const stripped = lines[i].replace(/\r$/, "").trim();
        if (sectionStart === -1) {
            if (stripped === "[editor_plugins]") sectionStart = i;
        } else if (/^\[.*\]$/.test(stripped)) {
            sectionEnd = i;
            break;
        }
    }

    if (sectionStart === -1) {
        // No section: append one at EOF. Ensure exactly one blank line before
        // it and a trailing newline after, without touching existing bytes.
        let content = source;
        if (!content.endsWith("\n")) content += eol;
        content += `${eol}[editor_plugins]${eol}${eol}enabled=PackedStringArray("${PLUGIN_CFG_RES}")${eol}`;
        return { content, changed: true, how: "added [editor_plugins] section" };
    }

    // Section exists: find its enabled= line.
    for (let i = sectionStart + 1; i < sectionEnd; i++) {
        const stripped = lines[i].replace(/\r$/, "");
        const m = stripped.match(/^enabled=PackedStringArray\((.*)\)\s*$/);
        if (m) {
            const inner = m[1].trim();
            const addition = inner.length === 0
                ? `"${PLUGIN_CFG_RES}"`
                : `${m[1]}, "${PLUGIN_CFG_RES}"`;
            const hadCr = lines[i].endsWith("\r");
            lines[i] = `enabled=PackedStringArray(${addition})` + (hadCr ? "\r" : "");
            return { content: lines.join("\n"), changed: true, how: "extended enabled list" };
        }
    }

    // Section exists but no enabled= line: insert one just before the next
    // section (or EOF), after the section's existing content.
    let insertAt = sectionEnd;
    // Keep trailing blank lines of the section BELOW our insertion, so the
    // blank line separating this section from the next stays where it was.
    while (insertAt > sectionStart + 1 && lines[insertAt - 1].replace(/\r$/, "").trim() === "") {
        insertAt--;
    }
    const cr = eol === "\r\n" ? "\r" : "";
    lines.splice(insertAt, 0, `enabled=PackedStringArray("${PLUGIN_CFG_RES}")` + cr);
    return { content: lines.join("\n"), changed: true, how: "added enabled list to existing section" };
}

// ---------------------------------------------------------------------------
// Port picking — every game its own port (SETUP_SKILL §3)
// ---------------------------------------------------------------------------

/**
 * First free port in 8060-8079, where "used" is any port claimed by a
 * playtest.config.json this init can see: the project's siblings (the usual
 * several-games-in-one-workspace layout). The project's OWN config does not
 * count as used — init is about to (re)write it, and its old port blocking
 * its new port would make --force never converge.
 */
export function pickPort(projectDir) {
    const used = new Set();
    const parent = path.dirname(projectDir);
    let siblings = [];
    try {
        siblings = readdirSync(parent, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => path.join(parent, d.name));
    } catch { /* unreadable parent: nothing visible, nothing used */ }
    for (const dir of siblings) {
        if (path.resolve(dir) === path.resolve(projectDir)) continue;
        const cfg = path.join(dir, "playtest.config.json");
        if (!existsSync(cfg)) continue;
        try {
            const port = JSON.parse(readFileSync(cfg, "utf8")).port;
            if (Number.isInteger(port)) used.add(port);
        } catch { /* a sibling's broken config is not this game's problem */ }
    }
    for (let p = PORT_RANGE.first; p <= PORT_RANGE.last; p++) {
        if (!used.has(p)) return { port: p, exhausted: false };
    }
    return { port: PORT_RANGE.first, exhausted: true };
}

// ---------------------------------------------------------------------------
// Generated file contents
// ---------------------------------------------------------------------------

/** The starter catalog: deliberately EMPTY. The six generic-bridge actions
 *  (dump_controls, click_control, press_action, send_key, set_slider,
 *  select_tab) are runner built-ins — the validator and runner know them with
 *  no catalog entry at all. Re-declaring one here would *shadow* the built-in
 *  (catalog wins name collisions by design), and for dump_controls that
 *  shadowing silently drops the controls payload from the manifest: the
 *  catalog path records only the summary result, never reading the tree var.
 *  Found live on the first real-game init:
 *  `count: 23, success: true` in the manifest — and no controls anywhere.
 *  The catalog is for the game's own semantic actions; add those here. */
export function starterCatalog(gameName) {
    return {
        catalog_version: 1,
        game: gameName,
        note: "The generic-bridge actions are runner built-ins; do NOT re-declare them here — a catalog entry shadows the built-in and dump_controls loses its payload. This catalog is for the game's own semantic actions.",
        actions: {},
        // Legality of these never depends on game state — see ACTION_CATALOG.md.
        state_independent: ["dump_controls", "dump_state", "screenshot"],
        runner_actions: {},
    };
}

export function starterConfig(gameName, port) {
    return {
        game: gameName,
        action_catalog: "playtest.actions.json",
        build_dir: "build/web-debug",
        runs_dir: "runs",
        port,
        boot_sequence: [],
    };
}

/** The smallest scenario that proves the loop: the generic bridge answers, a
 *  screenshot lands, and state dumps. `expect` makes step 1 a real assertion,
 *  so --validate passes it with zero warnings. */
export function starterScenario() {
    return {
        name: "smoke",
        note: "Generated by godot-playtest init: proves the generic bridge answers. Replace with real steps once you know the game's verbs.",
        stop_on_failure: true,
        steps: [
            { action: "dump_controls", label: "controls", expect: "success" },
            { action: "screenshot", label: "boot" },
            { action: "dump_state", label: "state" },
        ],
    };
}

/**
 * Minimal Web debug preset, the shape from examples/dodge-the-creeps —
 * embedded rather than read from examples/ because the npm package does not
 * ship examples/. variant/thread_support=false is the line that matters: a
 * threaded web export needs COOP/COEP headers the harness's server does not
 * send, and hangs the boot silently (SETUP_SKILL.md §3).
 */
export const EXPORT_PRESET_TEMPLATE = `[preset.0]

name="Web"
platform="Web"
runnable=true
advanced_options=false
dedicated_server=false
custom_features=""
export_filter="all_resources"
include_filter=""
exclude_filter="playtest.*.json,scenarios/*"
export_path=""
encryption_include_filters=""
encryption_exclude_filters=""
encrypt_pck=false
encrypt_directory=false
script_export_mode=2

[preset.0.options]

custom_template/debug=""
custom_template/release=""
variant/extensions_support=false
variant/thread_support=false
vram_texture_compression/for_desktop=true
vram_texture_compression/for_mobile=false
html/export_icon=true
html/custom_html_shell=""
html/head_include=""
html/canvas_resize_policy=2
html/focus_canvas_on_start=true
html/experimental_virtual_keyboard=false
progressive_web_app/enabled=false
`;

/** True if any line of .gitignore already covers runs/ at the repo root. */
export function gitignoreCoversRuns(text) {
    return text.split("\n").some((line) => {
        const t = line.replace(/\r$/, "").trim();
        return t === "runs" || t === "runs/" || t === "/runs" || t === "/runs/";
    });
}

// ---------------------------------------------------------------------------
// The init run itself
// ---------------------------------------------------------------------------

const ADDON_FILES = ["playtest_bridge.gd", "plugin.cfg", "plugin.gd", "README.md"];

/**
 * Performs (or, with dryRun, plans) the whole scaffold. Never calls
 * process.exit and never writes under dryRun — main() below owns the process.
 *
 * Returns { ok, exitCode, steps, nextSteps } where steps is
 * [{ id, status, detail }] with status one of:
 *   "did"            wrote/changed it (under dryRun: would)
 *   "skipped-exists" already in the wanted state, nothing to do
 *   "refused"        exists and differs; --force required
 *   "needs-you"      a fact or fix only a human/editor can supply
 *   "error"          the run cannot proceed (missing project.godot)
 */
export function runInit({ projectDir, harnessRoot = HARNESS_ROOT, dryRun = false, force = false } = {}) {
    const project = path.resolve(projectDir ?? process.cwd());
    const steps = [];
    const nextSteps = [];
    const would = dryRun ? "would " : "";

    // -- a. Detect the Godot project ----------------------------------------
    const projectGodotPath = path.join(project, "project.godot");
    if (!existsSync(projectGodotPath)) {
        steps.push({
            id: "detect", status: "error",
            detail: `no project.godot at ${projectGodotPath} — point --project at the Godot project directory (the one containing project.godot)`,
        });
        return { ok: false, exitCode: 2, steps, nextSteps, refusals: [], hardErrors: [] };
    }
    const projectGodotSource = readFileSync(projectGodotPath, "utf8");
    const { name: configName, version } = parseProjectGodot(projectGodotSource);
    const gameName = configName ?? path.basename(project);
    if (version) {
        steps.push({ id: "detect", status: "did", detail: `Godot ${version} project "${gameName}" at ${project}` });
    } else {
        steps.push({
            id: "detect", status: "needs-you",
            detail: `project "${gameName}" found, but no 4.x version string in config/features — ` +
                `this harness targets Godot 4.x (the addon uses JavaScriptBridge; 3.x has a different singleton). Confirm the engine version.`,
        });
    }

    // Conflicts are collected first so one refusal message can name them all.
    const refusals = [];
    function writeTarget(id, relPath, content, describe) {
        const target = path.join(project, relPath);
        if (existsSync(target) && !force) {
            steps.push({ id, status: "refused", detail: `${relPath} already exists — pass --force to overwrite` });
            refusals.push(relPath);
            return false;
        }
        const existed = existsSync(target);
        // --force overwrites, but never destroys: the file being replaced is
        // where a game's hand-built catalog and edited scenarios live, and
        // replacing months of semantic actions with a starter skeleton is
        // irreversible outside git. A .bak is written ONLY when the content
        // actually changes — a re-run over identical files stays idempotent
        // (this is a fumble-guard, not a history; each overwrite replaces the
        // previous .bak).
        const changed = !existed || readFileSync(target, "utf8") !== content;
        if (!dryRun) {
            mkdirSync(path.dirname(target), { recursive: true });
            if (existed && changed) copyFileSync(target, `${target}.bak`);
            writeFileSync(target, content);
        }
        const verb = !existed ? `write ${relPath}`
            : changed ? `overwrite ${relPath} (previous saved to ${relPath}.bak)`
            : `rewrite ${relPath} (unchanged)`;
        steps.push({ id, status: "did", detail: `${would}${verb}${describe ? ` — ${describe}` : ""}` });
        return true;
    }

    // -- b. Copy the addon and enable the plugin ----------------------------
    // hardErrors, unlike refusals, are not "you need --force" — they are a
    // step that plainly couldn't be done (a source file missing, a
    // permission error, a full disk). Either way this tool's whole design is
    // "always produce a report"; an unguarded cpSync that throws a raw stack
    // would break that promise instead of just reporting a failed step.
    const hardErrors = [];
    const addonSrc = path.join(harnessRoot, "addons", "playtest_bridge");
    const addonDest = path.join(project, "addons", "playtest_bridge");
    if (existsSync(addonDest) && !force) {
        steps.push({ id: "addon", status: "refused", detail: `addons/playtest_bridge/ already exists — pass --force to overwrite with the harness's copy` });
        refusals.push("addons/playtest_bridge/");
    } else if (!dryRun) {
        try {
            mkdirSync(addonDest, { recursive: true });
            for (const f of ADDON_FILES) {
                cpSync(path.join(addonSrc, f), path.join(addonDest, f));
            }
            steps.push({ id: "addon", status: "did", detail: `copy addons/playtest_bridge/ from the harness (${ADDON_FILES.length} files)` });
        } catch (e) {
            steps.push({
                id: "addon", status: "error",
                detail: `failed to copy addons/playtest_bridge/ from ${addonSrc}: ${e.message}`,
            });
            hardErrors.push("addons/playtest_bridge/");
        }
    } else {
        steps.push({ id: "addon", status: "did", detail: `would copy addons/playtest_bridge/ from the harness (${ADDON_FILES.length} files)` });
    }

    const pluginEdit = enablePluginInProjectGodot(projectGodotSource);
    if (!pluginEdit.changed) {
        steps.push({ id: "plugin", status: "skipped-exists", detail: "plugin already enabled in project.godot [editor_plugins]" });
    } else {
        if (!dryRun) writeFileSync(projectGodotPath, pluginEdit.content);
        steps.push({ id: "plugin", status: "did", detail: `${would}enable the plugin in project.godot (${pluginEdit.how}; every other line untouched)` });
    }

    // -- c. playtest.config.json + playtest.actions.json --------------------
    const { port, exhausted } = pickPort(project);
    if (exhausted) {
        steps.push({
            id: "port", status: "needs-you",
            detail: `every port ${PORT_RANGE.first}-${PORT_RANGE.last} is claimed by a sibling playtest.config.json — wrote ${port}; change "port" to something free`,
        });
    }
    writeTarget("config", "playtest.config.json",
        JSON.stringify(starterConfig(gameName, port), null, 2) + "\n",
        `game "${gameName}", port ${port}`);
    writeTarget("catalog", "playtest.actions.json",
        JSON.stringify(starterCatalog(gameName), null, 2) + "\n",
        "empty skeleton — the generic actions are runner built-ins");

    // -- d. export_presets.cfg ----------------------------------------------
    const presetsPath = path.join(project, "export_presets.cfg");
    if (!existsSync(presetsPath)) {
        if (!dryRun) writeFileSync(presetsPath, EXPORT_PRESET_TEMPLATE);
        steps.push({ id: "presets", status: "did", detail: `${would}write export_presets.cfg — minimal Web debug preset, thread_support OFF` });
    } else {
        const presets = readFileSync(presetsPath, "utf8");
        const hasWeb = /^platform="Web"/m.test(presets);
        if (!hasWeb) {
            steps.push({
                id: "presets", status: "needs-you",
                detail: `export_presets.cfg exists but has no Web preset (no platform="Web") — add one in the editor's Export dialog, with variant/thread_support=false`,
            });
        } else if (/^variant\/thread_support=true/m.test(presets)) {
            steps.push({
                id: "presets", status: "needs-you",
                detail: "WARNING: export_presets.cfg has variant/thread_support=true. A threaded web export needs COOP/COEP headers " +
                    "the harness's server does not send, so the game NEVER FINISHES BOOTING — the runner just sits at " +
                    "\"waiting for the bridge\" until timeout. Set variant/thread_support=false on the Web preset.",
            });
            nextSteps.push("Set variant/thread_support=false on the Web preset in export_presets.cfg (see the warning above).");
        } else if (/^variant\/thread_support=false/m.test(presets)) {
            steps.push({ id: "presets", status: "skipped-exists", detail: "export_presets.cfg has a Web preset with thread_support already off" });
        } else {
            steps.push({
                id: "presets", status: "needs-you",
                detail: "export_presets.cfg has a Web preset but no explicit variant/thread_support line — confirm it is off " +
                    "(Godot defaults to off, but an explicit false is what keeps the next editor session from flipping it silently)",
            });
        }
    }

    // -- e. .gitignore covers runs/ ------------------------------------------
    const gitignorePath = path.join(project, ".gitignore");
    const gitignoreText = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
    if (gitignoreCoversRuns(gitignoreText)) {
        steps.push({ id: "gitignore", status: "skipped-exists", detail: ".gitignore already covers runs/" });
    } else {
        if (!dryRun) {
            let appended = gitignoreText;
            if (appended.length > 0 && !appended.endsWith("\n")) appended += "\n";
            appended += "runs/\n";
            writeFileSync(gitignorePath, appended);
        }
        steps.push({ id: "gitignore", status: "did", detail: `${would}append runs/ to .gitignore${gitignoreText ? "" : " (creating it)"}` });
    }

    // -- f. scenarios/smoke.json ---------------------------------------------
    writeTarget("scenario", path.join("scenarios", "smoke.json"),
        JSON.stringify(starterScenario(), null, 2) + "\n",
        "dump_controls, screenshot, dump_state");

    // -- g. what's left is the human's --------------------------------------
    nextSteps.push(
        "Open the project once in the Godot editor (Project > Project Settings > Plugins shows Playtest Bridge enabled) — the plugin registers the PlaytestBridge autoload on load. Running the export below also does this.",
        "Export the debug web build: `godot-playtest export` (finds Godot via GODOT_BIN or PATH), or in the editor: Project > Export > Web > Export Project with \"Export With Debug\" checked, to build/web-debug/index.html.",
        "Check the scenario statically: `godot-playtest validate scenarios/smoke.json` (no browser, no build needed).",
        "Run it for real: `godot-playtest run scenarios/smoke.json`, then read runs/smoke_*/manifest.json — the controls dump is the map of what to drive next.",
        "Then read skills/SETUP_SKILL.md for the judgment calls init cannot make: a boot sequence past any title screen, semantic actions, and the sim tier.",
    );

    const ok = refusals.length === 0 && hardErrors.length === 0;
    // 2 (not 1) when a step outright failed rather than merely refusing to
    // overwrite — same convention as the "no project.godot" early return
    // above, and distinct from a plain refusal so a caller can tell "you
    // need --force" apart from "something actually broke".
    const exitCode = hardErrors.length > 0 ? 2 : (ok ? 0 : 1);
    return { ok, exitCode, steps, nextSteps, refusals, hardErrors };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help === true) {
        console.log("Usage: godot-playtest init [--project <dir>] [--dry-run] [--force]");
        console.log("Scaffolds a Godot 4.x game repo for this harness: addon, plugin enable,");
        console.log("config, action catalog, Web debug export preset, .gitignore, smoke scenario.");
        process.exit(0);
    }
    const dryRun = opts["dry-run"] === true;
    const result = runInit({
        projectDir: opts.project ? path.resolve(String(opts.project)) : process.cwd(),
        dryRun,
        force: opts.force === true,
    });

    const width = Math.max(...result.steps.map((s) => s.status.length));
    console.log(`godot-playtest init${dryRun ? " (dry-run: no file was touched)" : ""}`);
    for (const s of result.steps) {
        const line = `  [${s.status.padEnd(width)}] ${s.detail}`;
        if (s.status === "error" || s.status === "refused") console.error(line);
        else console.log(line);
    }

    if (result.hardErrors.length > 0) {
        console.error("");
        console.error(`${result.hardErrors.length} step(s) failed outright — see the [error] line(s) above.`);
    }
    if (result.refusals.length > 0) {
        console.error("");
        console.error(`Refusing to overwrite ${result.refusals.length} existing file(s): ${result.refusals.join(", ")}`);
        console.error("Re-run with --force to replace them, or delete the ones you want regenerated.");
    } else if (result.exitCode === 0 && result.nextSteps.length > 0) {
        console.log("");
        console.log(dryRun ? "After a real run, what remains for you, in order:" : "What remains for you, in order:");
        result.nextSteps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
    }
    process.exit(result.exitCode);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main();
}
