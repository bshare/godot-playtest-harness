// runs_guard.mjs — the deletion-safety check shared by prune_run.mjs and
// sweep_runs.mjs. See the module's own header for the vulnerability this
// replaces (`path.split(sep).includes("runs")` matching a "runs" component
// ANYWHERE in the path, unrelated to the actual project).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveRunsRoot } from "../src/runs_guard.mjs";

function tmp() {
    return mkdtempSync(path.join(tmpdir(), "runs-guard-"));
}

// ---------------------------------------------------------------------------
// The literal-name fallback (no playtest.config.json anywhere above the target)
// ---------------------------------------------------------------------------

test("bundle kind: a bundle directly inside a literal runs/ passes", () => {
    const base = tmp();
    try {
        const bundle = path.join(base, "runs", "critique_0001");
        mkdirSync(bundle, { recursive: true });
        const { root, target } = resolveRunsRoot(bundle, "bundle");
        assert.equal(path.basename(root), "runs");
        assert.equal(target, realpathSync(bundle));
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test("bundle kind: a 'runs' component further up the chain (not the direct parent) no longer counts", () => {
    // This is exactly the old bug: `.split(sep).includes("runs")` accepted
    // ANY ancestor named "runs", at any depth. A bundle whose parent is named
    // something else — even with a "runs" grandparent — must now be refused.
    const base = tmp();
    try {
        const bundle = path.join(base, "runs", "nested", "critique_0001");
        mkdirSync(bundle, { recursive: true });
        assert.throws(() => resolveRunsRoot(bundle, "bundle"), /no playtest\.config\.json|not literally named "runs"/);
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test("root kind: the runs directory itself, literally named runs, passes", () => {
    const base = tmp();
    try {
        const runsDir = path.join(base, "runs");
        mkdirSync(runsDir, { recursive: true });
        const { root } = resolveRunsRoot(runsDir, "root");
        assert.equal(path.basename(root), "runs");
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test("root kind: a directory NOT literally named runs is refused even with no config anywhere", () => {
    const base = tmp();
    try {
        const notRuns = path.join(base, "output");
        mkdirSync(notRuns, { recursive: true });
        assert.throws(() => resolveRunsRoot(notRuns, "root"), /not literally named "runs"/);
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test("bundle kind: a bundle that equals its own runs root is refused (not a bundle inside it)", () => {
    const base = tmp();
    try {
        writeFileSync(path.join(base, "playtest.config.json"), JSON.stringify({}));
        const runsDir = path.join(base, "runs");
        mkdirSync(runsDir, { recursive: true });
        // With a config present, the root resolves to base/runs regardless of
        // kind — passing the runs root itself AS a "bundle" must still be
        // refused, because it IS the root, not something inside it.
        assert.throws(() => resolveRunsRoot(runsDir, "bundle"), /IS the runs root/);
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// The configured tier: playtest.config.json's runs_dir governs, no matter
// what any path component is literally named.
// ---------------------------------------------------------------------------

test("configured runs_dir is honored even when it is not literally named 'runs'", () => {
    const base = tmp();
    try {
        writeFileSync(path.join(base, "playtest.config.json"), JSON.stringify({ runs_dir: "playtest-output" }));
        const bundle = path.join(base, "playtest-output", "critique_0001");
        mkdirSync(bundle, { recursive: true });
        const { root } = resolveRunsRoot(bundle, "bundle");
        assert.equal(path.basename(root), "playtest-output");
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test("UNRELATED RUNS FOLDER: a literally-named runs/ elsewhere in the same project is refused when the config points elsewhere", () => {
    // The exact confused-deputy shape from the finding: an MCP client passes a
    // run_dir under a folder that happens to be named "runs", but the
    // project's OWN configured runs tree is somewhere else entirely. The old
    // check (`.split(sep).includes("runs")`) would have allowed deleting
    // here; the config must win.
    const base = tmp();
    try {
        writeFileSync(path.join(base, "playtest.config.json"), JSON.stringify({ runs_dir: "output" }));
        mkdirSync(path.join(base, "output"), { recursive: true });
        const decoy = path.join(base, "data", "runs", "not_a_real_bundle");
        mkdirSync(decoy, { recursive: true });
        assert.throws(() => resolveRunsRoot(decoy, "bundle"), /outside its runs root/);
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test("TRAVERSAL: a path that resolves outside the configured runs root is refused", () => {
    const base = tmp();
    try {
        writeFileSync(path.join(base, "playtest.config.json"), JSON.stringify({}));
        mkdirSync(path.join(base, "runs"), { recursive: true });
        const outside = path.join(base, "..", path.basename(base) + "-sibling");
        mkdirSync(outside, { recursive: true });
        try {
            // A run_dir that, after collapsing "..", lands outside the runs
            // root entirely — same project, sibling directory.
            const escapee = path.join(base, "runs", "..", "..", path.basename(outside));
            assert.throws(() => resolveRunsRoot(escapee, "bundle"), /outside its runs root|IS the runs root|not literally named/);
        } finally {
            rmSync(outside, { recursive: true, force: true });
        }
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test("a broken playtest.config.json above the target is refused rather than silently falling back", () => {
    const base = tmp();
    try {
        writeFileSync(path.join(base, "playtest.config.json"), "{ not json");
        const bundle = path.join(base, "runs", "critique_0001");
        mkdirSync(bundle, { recursive: true });
        assert.throws(() => resolveRunsRoot(bundle, "bundle"), /not valid JSON/);
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Symlink defense
// ---------------------------------------------------------------------------

function trySymlink(target, linkPath, type) {
    try {
        symlinkSync(target, linkPath, type);
        return true;
    } catch (e) {
        // Windows requires elevated privilege (or Developer Mode) to create
        // symlinks; treat EPERM as "cannot test this here" rather than fail.
        if (e.code === "EPERM" || e.code === "EACCES") return false;
        throw e;
    }
}

test("SYMLINK: a bundle reached through a symlinked runs/ that points outside the project is refused", { skip: false }, (t) => {
    const base = tmp();
    const elsewhere = tmp();
    try {
        writeFileSync(path.join(base, "playtest.config.json"), JSON.stringify({}));
        mkdirSync(path.join(base, "runs"), { recursive: true }); // the REAL, configured runs root
        const secretBundle = path.join(elsewhere, "secret_bundle");
        mkdirSync(secretBundle, { recursive: true });
        const link = path.join(base, "runs", "escape_link");
        if (!trySymlink(secretBundle, link, "junction")) {
            t.skip("symlink creation requires elevated privilege on this Windows host");
            return;
        }
        // The link SITS inside the real runs/ by name, but its realpath
        // resolves entirely outside base — containment (and the config
        // search) must be driven by the post-realpath location, not the
        // pre-symlink path, so this is refused either as "outside its runs
        // root" or, since the resolved location has no governing config of
        // its own, via the literal-name fallback. Either way it must throw.
        assert.throws(() => resolveRunsRoot(link, "bundle"), /outside its runs root|not literally named "runs"/);
    } finally {
        rmSync(base, { recursive: true, force: true });
        rmSync(elsewhere, { recursive: true, force: true });
    }
});
