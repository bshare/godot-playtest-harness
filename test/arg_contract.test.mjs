// Runner-action arg-contract test. Run via: npm test
//
// THE DEFECT THIS EXISTS FOR. run_scenario.mjs carries two descriptions of
// every runner action: BUILTIN_RUNNER_ACTIONS (what the validator accepts) and
// the handler branch (what the runtime reads). Nothing tied them together, and
// five of them had drifted:
//
//   mouse_scroll           declared dx/dy, read delta_y — a scenario written
//                          from the docs validated, then scrolled (0,0), and
//                          recorded ok:true
//   mouse_click_menu_item  required `text`, read `label`/`id`
//   ui_lint                declared `rules` (read by nothing), hid the six
//                          lint switches it does consume
//   ui_sweep               declared 2 of the 6 args it consumes
//   scroll_stability       declared 1 of the 3
//
// Every one of those is silent: a validator that green-lights an arg the
// runtime ignores produces a passing step that tested nothing. That is the same
// failure class the validator itself was built to prevent, one level up.
//
// ---------------------------------------------------------------------------
// HOW IT WORKS, AND WHAT IT CANNOT DO — read this before trusting a green run
// ---------------------------------------------------------------------------
//
// This is a STATIC test. It reads src/run_scenario.mjs as text and extracts,
// per action branch, the arg names that branch destructures out of `step.args`
// or reaches for as `step.args?.name`. The precedent is
// test/addon_contract.test.mjs, which parses GDScript the same way and for the
// same reason: the alternative is running a browser and a Godot build in CI.
//
// The limits, named honestly:
//
//   * A regex does not evaluate JavaScript. If a handler ever computes an arg
//     name (`step.args[someVar]`) this test sees nothing and says nothing.
//     No handler does that today, and EXTRACTION_FLOOR below fails loudly if a
//     branch suddenly stops yielding any names at all, which is what that would
//     look like.
//   * Args consumed inside a HELPER (runUiLint, runUiSweep) are only found
//     because FOLLOWS below names the helper explicitly. That map is the one
//     hand-maintained part here. A new helper that swallows `opts` without an
//     entry would go unchecked — so the map is asserted non-empty and each of
//     its targets is asserted to exist.
//   * It checks NAMES, not types, not semantics.
//
// What it buys is precise: an arg the runtime reads and the spec does not
// declare, or a spec entry no line of the runtime consumes, is now a red test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(path.join(ROOT, "src", "run_scenario.mjs"), "utf8");

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

// Strip line comments so prose cannot satisfy an assertion about code. LIMIT:
// naive — a "//" inside a string literal would truncate that line. None of the
// lines this test reads contain one, and a false truncation would REMOVE names
// (failing the test), never invent them.
const code = src
	.split("\n")
	.map((line) => {
		const i = line.indexOf("//");
		return i === -1 ? line : line.slice(0, i);
	})
	.join("\n");

// Split "a, b = [], c: d = {x: 1}" on top-level commas only — defaults contain
// their own commas inside brackets and braces.
function splitTopLevel(text) {
	const parts = [];
	let depth = 0;
	let current = "";
	for (const ch of text) {
		if ("([{".includes(ch)) depth++;
		else if (")]}".includes(ch)) depth--;
		if (ch === "," && depth === 0) { parts.push(current); current = ""; continue; }
		current += ch;
	}
	if (current.trim()) parts.push(current);
	return parts.map((p) => p.trim()).filter(Boolean);
}

// "path: pathExpr = 5" -> "path"; "...rest" -> null (a rest element consumes no
// NAMED arg of its own; where one is used, FOLLOWS points at what receives it).
function bindingName(part) {
	if (part.startsWith("...")) return null;
	return part.split(/[:=]/)[0].trim();
}

// Every `const { ... } = <sourceExpr>` in `text`, flattened to binding names.
function destructuredFrom(text, sourceExpr) {
	const re = new RegExp(`(?:const|let)\\s*\\{([\\s\\S]*?)\\}\\s*=\\s*${sourceExpr}`, "g");
	const names = new Set();
	for (const m of text.matchAll(re)) {
		for (const part of splitTopLevel(m[1])) {
			const n = bindingName(part);
			if (n) names.add(n);
		}
	}
	return names;
}

// The runner's big dispatch chain, split into one text block per action. Blocks
// are keyed by EVERY action name the branch condition mentions, so the shared
// `mouse_move_cell || mouse_click_cell` branch counts for both.
function extractBranches() {
	const chain = [...code.matchAll(/(?:if|\}\s*else if)\s*\(\s*step\.action ===\s*"(\w+)"([\s\S]*?)\)\s*\{/g)];
	const blocks = new Map();
	for (let i = 0; i < chain.length; i++) {
		const m = chain[i];
		const names = [m[1], ...[...m[2].matchAll(/step\.action ===\s*"(\w+)"/g)].map((x) => x[1])];
		const start = m.index + m[0].length;
		const end = i + 1 < chain.length ? chain[i + 1].index : code.length;
		const body = code.slice(start, end);
		for (const n of names) {
			// A branch condition can appear twice (the outer `if` and an inner
			// re-test, e.g. `if (step.action === "mouse_click_cell")`). Union the
			// bodies rather than letting the later, smaller one win.
			blocks.set(n, (blocks.get(n) ?? "") + "\n" + body);
		}
	}
	return blocks;
}

