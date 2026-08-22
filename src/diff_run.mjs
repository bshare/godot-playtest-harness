// Semantic diff between two captured game states — "what changed between
// these two runs?", answered from evidence that already exists instead of two
// manifest.json files opened side by side.
//
//   node diff_run.mjs <a> <b> [--json]
//   godot-playtest diff runs/before_123 runs/after_456
//   godot-playtest diff runs/_sessions/trial.json runs/_sessions/trial2.json
//
// Each side is either a RUN BUNDLE directory (the state compared is the last
// dump_state the run recorded: the final `steps[].state` of a scenario
// manifest, or `final_state` of a play_run manifest) or a JSON FILE (a session
// snapshot, or any saved dump_state payload).
//
// Exit codes follow diff(1), which is also what CI wants ("assert no drift"
// is an exit-0 check): 0 identical, 1 differences found, 2 usage error or
// unreadable input. This deliberately inverts the PRD draft's 0-on-differences
// suggestion — a diff tool whose success code means "they differ" cannot be
// dropped into a shell && chain or a CI step without inverting it every time.
//
// Array policy (documented, never silently misaligned): same length compares
// element-wise by index; different lengths compare the shared prefix
// element-wise and report the tail as added/removed at its index. That is
// exact for appends/truncations (logs, unlock lists — the common case in a
// dump) and approximate for mid-list insertion, where one insertion reads as
// N element changes plus a tail add; the length line at the top of the group
// is the tell.
//
// A `version` mismatch between the two states is WARNED about loudly, not
// refused: the schema having been bumped between builds is precisely the
// moment a developer reaches for this tool, and the warning tells the reader
// that key semantics may have shifted under the textual diff.

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Deep semantic diff. Returns a flat list of
 * { path, kind: "added"|"removed"|"changed"|"type_changed", from?, to? }
 * in traversal order. Paths use the predicate vocabulary's dotted+[i] syntax
 * so a finding can be pasted straight into an assert_state step.
 */
export function diffStates(a, b) {
    const out = [];
    walk(a, b, "", out);
    return out;
}

function kindOf(v) {
    if (Array.isArray(v)) return "array";
    if (v !== null && typeof v === "object") return "object";
    return "scalar";
}

function scalarEquals(a, b) {
    // NaN in a dump is already a data smell, but two of them are still "no change".
    return a === b || (typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b));
}

function joinPath(prefix, key) {
    if (typeof key === "number") return `${prefix}[${key}]`;
    return prefix === "" ? String(key) : `${prefix}.${key}`;
}

function walk(a, b, prefix, out) {
    const ka = kindOf(a);
    const kb = kindOf(b);
    if (ka !== kb || (ka === "scalar" && typeof a !== typeof b && a !== null && b !== null)) {
        out.push({ path: prefix || "(root)", kind: "type_changed", from: describe(a), to: describe(b) });
        return;
    }
    if (ka === "scalar") {
        if (!scalarEquals(a, b)) out.push({ path: prefix || "(root)", kind: "changed", from: a, to: b });
        return;
    }
    if (ka === "array") {
        const shared = Math.min(a.length, b.length);
        for (let i = 0; i < shared; i++) walk(a[i], b[i], joinPath(prefix, i), out);
        for (let i = shared; i < a.length; i++) {
            out.push({ path: joinPath(prefix, i), kind: "removed", from: a[i] });
        }
        for (let i = shared; i < b.length; i++) {
            out.push({ path: joinPath(prefix, i), kind: "added", to: b[i] });
        }
        return;
    }
    // objects: union of OWN keys, a's order first, b-only keys after — same
    // own-property discipline as the predicate vocabulary.
    for (const key of Object.keys(a)) {
        if (Object.hasOwn(b, key)) walk(a[key], b[key], joinPath(prefix, key), out);
        else out.push({ path: joinPath(prefix, key), kind: "removed", from: a[key] });
    }
    for (const key of Object.keys(b)) {
        if (!Object.hasOwn(a, key)) out.push({ path: joinPath(prefix, key), kind: "added", to: b[key] });
    }
}

