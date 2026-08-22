// Contract tests for the generic bridge addon. Run as part of: npm test
//
// There is no Godot binary on this machine, so these are STATIC tests: they
// parse addons/playtest_bridge/playtest_bridge.gd as text and assert the
// invariants BRIDGE_CONTRACT.md declares non-negotiable:
//
//   §1 the security gate precedes every registration
//   §2 every create_callback result lands in a member variable
//   §3 every registered action reports its result, failure paths included
//   plus: click/press/key synthesize real InputEvents, and the fallback
//   dump_state stands down when a hand-written bridge already claimed the name
//
// HONESTY NOTE, read before trusting a green run: a regex cannot follow
// GDScript control flow. Where an assertion is an approximation, the limit is
// named in a comment at the assertion. What these tests actually buy is that
// the *shape* that has already bitten once (an action returning without
// reporting, a callback in a local, gating added after registration) cannot
// reappear in this file without a test going red.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE = path.join(ROOT, "addons", "playtest_bridge", "playtest_bridge.gd");

const raw = readFileSync(BRIDGE, "utf8");

// Strip comments so a pattern in a docstring can't satisfy an assertion about
// code. LIMIT: naive — assumes no '#' inside string literals, which holds for
// this file and is cheap to keep true.
const source = raw
	.split("\n")
	.map((line) => {
		const hash = line.indexOf("#");
		return hash === -1 ? line : line.slice(0, hash);
	})
	.join("\n");

const lines = source.split("\n");

/**
 * Split the script into { name -> { start, bodyLines } }. A function runs from
 * its `func ` line to the next top-level `func `. LIMIT: assumes one class,
 * top-level funcs only — true of this file; inner classes would break it loudly
 * (the func they hide would come up missing, not silently pass).
 */