// A named function's body, for following args into a helper.
function functionBody(name) {
	const start = code.search(new RegExp(`^(?:async )?function ${name}\\s*\\(`, "m"));
	assert.notEqual(start, -1, `expected a function named ${name} in run_scenario.mjs`);
	const rest = code.slice(start + 1);
	const nextTop = rest.search(/^(?:async )?function \w+\s*\(/m);
	return nextTop === -1 ? rest : rest.slice(0, nextTop);
}

// THE HAND-MAINTAINED PART. An action whose handler hands `step.args` (or a
// rest of it) to a helper consumes whatever that helper destructures. There is
// no way to derive this without evaluating the code, so it is written down, and
// the tests below check that every target still exists.
const FOLLOWS = {
	// `const { fatal, ...lintOpts } = step.args` -> runUiLint(t, lintOpts)
	ui_lint: ["runUiLint"],
	// runUiSweep(t, ..., step.args ?? {})
	ui_sweep: ["runUiSweep"],
};

// Arg names consumed by one action's handler, following helpers per FOLLOWS.
function consumedArgs(action, blocks) {
	const body = blocks.get(action);
	assert.ok(body, `no handler branch found for "${action}"`);
	const names = destructuredFrom(body, "step\\.args");
	// Direct reaches: `step.args?.fatal`, `step.args.x`.
	for (const m of body.matchAll(/step\.args\??\.(\w+)/g)) names.add(m[1]);
	for (const helper of FOLLOWS[action] ?? []) {
		for (const n of destructuredFrom(functionBody(helper), "opts")) names.add(n);
	}
	return names;
}

// The spec table, read out of the source rather than imported — importing
// run_scenario.mjs runs its config loading and calls process.exit(2).
function extractSpecs() {
	const m = code.match(/const BUILTIN_RUNNER_ACTIONS = \{([\s\S]*?)\n\};/);
	assert.ok(m, "BUILTIN_RUNNER_ACTIONS not found — this test's whole subject is gone");
	const specs = {};
	for (const entry of m[1].matchAll(/(\w+):\s*\{\s*required:\s*\[([^\]]*)\],\s*optional:\s*\[([^\]]*)\]/g)) {
		const list = (s) => [...s.matchAll(/"(\w+)"/g)].map((x) => x[1]);
		specs[entry[1]] = { required: list(entry[2]), optional: list(entry[3]) };
	}
	return specs;
}

const blocks = extractBranches();
const SPECS = extractSpecs();

// Actions whose handler reads NO args at all. Listed rather than inferred so a
// handler that silently loses its arg reading cannot land here by accident.
const ARGLESS = new Set(["dump_state", "screenshot"]);

// ---------------------------------------------------------------------------
// Sanity: the extractor still sees what it is supposed to see
// ---------------------------------------------------------------------------

test("the extractor finds every declared runner action's handler branch", () => {
	assert.ok(Object.keys(SPECS).length >= 20, `only parsed ${Object.keys(SPECS).length} specs`);
	for (const action of Object.keys(SPECS)) {
		assert.ok(blocks.has(action), `no \`step.action === "${action}"\` branch — spec'd but unreachable?`);
	}
});

test("EXTRACTION FLOOR: every arg-taking action still yields arg names", () => {
	// The failure this guards is the test going quietly blind: a refactor that
	// changes how handlers read args (a helper, computed keys, an options
	// object) would make consumedArgs() return empty sets, and every assertion
	// below would then pass vacuously. A green run must mean "checked", not
	// "found nothing to check".
	for (const action of Object.keys(SPECS)) {
		if (ARGLESS.has(action)) continue;
		assert.ok(consumedArgs(action, blocks).size > 0,
			`extracted 0 arg names for "${action}" — the extractor has gone blind, not the handler clean`);
	}
});

test("every FOLLOWS target is a real function that destructures opts", () => {
	assert.ok(Object.keys(FOLLOWS).length > 0, "FOLLOWS must not be silently emptied");
	for (const [action, helpers] of Object.entries(FOLLOWS)) {
		assert.ok(SPECS[action], `FOLLOWS names "${action}", which is not a declared action`);
		for (const helper of helpers) {
			assert.ok(destructuredFrom(functionBody(helper), "opts").size > 0,
				`${helper}() no longer destructures opts — FOLLOWS is stale and ${action} is now unchecked`);
		}
	}
});

// ---------------------------------------------------------------------------
// The contract itself
// ---------------------------------------------------------------------------

