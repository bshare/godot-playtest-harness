// Unit tests for export_build.mjs — the auto-export step.
//
// No Godot binary exists on the machines that run this suite, and that is the
// point: the paths a Godot-less machine can exercise — command assembly,
// binary lookup, --dry-run, and the not-found error — are exactly the paths a
// stranger hits first, so they are the ones pinned here. The happy path
// (Godot actually exporting) is Godot's own behaviour and is verified on
// machines that have one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { locateGodot, resolveExport } from "../src/export_build.mjs";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "export_build.mjs");

/** A minimal game repo: config + project.godot, in a fresh temp dir. */
function makeGame(config = {}) {
    const root = mkdtempSync(path.join(tmpdir(), "export-build-test-"));
    writeFileSync(path.join(root, "playtest.config.json"), JSON.stringify({
        game: "fixture",
        build_dir: "build/web-debug",
        ...config,
    }));
    writeFileSync(path.join(root, "project.godot"), "[application]\n");
    return root;
}

function runScript(args, { cwd, env }) {
    return spawnSync(process.execPath, [SCRIPT, ...args], {
        encoding: "utf8",
        cwd,
        // A controlled environment: no inherited GODOT_BIN, and PATH reduced
        // to a directory guaranteed to hold no godot. SystemRoot survives
        // because Windows process creation needs it.
        env: { SystemRoot: process.env.SystemRoot ?? "", ...env },
    });
}

// ---------------------------------------------------------------------------
// Command assembly (resolveExport).
// ---------------------------------------------------------------------------

test("defaults: preset Web, project = config dir, target under build_dir", () => {
    const root = makeGame();
    try {
        const plan = resolveExport({ argv: [], cwd: root });
        assert.equal(plan.preset, "Web");
        assert.equal(plan.project, path.resolve(root));
        assert.equal(plan.target, path.resolve(root, "build", "web-debug", "index.html"));
        assert.deepEqual(plan.godotArgs, [
            "--headless",
            "--path", path.resolve(root),
            "--export-debug", "Web",
            path.resolve(root, "build", "web-debug", "index.html"),
        ]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("flags outrank config: --preset and --project win", () => {
    const root = makeGame({ export_preset: "Web Debug", godot_project: "game" });
    try {
        const plan = resolveExport({ argv: ["--preset", "Other", "--project", "subdir"], cwd: root });
        assert.equal(plan.preset, "Other");
        assert.equal(plan.project, path.resolve(root, "subdir"));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("config keys outrank defaults: export_preset and godot_project are read", () => {
    const root = makeGame({ export_preset: "Web Debug", godot_project: "game", build_dir: "out" });
    try {
        const plan = resolveExport({ argv: [], cwd: root });
        assert.equal(plan.preset, "Web Debug");
        assert.equal(plan.project, path.resolve(root, "game"));
        assert.equal(plan.target, path.resolve(root, "out", "index.html"));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("--config points at a config elsewhere; paths resolve relative to IT", () => {
    const root = makeGame();
    try {
        const plan = resolveExport({
            argv: ["--config", path.join(root, "playtest.config.json")],
            cwd: tmpdir(), // deliberately not the game dir
        });
        assert.equal(plan.project, path.resolve(root));
        assert.equal(plan.target, path.resolve(root, "build", "web-debug", "index.html"));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a missing config throws with the path it looked at", () => {
    const empty = mkdtempSync(path.join(tmpdir(), "export-build-empty-"));
    try {
        assert.throws(
            () => resolveExport({ argv: [], cwd: empty }),
            (e) => e.message.includes("playtest.config.json") && e.message.includes(empty),
        );
    } finally {
        rmSync(empty, { recursive: true, force: true });
    }
});

test("--dry-run parses as a boolean flag, not as eating the next arg", () => {
    const root = makeGame();
    try {
        const plan = resolveExport({ argv: ["--dry-run", "--preset", "X"], cwd: root });
        assert.equal(plan.dryRun, true);
        assert.equal(plan.preset, "X");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Binary lookup (locateGodot).
// ---------------------------------------------------------------------------

test("GODOT_BIN wins outright, verbatim", () => {
    assert.equal(
        locateGodot({ GODOT_BIN: "/opt/godot/godot.custom", PATH: "/usr/bin" }),
        "/opt/godot/godot.custom",
    );
});

test("PATH scan finds godot and godot4, with platform extensions", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "export-build-path-"));
    const ext = process.platform === "win32" ? ".exe" : "";
    try {
        writeFileSync(path.join(dir, `godot4${ext}`), "");
        assert.equal(locateGodot({ PATH: dir }), path.join(dir, `godot4${ext}`));
        // A plain `godot` outranks `godot4` when both exist.
        writeFileSync(path.join(dir, `godot${ext}`), "");
        assert.equal(locateGodot({ PATH: dir }), path.join(dir, `godot${ext}`));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("no GODOT_BIN and a godot-less PATH -> null, not a throw", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "export-build-nopath-"));
    try {
        assert.equal(locateGodot({ PATH: dir }), null);
        assert.equal(locateGodot({}), null);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// End to end, Godot-less: dry-run and the not-found error.
// ---------------------------------------------------------------------------

test("--dry-run prints the exact command and exits 0, binary or not", () => {
    const root = makeGame();
    const fakeBin = path.join(root, "fake-godot");
    try {
        const r = runScript(["--dry-run"], { cwd: root, env: { GODOT_BIN: fakeBin } });
        assert.equal(r.status, 0);
        assert.ok(r.stdout.includes(fakeBin));
        assert.ok(r.stdout.includes("--export-debug Web"));
        assert.ok(r.stdout.includes(path.join("build", "web-debug", "index.html")));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("--dry-run without any binary still prints, with a placeholder and a hint", () => {
    const root = makeGame();
    try {
        const r = runScript(["--dry-run"], { cwd: root, env: { PATH: root } });
        assert.equal(r.status, 0);
        assert.ok(r.stdout.includes("<godot> --headless"));
        assert.ok(r.stdout.includes("GODOT_BIN"));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("no binary and no --dry-run: exit 1 with both remedies named", () => {
    const root = makeGame();
    try {
        const r = runScript([], { cwd: root, env: { PATH: root } });
        assert.equal(r.status, 1);
        assert.ok(r.stderr.includes("no Godot binary found"));
        assert.ok(r.stderr.includes("GODOT_BIN"));
        assert.ok(r.stderr.includes("PATH"));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a project dir without project.godot is refused before the binary hunt", () => {
    const root = makeGame();
    rmSync(path.join(root, "project.godot"));
    try {
        const r = runScript([], { cwd: root, env: { PATH: root } });
        assert.equal(r.status, 2);
        assert.ok(r.stderr.includes("project.godot"));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("importing export_build.mjs runs nothing", async () => {
    // The import at the top of this file already proved it, but pin it as a
    // named requirement: batch.mjs and play_run.mjs are import-safe and this
    // file must stay in that family.
    const mod = await import("../src/export_build.mjs");
    assert.equal(typeof mod.resolveExport, "function");
    assert.equal(typeof mod.locateGodot, "function");
});
