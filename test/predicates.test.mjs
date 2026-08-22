// Direct unit tests for the predicate vocabulary (src/predicates.mjs) — the
// review's top coverage gap: these functions decide every assert_state and
// wait_for verdict, and until the extraction they were only reachable by
// spawning run_scenario.mjs as a child process.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parsePath, resolvePath, reasonMatches, evaluateAssertState, ASSERT_STATE_OPS } from "../src/predicates.mjs";

const STATE = {
	version: 1,
	run: { day: 3, seed: "alpha-7", paused: false },
	grid: { modules: [{ id: "m1", x: 2 }, { id: "m2", x: 5 }] },
	resources: { oxygen: 41.5, scrap: 0, label: "41 units" },
	nothing: null,
};

// ---------------------------------------------------------------------------
// Path parsing and resolution
// ---------------------------------------------------------------------------

test("parsePath splits dots and array indices into string/number tokens", () => {
	assert.deepEqual(parsePath("grid.modules[0].x"), ["grid", "modules", 0, "x"]);
	assert.deepEqual(parsePath("a[1][2]"), ["a", 1, 2]);
	assert.throws(() => parsePath("a[!].b"), /malformed path segment/);
});

test("resolvePath finds nested values and reports missing paths as not-found", () => {
	assert.deepEqual(resolvePath(STATE, ["grid", "modules", 1, "id"]), { found: true, value: "m2" });
	assert.deepEqual(resolvePath(STATE, ["run", "no_such"]), { found: false, value: undefined });
	assert.deepEqual(resolvePath(STATE, ["nothing", "deeper"]), { found: false, value: undefined });
});

test("resolvePath never follows the prototype chain", () => {
	// "constructor"/"__proto__" resolved to inherited JS machinery before the
	// extraction — an assert could pass against something that was never in
	// the dump. A snapshot is plain JSON; inherited properties read as absent.
	assert.equal(resolvePath(STATE, ["constructor"]).found, false);
	assert.equal(resolvePath(STATE, ["run", "__proto__"]).found, false);
	assert.equal(resolvePath(STATE, ["grid", "modules", "length"]).found, true,
		"an array's length IS an own property and must keep resolving");
});

// ---------------------------------------------------------------------------
// evaluateAssertState — op semantics
// ---------------------------------------------------------------------------

test("exists tests presence itself; other ops fail cleanly on a missing path", () => {
	assert.equal(evaluateAssertState(STATE, "run.day", "exists").pass, true);
	assert.equal(evaluateAssertState(STATE, "run.ghost", "exists").pass, false);
	const r = evaluateAssertState(STATE, "run.ghost", "==", 3);
	assert.equal(r.pass, false);
	assert.match(r.message, /did not resolve/);
});

test("== numeric coercion is symmetric: number-vs-string passes both ways", () => {
	// The old rule coerced only when the EXPECTED side was a number, so a
	// scenario writing "3" against state 3 failed while 3 against "3" passed.
	assert.equal(evaluateAssertState({ n: 3 }, "n", "==", "3").pass, true);
	assert.equal(evaluateAssertState({ n: "3" }, "n", "==", 3).pass, true);
	assert.equal(evaluateAssertState({ n: 3 }, "n", "==", 3).pass, true);
	assert.equal(evaluateAssertState({ n: "3" }, "n", "!=", 3).pass, false);
});

test("null, booleans, and empty string never numerically coerce", () => {
	// Number(null) === 0 used to make `== 0` pass against null — a vacuous
	// pass on exactly the sentinel values a game uses for "unset".
	assert.equal(evaluateAssertState({ v: null }, "v", "==", 0).pass, false);
	assert.equal(evaluateAssertState({ v: false }, "v", "==", 0).pass, false);
	assert.equal(evaluateAssertState({ v: "" }, "v", "==", 0).pass, false);
	assert.equal(evaluateAssertState({ v: null }, "v", "==", null).pass, true, "strict identity still works");
});

test("ordering ops demand numbers on both sides and say so when denied", () => {
	assert.equal(evaluateAssertState(STATE, "resources.oxygen", ">", 40).pass, true);
	assert.equal(evaluateAssertState(STATE, "resources.oxygen", "<=", "41.5").pass, true, "numeric strings order fine");
	const r = evaluateAssertState(STATE, "run.seed", ">", 5);
	assert.equal(r.pass, false);
	assert.match(r.message, /needs numeric values on both sides/);
	const rNull = evaluateAssertState(STATE, "nothing", ">=", 0);
	assert.equal(rNull.pass, false, "null must not order as 0");
});

test("contains covers arrays, strings, and object keys", () => {
	assert.equal(evaluateAssertState({ a: [1, 2, 3] }, "a", "contains", 2).pass, true);
	assert.equal(evaluateAssertState(STATE, "resources.label", "contains", "units").pass, true);
	assert.equal(evaluateAssertState(STATE, "resources", "contains", "oxygen").pass, true);
	assert.equal(evaluateAssertState(STATE, "resources", "contains", "toString").pass, false,
		"object-key contains must not see inherited keys");
});

test("an unknown op throws — never a silent false or true", () => {
	assert.throws(() => evaluateAssertState(STATE, "run.day", "~=", 3), /unknown op/);
	assert.equal(ASSERT_STATE_OPS.size, 8);
});

// ---------------------------------------------------------------------------
// reasonMatches
// ---------------------------------------------------------------------------

test("reasonMatches accepts the whole string or the code before the colon", () => {
	assert.equal(reasonMatches("no_power: sector 3 offline", "no_power"), true);
	assert.equal(reasonMatches("no_power: sector 3 offline", "no_power: sector 3 offline"), true);
	assert.equal(reasonMatches("no_power: sector 3 offline", "offline"), false);
	assert.equal(reasonMatches(undefined, "no_power"), false);
});