test("no runner action reads an arg its spec does not declare", () => {
	// This direction is the dangerous one in reverse: an arg the runtime honors
	// but the spec omits gets flagged by the validator as an unknown key, so a
	// scenario using a real feature is warned at for using it.
	const problems = [];
	for (const action of Object.keys(SPECS)) {
		if (ARGLESS.has(action)) continue;
		const declared = new Set([...SPECS[action].required, ...SPECS[action].optional]);
		for (const name of consumedArgs(action, blocks)) {
			if (!declared.has(name)) problems.push(`${action}: reads "${name}", spec does not declare it`);
		}
	}
	assert.deepEqual(problems, [], problems.join("\n"));
});

test("no runner action declares an arg no line of its handler reads", () => {
	// And this is the direction that produced the mouse_scroll incident: the
	// spec promises an arg, the validator accepts it, and the runtime never
	// looks — so the step passes having done something other than what it says.
	const problems = [];
	for (const action of Object.keys(SPECS)) {
		if (ARGLESS.has(action)) continue;
		const consumed = consumedArgs(action, blocks);
		for (const name of [...SPECS[action].required, ...SPECS[action].optional]) {
			if (!consumed.has(name)) problems.push(`${action}: declares "${name}", no handler line reads it`);
		}
	}
	assert.deepEqual(problems, [], problems.join("\n"));
});

// ---------------------------------------------------------------------------
// The five specific regressions, pinned by name
// ---------------------------------------------------------------------------
//
// The two sweeps above would catch each of these. They are also spelled out
// individually, because a sweep failure says "drift" and these say WHICH drift
// came back — and because each one is a fact about the published contract that
// a future edit should have to argue with explicitly.

test("mouse_scroll accepts the documented dx/dy AND the legacy delta_y", () => {
	const body = blocks.get("mouse_scroll");
	const spec = SPECS.mouse_scroll;
	for (const name of ["dx", "dy", "delta_y"]) {
		assert.ok([...spec.required, ...spec.optional].includes(name), `spec must list ${name}`);
	}
	assert.match(body, /dy \?\? delta_y/, "dy must win, with delta_y as the fallback");
	// The horizontal axis was declared, accepted, and then hardcoded to 0.
	assert.match(body, /page\.mouse\.wheel\(dx,/, "dx must reach the wheel, not a literal 0");
	// delta_y is a legacy alias kept for back-compat with catalogs written before
	// the dx/dy axes existed; the spec lists it and the runtime falls back to it
	// (both asserted above). No shipped catalog is required to justify it — the
	// contract does, and removing the alias would be a breaking change to it.
});

test("mouse_click_menu_item's spec names label/id, the keys the runtime reads", () => {
	const spec = SPECS.mouse_click_menu_item;
	assert.deepEqual(spec.required, [],
		"neither label nor id is individually required — either will resolve the item");
	assert.ok(spec.optional.includes("label") && spec.optional.includes("id"));
	assert.ok(!spec.required.includes("text") && !spec.optional.includes("text"),
		'"text" was required by the validator and read by nothing');
});

test("ui_lint declares the switches it consumes and not the `rules` it never had", () => {
	const spec = SPECS.ui_lint;
	const all = [...spec.required, ...spec.optional];
	for (const name of ["text_inset", "sibling_overlap", "near_misalign", "clipped_text",
		"min_inset", "overlap_tolerance", "whitelist", "fatal"]) {
		assert.ok(all.includes(name), `ui_lint consumes ${name} — the spec must say so`);
	}
	assert.ok(!all.includes("rules"), "`rules` is assert_consistent's arg; ui_lint never read it");
});

test("ui_sweep and scroll_stability declare their whole surface", () => {
	const sweep = [...SPECS.ui_sweep.required, ...SPECS.ui_sweep.optional];
	for (const name of ["whitelist", "seconds", "samples", "screenshots", "include_chart", "fatal"]) {
		assert.ok(sweep.includes(name), `ui_sweep consumes ${name}`);
	}
	// `label` came off: ui_sweep reads the TOP-LEVEL step.label, so a scenario
	// nesting it under args would have been validated and then ignored.
	assert.ok(!sweep.includes("label"), "ui_sweep reads step.label, not args.label");
	assert.match(blocks.get("ui_sweep"), /safeFileLabel\(step\.label,/);

	const scroll = [...SPECS.scroll_stability.required, ...SPECS.scroll_stability.optional];
	for (const name of ["seconds", "samples", "fatal"]) {
		assert.ok(scroll.includes(name), `scroll_stability consumes ${name}`);
	}
});

test("assert_state and wait_for do not list `label` as an arg", () => {
	// step.label is universal and top-level. Listing it under args told authors
	// to write it in the one place the runtime does not look.
	for (const action of ["assert_state", "wait_for"]) {
		const all = [...SPECS[action].required, ...SPECS[action].optional];
		assert.ok(!all.includes("label"), `${action}: label is a top-level step key, not an arg`);
	}
	assert.match(code, /const UNIVERSAL_STEP_KEYS = new Set\(\[[^\]]*"label"/,
		"…and it must still be accepted at the top level");
});
