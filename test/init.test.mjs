// Tests for src/init.mjs — the `godot-playtest init` scaffold. No Godot
// binary anywhere: every fixture is a minimal project.godot in a temp dir,
// and the assertions are about files, bytes, and reports.
//
// The one end-to-end hop is deliberate: the generated scenarios/smoke.json is
// checked by spawning the REAL validator (run_scenario.mjs --validate) against
// the generated config and catalog, because "init writes a scenario the
// validator accepts" is the actual contract, not "init writes JSON that looks
// right to this test".

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    HARNESS_ROOT,
    enablePluginInProjectGodot,
    gitignoreCoversRuns,
    parseProjectGodot,
    pickPort,
    runInit,
} from "../src/init.mjs";

const VALIDATOR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "run_scenario.mjs");

// A realistic minimal project.godot, with the section ordering and blank
// lines Godot itself writes. Overridable per test.
const PROJECT_GODOT = `; Engine configuration file.
; It's best edited using the editor UI and not directly,
; since the parameters that go here are not all obvious.

config_version=5

[application]

config/name="Fixture Quest"
run/main_scene="res://main.tscn"
config/features=PackedStringArray("4.3", "GL Compatibility")
config/icon="res://icon.svg"

[rendering]

renderer/rendering_method="gl_compatibility"
`;

/** One workspace per test: games are SUBDIRS so pickPort's sibling scan sees
 *  only what the test placed there, never other tests' temp dirs. */
function makeWorkspace() {
    const ws = mkdtempSync(path.join(tmpdir(), "init-test-"));
    return ws;
}

function makeGame(ws, name, { projectGodot = PROJECT_GODOT, files = {} } = {}) {
    const dir = path.join(ws, name);
    mkdirSync(dir, { recursive: true });
    if (projectGodot !== null) writeFileSync(path.join(dir, "project.godot"), projectGodot);
    for (const [rel, content] of Object.entries(files)) {
        const p = path.join(dir, rel);
        mkdirSync(path.dirname(p), { recursive: true });
        writeFileSync(p, content);
    }
    return dir;
}

/** Recursive { relPath: content } snapshot, for change-nothing assertions. */
function snapshot(dir) {
    const out = {};
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            for (const [rel, c] of Object.entries(snapshot(p))) out[path.join(entry.name, rel)] = c;
        } else {
            out[entry.name] = readFileSync(p, "utf8");
        }
    }
    return out;
}

