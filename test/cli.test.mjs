// Unit tests for bin/godot-playtest.mjs — the npx entry point.
//
// The dispatcher is a mapping table plus a spawn, so the tests split the same
// way: the table and the decision function are asserted by import (nothing
// spawned, so nothing long-running), and only the terminal paths — help,
// init, unknown — are exercised end to end, because those are the ones whose
// exit codes ARE the behaviour. No test here launches a browser, a server, or
// a real subcommand.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { HARNESS_ROOT, SUBCOMMANDS, resolveInvocation, usage } from "../bin/godot-playtest.mjs";

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "godot-playtest.mjs");

function runBin(args) {
    return spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });
}

// ---------------------------------------------------------------------------
// The mapping table.
// ---------------------------------------------------------------------------

test("every subcommand maps to a script that exists", () => {
    for (const [name, def] of Object.entries(SUBCOMMANDS)) {
        const scriptPath = path.join(HARNESS_ROOT, def.script);
        assert.ok(existsSync(scriptPath), `${name} -> ${def.script} does not exist`);
        assert.ok(typeof def.summary === "string" && def.summary.length > 0,
            `${name} has no summary for --help`);
    }
});

test("the mapping is the documented one", () => {
    const expected = {
        validate: "src/run_scenario.mjs",
        run: "src/run_scenario.mjs",
        play: "src/play_run.mjs",
        batch: "src/batch.mjs",
        coverage: "src/coverage.mjs",
        diff: "src/diff_run.mjs",
        prune: "src/prune_run.mjs",
        sweep: "src/sweep_runs.mjs",
        export: "src/export_build.mjs",
        init: "src/init.mjs",
    };
    assert.deepEqual(
        Object.fromEntries(Object.entries(SUBCOMMANDS).map(([k, v]) => [k, v.script])),
        expected,
    );
});

test("validate is run_scenario with --validate prepended", () => {
    const d = resolveInvocation(["validate", "scenarios/a.json", "scenarios/b.json"]);
    assert.equal(d.kind, "spawn");
    assert.equal(d.script, path.join(HARNESS_ROOT, "src", "run_scenario.mjs"));
    assert.deepEqual(d.args, ["--validate", "scenarios/a.json", "scenarios/b.json"]);
});

test("run passes its arguments through untouched, in order", () => {
    const d = resolveInvocation(["run", "scenarios/first_repair.json", "--port", "9000"]);
    assert.equal(d.kind, "spawn");
    assert.equal(d.script, path.join(HARNESS_ROOT, "src", "run_scenario.mjs"));
    assert.deepEqual(d.args, ["scenarios/first_repair.json", "--port", "9000"]);
});

test("a flag that happens to match a later subcommand name is not re-dispatched", () => {
    // `godot-playtest batch --game . export` must reach batch.mjs verbatim.
    const d = resolveInvocation(["batch", "--game", ".", "export"]);
    assert.equal(d.script, path.join(HARNESS_ROOT, "src", "batch.mjs"));
    assert.deepEqual(d.args, ["--game", ".", "export"]);
});

// ---------------------------------------------------------------------------
// The decision function's terminal branches.
// ---------------------------------------------------------------------------

test("no arguments, --help, -h, and help all resolve to help", () => {
    assert.deepEqual(resolveInvocation([]), { kind: "help", explicit: false });
    for (const flag of ["--help", "-h", "help"]) {
        assert.deepEqual(resolveInvocation([flag]), { kind: "help", explicit: true });
    }
});

test("usage lists every subcommand by name", () => {
    const text = usage();
    for (const name of Object.keys(SUBCOMMANDS)) {
        assert.ok(text.includes(name), `usage() does not mention "${name}"`);
    }
    assert.ok(text.includes("init"), "usage() does not mention init");
});

// ---------------------------------------------------------------------------
// End-to-end exit codes — terminal paths only, nothing long-running.
// ---------------------------------------------------------------------------

test("--help exits 0 and prints the subcommand list to stdout", () => {
    const r = runBin(["--help"]);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes("validate"));
    assert.ok(r.stdout.includes("export"));
});

test("bare invocation is a usage error: exit 2, usage on stderr", () => {
    const r = runBin([]);
    assert.equal(r.status, 2);
    assert.ok(r.stderr.includes("Usage: godot-playtest"));
});

test("an unknown subcommand exits 2 and names itself", () => {
    const r = runBin(["frobnicate"]);
    assert.equal(r.status, 2);
    assert.ok(r.stderr.includes("frobnicate"));
    assert.ok(r.stderr.includes("Usage: godot-playtest"));
});

test("init dispatches to src/init.mjs and propagates its not-a-project error", () => {
    // bin/ is guaranteed to hold no project.godot, so init.mjs exits 2 naming
    // exactly what it looked for — proving the stub was replaced by a real
    // dispatch AND that the child's exit code comes back intact.
    const r = spawnSync(process.execPath, [BIN, "init", "--dry-run"], {
        encoding: "utf8",
        cwd: path.dirname(BIN),
    });
    assert.equal(r.status, 2);
    assert.ok(r.stderr.includes("project.godot"));
});

test("a real dispatch propagates the child's exit code", () => {
    // export with no config in an empty cwd exits 2 inside export_build.mjs;
    // the dispatcher must hand that 2 back rather than swallowing it. This is
    // the cheapest real subcommand: no server, no browser, fails immediately.
    const r = spawnSync(process.execPath, [BIN, "export"], {
        encoding: "utf8",
        cwd: path.dirname(BIN), // bin/ — guaranteed to hold no playtest.config.json
    });
    assert.equal(r.status, 2);
    assert.ok(r.stderr.includes("playtest.config.json"));
});

test("--version resolves to the version kind, and the spawned bin prints package.json's version", () => {
    for (const spelling of ["--version", "-v", "version"]) {
        assert.equal(resolveInvocation([spelling]).kind, "version", spelling);
    }
    const r = runBin(["--version"]);
    assert.equal(r.status, 0);
    const pkg = JSON.parse(readFileSync(path.join(HARNESS_ROOT, "package.json"), "utf8"));
    assert.equal(r.stdout.trim(), `godot-playtest ${pkg.version}`);
});