function parseFunctions() {
	const funcs = new Map();
	let current = null;
	lines.forEach((line, i) => {
		const m = line.match(/^func (\w+)\s*\(/);
		if (m) {
			current = { name: m[1], start: i, bodyLines: [] };
			funcs.set(m[1], current);
		} else if (current) {
			current.bodyLines.push({ text: line, index: i });
		}
	});
	return funcs;
}

const funcs = parseFunctions();
const body = (name) => {
	const f = funcs.get(name);
	assert.ok(f, `expected a function named ${name} in playtest_bridge.gd`);
	return f.bodyLines.map((l) => l.text).join("\n");
};

/** Map of callback member var -> handler func, from create_callback lines. */
function callbackAssignments() {
	const out = [];
	for (const line of lines) {
		const m = line.match(/^\s*(\S+)\s*=\s*JavaScriptBridge\.create_callback\((\w+)\)/);
		if (m) out.push({ variable: m[1], handler: m[2], line });
	}
	return out;
}

/** Map of window name -> callback var, from `_window.godotDebugX = _x_cb`. */
function windowRegistrations() {
	const out = [];
	for (const line of lines) {
		const m = line.match(/^\s*_window\.(godotDebug\w+)\s*=\s*(\w+)/);
		// godotDebugLastActionResult / LastState / LastControls are data vars,
		// not registrations — they're assigned JSON strings, not callbacks.
		if (m && m[2].endsWith("_cb")) out.push({ windowName: m[1], variable: m[2] });
	}
	return out;
}

// ---------------------------------------------------------------------------
// §1 — the security gate precedes every registration
// ---------------------------------------------------------------------------

test("_ready gates on is_debug_build and has_feature(web), each with an immediate return", () => {
	const ready = funcs.get("_ready");
	assert.ok(ready, "the bridge must have a _ready");
	const b = ready.bodyLines;

	for (const gate of ["OS.is_debug_build()", 'OS.has_feature("web")']) {
		const at = b.findIndex((l) => l.text.includes(`if not ${gate}`));
		assert.notEqual(at, -1, `_ready must check ${gate}`);
		const next = b.slice(at + 1).find((l) => l.text.trim() !== "");
		assert.equal(next.text.trim(), "return", `the ${gate} check must be an early return, not a warning`);
	}
});

test("the gate appears before anything that registers", () => {
	const ready = funcs.get("_ready");
	const gateAt = ready.bodyLines.findIndex((l) => l.text.includes('OS.has_feature("web")'));

	// Which functions actually create callbacks?
	const registrars = new Set();
	for (const [name, f] of funcs) {
		if (f.bodyLines.some((l) => l.text.includes("create_callback"))) registrars.add(name);
	}
	assert.ok(registrars.size > 0, "someone must register callbacks");
	assert.ok(!registrars.has("_ready"), "_ready itself must not create callbacks inline");

	// Every call site of a registrar must sit inside _ready, AFTER the gate.
	// LIMIT: textual, not a call graph — but a registrar invoked from anywhere
	// else (or before the gate) is exactly what this catches, and adding such a
	// call without tripping this requires hiding it from both patterns below.
	for (const name of registrars) {
		const callSites = [];
		for (const [caller, f] of funcs) {
			if (caller === name) continue;
			f.bodyLines.forEach((l, i) => {
				if (l.text.includes(`${name}(`) || l.text.includes(`call_deferred("${name}")`)) {
					callSites.push({ caller, bodyIndex: i });
				}
			});
		}
		assert.ok(callSites.length > 0, `${name} must actually be invoked`);
		for (const site of callSites) {
			assert.equal(site.caller, "_ready", `${name} may only be invoked from _ready (found in ${site.caller})`);
			assert.ok(site.bodyIndex > gateAt, `${name} must be invoked after the security gate`);
		}
	}
});

// ---------------------------------------------------------------------------
// §2 — every callback in a member variable
// ---------------------------------------------------------------------------

test("every create_callback result is assigned to a declared member variable", () => {
	const assignments = callbackAssignments();
	assert.ok(assignments.length >= 6, `expected at least 6 callbacks, found ${assignments.length}`);

	const memberVars = new Set();
	for (const line of lines) {
		const m = line.match(/^var (\w+)\s*:\s*JavaScriptObject/);
		if (m) memberVars.add(m[1]);
	}

	for (const a of assignments) {
		// A local would appear as `var _x := JavaScriptBridge.create_callback(...)`
		// — the assignment target starting with `var ` is the failure mode.
		assert.ok(!a.line.trim().startsWith("var "),
			`callback assigned to a LOCAL — it will be freed silently: ${a.line.trim()}`);
		assert.ok(memberVars.has(a.variable),
			`${a.variable} must be declared as a class-level `
			+ `'var ${a.variable}: JavaScriptObject' or the callback dies with the scope`);
	}
});

// ---------------------------------------------------------------------------
// §3 — every registered action reports its result
// ---------------------------------------------------------------------------

test("all six generic actions are registered under their contract names", () => {
	const names = windowRegistrations().map((r) => r.windowName);
	for (const expected of [
		"godotDebugDumpControls", "godotDebugClickControl", "godotDebugPressAction",
		"godotDebugSendKey", "godotDebugSetSlider", "godotDebugSelectTab", "godotDebugDumpState",
	]) {
		assert.ok(names.includes(expected), `${expected} must be registered`);
	}
});

test("every registered window callback is backed by a create_callback assignment", () => {
	const byVar = new Map(callbackAssignments().map((a) => [a.variable, a.handler]));
	for (const r of windowRegistrations()) {
		assert.ok(byVar.has(r.variable),
			`${r.windowName} is assigned ${r.variable}, which no create_callback populates`);
	}
});

test("every action handler reports a result, on every return path detectable statically", () => {
	const byVar = new Map(callbackAssignments().map((a) => [a.variable, a.handler]));
	for (const r of windowRegistrations()) {
		const handler = byVar.get(r.variable);
		const f = funcs.get(handler);
		assert.ok(f, `handler ${handler} for ${r.windowName} must exist`);
		const text = f.bodyLines.map((l) => l.text).join("\n");

		// Floor: the call appears at all.
		assert.match(text, /_report_action_result\(/,
			`${handler} never reports — the runner would read the PREVIOUS action's result`);

		// Better: every explicit `return` is preceded, within the same handler
		// and a short window, by a report — or by _resolve_control, which
		// reports on the caller's behalf before returning null (asserted
		// separately below). LIMIT: an 8-line lookback approximates "on this
		// path"; it cannot prove the report is on the same branch, only that an
		// unreported bare return can't sit alone.
		f.bodyLines.forEach((l, i) => {
			if (l.text.trim() !== "return") return;
			const windowText = f.bodyLines.slice(Math.max(0, i - 8), i).map(x => x.text).join("\n");
			assert.ok(
				/_report_action_result\(/.test(windowText) || /_resolve_control\(/.test(windowText),
				`${handler} has a return with no report in reach:\n${windowText}\n\treturn`,
			);
		});

		// And the implicit-return path: the handler's LAST statement must be a
		// report, or the success path silently leaves the previous action's
		// result behind while every failure path still reports — the exact bug
		// the lookback above can't see. Mutation-tested: deleting the tail
		// report is caught by this and by nothing else. LIMIT: "last statement"
		// is judged by indentation — lines after the report must be its own
		// continuation (deeper indent or a closer), not a new statement.
		const code = f.bodyLines.filter((l) => l.text.trim() !== "");
		const lastReport = code.map((l) => l.text).findLastIndex((t) => t.trim().startsWith("_report_action_result("));
		assert.notEqual(lastReport, -1, `${handler} must end by reporting`);
		const reportIndent = code[lastReport].text.match(/^\t*/)[0].length;
		for (const l of code.slice(lastReport + 1)) {
			const indent = l.text.match(/^\t*/)[0].length;
			assert.ok(indent > reportIndent || /^[}\])]/.test(l.text.trim()),
				`${handler}'s final statement must be the report; found after it: ${l.text.trim()}`);
		}
	}
});

test("_resolve_control reports the failure itself before every null return", () => {
	// This is what licenses callers to `if c == null: return` without their own
	// report — if this helper ever stops reporting, every path through it
	// becomes a stale-result bug at once.
	const f = funcs.get("_resolve_control");
	assert.ok(f, "_resolve_control must exist");
	f.bodyLines.forEach((l, i) => {
		if (l.text.trim() !== "return null") return;
		const windowText = f.bodyLines.slice(Math.max(0, i - 4), i).map(x => x.text).join("\n");
		assert.match(windowText, /_report_action_result\(/,
			"_resolve_control returned null without reporting why");
	});
});

test("_report_action_result writes JSON to the contract's result var", () => {
	const text = body("_report_action_result");
	assert.match(text, /godotDebugLastActionResult\s*=\s*JSON\.stringify\(/,
		"results must land on window.godotDebugLastActionResult as JSON");
});

// ---------------------------------------------------------------------------
// Input synthesis — the reason the generic click is trustworthy
// ---------------------------------------------------------------------------

test("click/press/key synthesize real InputEvents; no direct method-call bypass", () => {
	const byVar = new Map(callbackAssignments().map((a) => [a.variable, a.handler]));
	const handlerFor = (windowName) => {
		const r = windowRegistrations().find((x) => x.windowName === windowName);
		return byVar.get(r.variable);
	};

	for (const name of ["godotDebugClickControl", "godotDebugPressAction", "godotDebugSendKey"]) {
		const text = body(handlerFor(name));
		assert.match(text, /Input\.parse_input_event\(/,
			`${name} must go through Input.parse_input_event — a synthesized event proves the `
			+ `control is hittable; a method call proves only that the method works`);
		// LIMIT: a denylist, not a proof — but emit_signal/.emit( are the two
		// idioms a "just trigger it directly" shortcut would actually use.
		assert.doesNotMatch(text, /emit_signal|\.emit\(/,
			`${name} must not shortcut past the input pipeline by emitting signals`);
	}
});

test("dump_controls writes the tree to its own window var", () => {
	const byVar = new Map(callbackAssignments().map((a) => [a.variable, a.handler]));
	const r = windowRegistrations().find((x) => x.windowName === "godotDebugDumpControls");
	const text = body(byVar.get(r.variable));
	assert.match(text, /godotDebugLastControls\s*=\s*JSON\.stringify\(/,
		"the control tree goes to window.godotDebugLastControls; the result var carries the summary");
});

// ---------------------------------------------------------------------------
// The coexistence rule — the hand-written bridge wins
// ---------------------------------------------------------------------------

test("the fallback dump_state checks for a hand-written one and stands down", () => {
	// Find the function that assigns window.godotDebugDumpState.
	let owner = null;
	for (const [name, f] of funcs) {
		if (f.bodyLines.some((l) => /_window\.godotDebugDumpState\s*=/.test(l.text))) owner = f;
	}
	assert.ok(owner, "some function must register the dump_state fallback");

	const evalAt = owner.bodyLines.findIndex((l) =>
		l.text.includes("JavaScriptBridge.eval") && l.text.includes("typeof window.godotDebugDumpState"));
	const assignAt = owner.bodyLines.findIndex((l) => /_window\.godotDebugDumpState\s*=/.test(l.text));
	assert.notEqual(evalAt, -1,
		"the fallback must probe typeof window.godotDebugDumpState through the browser, "
		+ "not a member flag — the check is against what the page actually sees");
	assert.ok(evalAt < assignAt, "the probe must come before the registration");

	// Between probe and registration there must be an early return: the
	// stand-down. LIMIT: presence of a return between the two lines, not
	// branch analysis — but removing the stand-down removes that return.
	const between = owner.bodyLines.slice(evalAt, assignAt).map((l) => l.text.trim());
	assert.ok(between.includes("return"),
		"finding a hand-written godotDebugDumpState must make the fallback stand down");

	// And the stand-down must be checked AFTER other autoloads have had their
	// _ready — i.e. this function is invoked deferred, never inline.
	const readyText = body("_ready");
	assert.match(readyText, new RegExp(`call_deferred\\("${owner.name}"\\)`),
		`${owner.name} must run deferred, or a hand-written bridge loaded later would lose by accident of autoload order`);
});

test("the generic dump_state declares itself generic", () => {
	// A scenario must be able to tell which bridge answered; a hand-written
	// state that happens to lack a field must not be mistaken for the fallback.
	const byVar = new Map(callbackAssignments().map((a) => [a.variable, a.handler]));
	const r = windowRegistrations().find((x) => x.windowName === "godotDebugDumpState");
	const text = body(byVar.get(r.variable));
	assert.match(text, /"generic_bridge":\s*true/, "the fallback state must be tagged generic_bridge: true");
	assert.match(text, /"version":\s*\d+/, "even the generic state carries a schema version (contract §5)");
	assert.match(text, /godotDebugLastState\s*=\s*JSON\.stringify\(/,
		"state goes to window.godotDebugLastState like any dump_state");
});

// ---------------------------------------------------------------------------
// NaN/INF JSON hardening — JSON has no encoding for either, and Godot's
// JSON.stringify emits non-standard tokens for them that crash a strict
// JS-side JSON.parse. A legitimate-but-weird game float must not turn into a
// hard step failure.
// ---------------------------------------------------------------------------

test("_jsonable maps NAN/INF floats to null before anything reaches JSON.stringify", () => {
	const text = body("_jsonable");
	assert.match(text, /is_nan\(value\)/, "_jsonable must special-case NaN floats");
	assert.match(text, /is_inf\(value\)/, "_jsonable must special-case +/-Infinity floats");
	// The NaN/INF branch must return null, not the raw value or its str().
	const nanBranch = text.slice(text.indexOf("is_nan"), text.indexOf("is_nan") + 200);
	assert.match(nanBranch, /return null/, "NaN/INF must map to null, the honest JSON signal for a non-finite float");
});

test("every outgoing JSON.stringify call is routed through _jsonable", () => {
	// _report_action_result and the fallback dump_state are the two places a
	// Dictionary containing arbitrary game floats reaches JSON.stringify.
	const reportText = body("_report_action_result");
	assert.match(reportText, /JSON\.stringify\(_jsonable\(result\)\)/,
		"_report_action_result must sanitize its result through _jsonable before stringifying");
});

// ---------------------------------------------------------------------------
// Autoload-dump data exposure — debug-build gating is not an access control.
// An autoload holding secrets can opt out of the fallback dump entirely.
// ---------------------------------------------------------------------------

test("an autoload can opt out of the fallback dump via PLAYTEST_BRIDGE_HIDDEN", () => {
	assert.ok(funcs.has("_is_playtest_bridge_hidden"),
		"expected a helper recognizing an autoload's PLAYTEST_BRIDGE_HIDDEN opt-out");
	const helperText = body("_is_playtest_bridge_hidden");
	assert.match(helperText, /PLAYTEST_BRIDGE_HIDDEN/,
		"the opt-out constant name must be PLAYTEST_BRIDGE_HIDDEN, matching README.md's documented mechanism");

	const dumpText = body("_on_dump_state");
	assert.match(dumpText, /_is_playtest_bridge_hidden\(child\)/,
		"_on_dump_state must actually consult the opt-out before adding an autoload's properties to the dump");
});