function stepById(result, id) {
    return result.steps.find((s) => s.id === id);
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

test("a directory without project.godot is an error naming what it looked for", () => {
    const ws = makeWorkspace();
    try {
        const dir = makeGame(ws, "empty", { projectGodot: null });
        const r = runInit({ projectDir: dir });
        assert.equal(r.ok, false);
        assert.equal(r.exitCode, 2);
        assert.equal(r.steps.length, 1);
        assert.equal(r.steps[0].status, "error");
        assert.ok(r.steps[0].detail.includes("project.godot"), "error must name project.godot");
        assert.ok(r.steps[0].detail.includes(path.join(dir, "project.godot")), "error must name the full path it checked");
    } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("parseProjectGodot reads config/name and the 4.x feature string", () => {
    const parsed = parseProjectGodot(PROJECT_GODOT);
    assert.equal(parsed.name, "Fixture Quest");
    assert.equal(parsed.version, "4.3");
    const noFeatures = parseProjectGodot('config_version=5\n\n[application]\n\nconfig/name="Old One"\n');
    assert.equal(noFeatures.name, "Old One");
    assert.equal(noFeatures.version, null);
});

test("a project without run/main_scene gets a needs-you warning — it exports fine and then cannot boot", () => {
    // Verified live during release E2E: run/main_scene unset, export green,
    // then every run dies 30s later with "DebugBridge never registered" and a
    // diagnosis pointing at the build. init is where the fix costs one click.
    const ws = makeWorkspace();
    try {
        const noScene = PROJECT_GODOT.replace('run/main_scene="res://main.tscn"\n', "");
        assert.ok(!noScene.includes("main_scene"), "fixture must actually lack the line");
        const dir = makeGame(ws, "game", { projectGodot: noScene });
        const r = runInit({ projectDir: dir });
        assert.equal(r.ok, true, "a missing main scene is a warning, not a refusal — init's files are all still right");
        const step = stepById(r, "main_scene");
        assert.equal(step.status, "needs-you");
        assert.ok(step.detail.includes("run/main_scene"), "must name the missing setting");
        assert.ok(step.detail.includes("DebugBridge never registered"), "must connect it to the run-time symptom it causes");
        assert.ok(r.nextSteps.some((s) => s.includes("run/main_scene")), "and the fix must be in the next-steps list");

        // An EMPTY main_scene is the same fresh-project state, spelled differently.
        const empty = makeGame(ws, "empty-scene", {
            projectGodot: PROJECT_GODOT.replace('run/main_scene="res://main.tscn"', 'run/main_scene=""'),
        });
        assert.equal(stepById(runInit({ projectDir: empty, dryRun: true }), "main_scene").status, "needs-you");
    } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("a project WITH a main scene gets no main_scene step at all", () => {
    const ws = makeWorkspace();
    try {
        const dir = makeGame(ws, "game"); // the default fixture has run/main_scene
        const r = runInit({ projectDir: dir });
        assert.equal(stepById(r, "main_scene"), undefined, "no warning to read means nothing to check");
        assert.ok(!r.nextSteps.some((s) => s.includes("run/main_scene")));
    } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("missing config/features becomes a needs-you detection step, not a crash", () => {
    const ws = makeWorkspace();
    try {
        const dir = makeGame(ws, "game", {
            projectGodot: 'config_version=5\n\n[application]\n\nconfig/name="Versionless"\n',
        });
        const r = runInit({ projectDir: dir });
        assert.equal(r.ok, true);
        const detect = stepById(r, "detect");
        assert.equal(detect.status, "needs-you");
        assert.ok(detect.detail.includes("config/features"));
    } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// Dry run: changes nothing, lists everything
// ---------------------------------------------------------------------------

test("dry-run changes nothing and reports every step", () => {
    const ws = makeWorkspace();
    try {
        const dir = makeGame(ws, "game");
        const before = snapshot(dir);
        const r = runInit({ projectDir: dir, dryRun: true });
        assert.deepEqual(snapshot(dir), before, "dry-run must not touch a single byte");
        assert.equal(r.ok, true);
        assert.equal(r.exitCode, 0);
        for (const id of ["detect", "addon", "plugin", "config", "catalog", "presets", "gitignore", "scenario"]) {
            assert.ok(stepById(r, id), `dry-run report missing step "${id}"`);
        }
        // Every planned write says "would", so a reader can tell plan from action.
        for (const id of ["addon", "plugin", "config", "catalog", "scenario"]) {
            const s = stepById(r, id);
            assert.equal(s.status, "did");
            assert.ok(s.detail.startsWith("would "), `${id} detail should start with "would ": ${s.detail}`);
        }
    } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// Fresh init: all files, correct content, real validator accepts the scenario
// ---------------------------------------------------------------------------

test("fresh init produces every file, and the real validator accepts the smoke scenario", () => {
    const ws = makeWorkspace();
    try {
        const dir = makeGame(ws, "game");
        const r = runInit({ projectDir: dir });
        assert.equal(r.ok, true, JSON.stringify(r.steps, null, 2));
        assert.equal(r.exitCode, 0);

        // The addon arrived whole.
        for (const f of ["playtest_bridge.gd", "plugin.cfg", "plugin.gd", "README.md"]) {
            const dest = path.join(dir, "addons", "playtest_bridge", f);
            assert.ok(existsSync(dest), `addon file missing: ${f}`);
            assert.equal(readFileSync(dest, "utf8"),
                readFileSync(path.join(HARNESS_ROOT, "addons", "playtest_bridge", f), "utf8"),
                `${f} must be byte-identical to the harness's copy`);
        }

        // The plugin got enabled.
        const pg = readFileSync(path.join(dir, "project.godot"), "utf8");
        assert.ok(pg.includes('enabled=PackedStringArray("res://addons/playtest_bridge/plugin.cfg")'));

        // Config: name from config/name, port in range, documented defaults.
        const config = JSON.parse(readFileSync(path.join(dir, "playtest.config.json"), "utf8"));
        assert.equal(config.game, "Fixture Quest");
        assert.equal(config.build_dir, "build/web-debug");
        assert.equal(config.runs_dir, "runs");
        assert.ok(config.port >= 8060 && config.port <= 8079, `port ${config.port} outside 8060-8079`);
        assert.deepEqual(config.boot_sequence, []);
        assert.equal(config.action_catalog, "playtest.actions.json");

        // Catalog: an EMPTY skeleton. The generic-bridge actions are runner
        // built-ins; a catalog entry re-declaring one SHADOWS it (catalog wins
        // name collisions), and for dump_controls the shadowing silently drops
        // the controls payload from the manifest — found live on the first
        // real-game init. The starter catalog must therefore declare none of
        // them.
        const catalog = JSON.parse(readFileSync(path.join(dir, "playtest.actions.json"), "utf8"));
        assert.equal(catalog.catalog_version, 1);
        assert.deepEqual(catalog.actions, {},
            "starter catalog must not declare actions — a generic-bridge name here shadows the built-in");
        assert.deepEqual(catalog.runner_actions, {});
        assert.ok(catalog.note && catalog.note.includes("built-ins"),
            "the note explaining WHY it is empty must survive");

        // The runner's built-ins call these fns on the bridge; the copied addon
        // must register every one — the catalog-and-bridge-drift failure
        // ACTION_CATALOG.md warns about, now guarded at the built-in layer.
        const builtinFns = [
            "godotDebugDumpControls",
            "godotDebugClickControl",
            "godotDebugPressAction",
            "godotDebugSendKey",
            "godotDebugSetSlider",
            "godotDebugSelectTab",
        ];
        const gd = readFileSync(path.join(dir, "addons", "playtest_bridge", "playtest_bridge.gd"), "utf8");
        for (const fn of builtinFns) {
            assert.ok(gd.includes(`_window.${fn}`), `built-in fn ${fn} not registered by playtest_bridge.gd`);
        }

        // Preset written with the trap disarmed.
        const presets = readFileSync(path.join(dir, "export_presets.cfg"), "utf8");
        assert.ok(/^platform="Web"$/m.test(presets));
        assert.ok(/^variant\/thread_support=false$/m.test(presets));

        // runs/ ignored.
        assert.ok(gitignoreCoversRuns(readFileSync(path.join(dir, ".gitignore"), "utf8")));

        // The scenario passes the REAL validator, run from the game dir so it
        // loads the generated config and catalog. Exit 0 and zero warnings —
        // a starter file that ships with a warning teaches people to ignore them.
        const v = spawnSync(process.execPath, [VALIDATOR, "--validate", path.join("scenarios", "smoke.json")],
            { cwd: dir, encoding: "utf8" });
        assert.equal(v.status, 0, `validator rejected the generated scenario:\n${v.stdout}\n${v.stderr}`);
        assert.ok(v.stdout.includes("no errors or warnings"),
            `validator warned about the generated scenario:\n${v.stdout}\n${v.stderr}`);
    } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// The addon copy is guarded: a broken source must land in the report as a
// failed step, not throw a raw stack out of runInit (finding G).
// ---------------------------------------------------------------------------

test("a broken addon source is a reported error step, not a thrown stack, and the run still finishes", () => {
    const ws = makeWorkspace();
    try {
        const dir = makeGame(ws, "game");
        // A harnessRoot whose addons/playtest_bridge/ has none of the files
        // init.mjs expects — cpSync must fail (ENOENT) for every one of them.
        const brokenHarnessRoot = mkdtempSync(path.join(tmpdir(), "init-broken-harness-"));
        mkdirSync(path.join(brokenHarnessRoot, "addons", "playtest_bridge"), { recursive: true });

        const r = runInit({ projectDir: dir, harnessRoot: brokenHarnessRoot });

        assert.equal(r.ok, false);
        assert.equal(r.exitCode, 2, "a hard step failure exits 2, distinct from a plain --force refusal (1)");
        assert.equal(r.hardErrors.length, 1);
        assert.equal(r.hardErrors[0], "addons/playtest_bridge/");

        const addonStep = stepById(r, "addon");
        assert.equal(addonStep.status, "error");
        assert.ok(addonStep.detail.includes("playtest_bridge"), "the message must name what failed");

        // The design point: a failed step does not stop the rest of the
        // report from being produced — config/catalog/etc. still get a
        // verdict, exactly like every other step in this tool.
        assert.ok(stepById(r, "config"), "later steps must still run and report");
        assert.ok(stepById(r, "plugin"), "later steps must still run and report");

        rmSync(brokenHarnessRoot, { recursive: true, force: true });
    } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("init is idempotent under --force: a second run converges to the same files", () => {
    const ws = makeWorkspace();
    try {
        const dir = makeGame(ws, "game");
        assert.equal(runInit({ projectDir: dir }).ok, true);
        const after1 = snapshot(dir);
        const r2 = runInit({ projectDir: dir, force: true });
        assert.equal(r2.ok, true);
        assert.deepEqual(snapshot(dir), after1, "second --force run must change nothing");
        // The already-done non-write steps say so rather than re-claiming work.
        assert.equal(stepById(r2, "plugin").status, "skipped-exists");
        assert.equal(stepById(r2, "gitignore").status, "skipped-exists");
    } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// Port picking
// ---------------------------------------------------------------------------

test("pickPort avoids ports claimed by sibling configs and ignores the project's own", () => {
    const ws = makeWorkspace();
    try {
        makeGame(ws, "other-a", { files: { "playtest.config.json": JSON.stringify({ port: 8060 }) } });
        makeGame(ws, "other-b", { files: { "playtest.config.json": JSON.stringify({ port: 8061 }) } });
        makeGame(ws, "broken", { files: { "playtest.config.json": "{not json" } });
        const dir = makeGame(ws, "game", { files: { "playtest.config.json": JSON.stringify({ port: 8062 }) } });
        const { port, exhausted } = pickPort(dir);
        assert.equal(exhausted, false);
        assert.equal(port, 8062, "own old port is free for reuse; siblings' 8060/8061 are not");
    } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("a fresh init next to an existing game takes the next free port", () => {
    const ws = makeWorkspace();
    try {
        makeGame(ws, "first-game", { files: { "playtest.config.json": JSON.stringify({ port: 8060 }) } });
        const dir = makeGame(ws, "second-game");
        const r = runInit({ projectDir: dir });
        assert.equal(r.ok, true);
        const config = JSON.parse(readFileSync(path.join(dir, "playtest.config.json"), "utf8"));
        assert.equal(config.port, 8061);
    } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// Refusal without --force
// ---------------------------------------------------------------------------

test("re-init without --force refuses and overwrites nothing", () => {
    const ws = makeWorkspace();
    try {
        const dir = makeGame(ws, "game");
        assert.equal(runInit({ projectDir: dir }).ok, true);
        // The user customized their config; a lazy re-init must not eat it.
        const customized = path.join(dir, "playtest.config.json");
        writeFileSync(customized, JSON.stringify({ game: "custom", port: 9999 }));
        const before = snapshot(dir);

        const r = runInit({ projectDir: dir });
        assert.equal(r.ok, false);
        assert.equal(r.exitCode, 1);
        assert.deepEqual(snapshot(dir), before, "a refused init must not change any file");
        assert.ok(r.refusals.includes("playtest.config.json"));
        assert.ok(r.refusals.includes("playtest.actions.json"));
        assert.ok(r.refusals.some((f) => f.includes("smoke.json")));
        for (const id of ["config", "catalog", "scenario", "addon"]) {
            const s = stepById(r, id);
            assert.equal(s.status, "refused", `${id} should refuse without --force`);
            assert.ok(s.detail.includes("--force"), `${id} refusal must say how to proceed`);
        }
        // --force then does overwrite the customized config.
        const rf = runInit({ projectDir: dir, force: true });
        assert.equal(rf.ok, true);
        assert.equal(JSON.parse(readFileSync(customized, "utf8")).game, "Fixture Quest");
    } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// project.godot surgery
// ---------------------------------------------------------------------------

test("project.godot edits are surgical: every pre-existing line survives byte-identical", () => {
    const ws = makeWorkspace();
    try {
        const dir = makeGame(ws, "game");
        const originalLines = PROJECT_GODOT.split("\n");
        assert.equal(runInit({ projectDir: dir }).ok, true);
        const editedLines = readFileSync(path.join(dir, "project.godot"), "utf8").split("\n");
        // No [editor_plugins] existed, so the edit is append-only: the file
        // must START with the original bytes, unmodified.
        assert.deepEqual(editedLines.slice(0, originalLines.length - 1), originalLines.slice(0, -1),
            "append-only edit modified a pre-existing line");
        assert.ok(editedLines.includes("[editor_plugins]"));
    } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("an existing [editor_plugins] enabled list gains one entry; other plugins and all other lines survive", () => {
    const src = `config_version=5

[application]

config/name="Has Plugins"
config/features=PackedStringArray("4.4")

[editor_plugins]

enabled=PackedStringArray("res://addons/gut/plugin.cfg")

[rendering]

renderer/rendering_method="mobile"
`;
    const { content, changed } = enablePluginInProjectGodot(src);
    assert.equal(changed, true);
    assert.ok(content.includes('enabled=PackedStringArray("res://addons/gut/plugin.cfg", "res://addons/playtest_bridge/plugin.cfg")'));
    // Every line except the enabled= line is untouched.
    const before = src.split("\n");
    const after = content.split("\n");
    assert.equal(after.length, before.length, "in-place edit must not add or remove lines");
    for (let i = 0; i < before.length; i++) {
        if (before[i].startsWith("enabled=")) continue;
        assert.equal(after[i], before[i], `line ${i} changed`);
    }
});

test("enabling is idempotent, handles an empty enabled list, and preserves CRLF", () => {
    const already = 'x=1\n\n[editor_plugins]\n\nenabled=PackedStringArray("res://addons/playtest_bridge/plugin.cfg")\n';
    assert.equal(enablePluginInProjectGodot(already).changed, false);

    const empty = "[editor_plugins]\n\nenabled=PackedStringArray()\n";
    assert.ok(enablePluginInProjectGodot(empty).content
        .includes('enabled=PackedStringArray("res://addons/playtest_bridge/plugin.cfg")'));

    const crlf = 'config_version=5\r\n\r\n[application]\r\n\r\nconfig/name="CRLF"\r\n';
    const edited = enablePluginInProjectGodot(crlf).content;
    assert.ok(edited.startsWith(crlf), "existing CRLF bytes must survive");
    assert.ok(edited.includes('[editor_plugins]\r\n\r\nenabled=PackedStringArray("res://addons/playtest_bridge/plugin.cfg")\r\n'),
        "appended section must use the file's own CRLF endings");

    const sectionNoLine = "[editor_plugins]\n\n[rendering]\n\nrenderer/rendering_method=\"mobile\"\n";
    const fixed = enablePluginInProjectGodot(sectionNoLine).content;
    const idx = fixed.indexOf('enabled=PackedStringArray("res://addons/playtest_bridge/plugin.cfg")');
    assert.ok(idx !== -1 && idx < fixed.indexOf("[rendering]"),
        "enabled line must land inside [editor_plugins], before the next section");
});

// ---------------------------------------------------------------------------
// export_presets.cfg audit
// ---------------------------------------------------------------------------

test("an existing preset with thread_support=true fires the loud boot-hang warning", () => {
    const ws = makeWorkspace();
    try {
        const dir = makeGame(ws, "game", {
            files: {
                "export_presets.cfg":
                    '[preset.0]\n\nname="Web"\nplatform="Web"\nrunnable=true\n\n[preset.0.options]\n\nvariant/thread_support=true\n',
            },
        });
        const r = runInit({ projectDir: dir });
        const presets = stepById(r, "presets");
        assert.equal(presets.status, "needs-you");
        assert.ok(presets.detail.includes("thread_support=true"));
        assert.ok(/COOP|COEP/.test(presets.detail), "warning should explain the header mechanism");
        assert.ok(presets.detail.includes("NEVER FINISHES BOOTING"), "warning should be loud about the symptom");
        // The existing preset file itself is untouched — init audits, it does not rewrite.
        assert.ok(readFileSync(path.join(dir, "export_presets.cfg"), "utf8").includes("variant/thread_support=true"));
        // And the fix lands in the human's ordered next steps too.
        assert.ok(r.nextSteps.some((s) => s.includes("thread_support")), "next steps must include the fix");
    } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("an existing preset with thread_support=false is left alone and reported as fine", () => {
    const ws = makeWorkspace();
    try {
        const dir = makeGame(ws, "game", {
            files: {
                "export_presets.cfg":
                    '[preset.0]\n\nname="Web"\nplatform="Web"\n\n[preset.0.options]\n\nvariant/thread_support=false\n',
            },
        });
        const r = runInit({ projectDir: dir });
        assert.equal(stepById(r, "presets").status, "skipped-exists");
        assert.equal(r.ok, true);
    } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("an existing presets file with no Web preset is a needs-you, not silently accepted", () => {
    const ws = makeWorkspace();
    try {
        const dir = makeGame(ws, "game", {
            files: { "export_presets.cfg": '[preset.0]\n\nname="Win"\nplatform="Windows Desktop"\n' },
        });
        const r = runInit({ projectDir: dir });
        const presets = stepById(r, "presets");
        assert.equal(presets.status, "needs-you");
        assert.ok(presets.detail.includes("Web"));
    } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// .gitignore
// ---------------------------------------------------------------------------

test("gitignore coverage check accepts the equivalent spellings and nothing looser", () => {
    for (const covered of ["runs/", "runs", "/runs", "/runs/", "build/\nruns/\n"]) {
        assert.equal(gitignoreCoversRuns(covered), true, `should accept ${JSON.stringify(covered)}`);
    }
    for (const notCovered of ["", "build/", "runs2/", "# runs/", "foo/runs/"]) {
        assert.equal(gitignoreCoversRuns(notCovered), false, `should reject ${JSON.stringify(notCovered)}`);
    }
});

test("an existing .gitignore is appended to, not rewritten", () => {
    const ws = makeWorkspace();
    try {
        const dir = makeGame(ws, "game", { files: { ".gitignore": "build/\n*.import" } });
        const r = runInit({ projectDir: dir });
        assert.equal(stepById(r, "gitignore").status, "did");
        const text = readFileSync(path.join(dir, ".gitignore"), "utf8");
        assert.ok(text.startsWith("build/\n*.import"), "existing entries must survive at the top");
        assert.ok(gitignoreCoversRuns(text));
    } finally { rmSync(ws, { recursive: true, force: true }); }
});