function describe(v) {
    const k = kindOf(v);
    if (k === "array") return `array[${v.length}]`;
    if (k === "object") return `object{${Object.keys(v).length}}`;
    return `${v === null ? "null" : typeof v}:${JSON.stringify(v)}`;
}

/**
 * Resolves one CLI argument to a state payload. A directory is a run bundle
 * (read its manifest, take the last captured state); a file is parsed JSON
 * taken as the state itself. Throws with a named reason on anything else —
 * "unreadable" must never diff as an empty object.
 */
export function loadState(target) {
    const resolved = path.resolve(target);
    if (!existsSync(resolved)) throw new Error(`${target}: does not exist`);
    if (statSync(resolved).isDirectory()) {
        const manifestPath = path.join(resolved, "manifest.json");
        if (!existsSync(manifestPath)) {
            throw new Error(`${target}: not a run bundle — no manifest.json inside (pass a bundle dir or a JSON state file)`);
        }
        let manifest;
        try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); }
        catch { throw new Error(`${target}: manifest.json is not valid JSON`); }
        if (Array.isArray(manifest.steps)) {
            for (let i = manifest.steps.length - 1; i >= 0; i--) {
                if (manifest.steps[i].state) return { state: manifest.steps[i].state, source: `${target} (step ${i} state)` };
            }
            throw new Error(`${target}: no step in this bundle recorded a dump_state — nothing to diff (add a dump_state step to the scenario)`);
        }
        if (manifest.final_state) return { state: manifest.final_state, source: `${target} (final_state)` };
        throw new Error(`${target}: manifest has neither steps[] with a state nor final_state`);
    }
    let parsed;
    // Strip a UTF-8 BOM: PowerShell 5.1's default file writes carry one, and a
    // hand-saved snapshot from a Windows shell is a first-class input here.
    try { parsed = JSON.parse(readFileSync(resolved, "utf8").replace(/^\uFEFF/, "")); }
    catch { throw new Error(`${target}: not valid JSON`); }
    return { state: parsed, source: target };
}

function die(msg) {
    console.error(`ERROR: ${msg}`);
    console.error("Usage: godot-playtest diff <bundle-dir|state.json> <bundle-dir|state.json> [--json]");
    process.exit(2);
}

function main() {
    const args = process.argv.slice(2);
    const json = args.includes("--json");
    const positional = args.filter((a) => !a.startsWith("--"));
    const unknown = args.filter((a) => a.startsWith("--") && a !== "--json");
    if (unknown.length > 0) die(`unknown flag ${unknown[0]}`);
    if (positional.length !== 2) die(`diff takes exactly two inputs, got ${positional.length}`);

    let a, b;
    try {
        a = loadState(positional[0]);
        b = loadState(positional[1]);
    } catch (err) {
        die(err.message);
    }

    const va = a.state?.version;
    const vb = b.state?.version;
    if (va !== vb) {
        console.error(`WARNING: state schema versions differ (${JSON.stringify(va)} vs ${JSON.stringify(vb)}) — ` +
            `keys may have changed MEANING between these builds; read the diff with that in mind.`);
    }

    const differences = diffStates(a.state, b.state);

    if (json) {
        console.log(JSON.stringify({
            a: a.source, b: b.source,
            identical: differences.length === 0,
            difference_count: differences.length,
            differences,
        }, null, 2));
    } else {
        console.log(`A: ${a.source}`);
        console.log(`B: ${b.source}`);
        if (differences.length === 0) {
            console.log("States are identical.");
        } else {
            for (const kind of ["type_changed", "changed", "removed", "added"]) {
                const group = differences.filter((d) => d.kind === kind);
                if (group.length === 0) continue;
                console.log(`\n${kind.toUpperCase().replace("_", " ")} (${group.length}):`);
                for (const d of group) {
                    if (kind === "added") console.log(`  + ${d.path} = ${JSON.stringify(d.to)}`);
                    else if (kind === "removed") console.log(`  - ${d.path} = ${JSON.stringify(d.from)}`);
                    else console.log(`  ~ ${d.path}: ${JSON.stringify(d.from)} -> ${JSON.stringify(d.to)}`);
                }
            }
            console.log(`\n${differences.length} difference(s).`);
        }
    }
    process.exit(differences.length === 0 ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main();
}
