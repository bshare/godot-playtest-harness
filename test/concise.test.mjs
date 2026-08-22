// Tests for concise() and pickConcise() — the /state projection that decides
// what a text-driven agent can see. The motivating incident: an early persona
// pass on a turn-based game fought two "elite" enemies and reported,
// confidently and wrongly, that none appeared — an over-eager filter ate the
// elite flag the game's dump carried. The lesson drives the design here: the
// default projection hides NOTHING (a silent omission is a lie about the game),
// and a game that wants a smaller /state owns that decision by exporting its
// own `concise` from its game_module.

import { test } from "node:test";
import assert from "node:assert/strict";

import { concise, pickConcise } from "../src/concise.mjs";

test("the default projection is the identity — it hides nothing", () => {
	const state = {
		screen: "combat",
		nested: { a: 1, deep: { flag: true } },
		list: [1, 2, 3],
		anything_the_game_marked_special: "survives",
	};
	assert.deepEqual(concise(state), state,
		"a wrong guess about which fields matter is the exact failure this module exists to prevent");
});

test("no state at all is an error object, not a crash", () => {
	assert.deepEqual(concise(null), { error: "no state" });
	assert.deepEqual(concise(undefined), { error: "no state" });
});

test("pickConcise returns the game's concise when the module exports one", () => {
	const custom = (s) => ({ only: s.keep });
	const chosen = pickConcise({ concise: custom });
	assert.equal(chosen, custom, "a game_module owns its own projection");
	assert.deepEqual(chosen({ keep: 7, drop: 8 }), { only: 7 });
});

test("pickConcise falls back to the identity default when there is no usable export", () => {
	assert.equal(pickConcise(null), concise, "no module");
	assert.equal(pickConcise({}), concise, "module without a concise export");
	assert.equal(pickConcise({ concise: "not a function" }), concise, "non-function export");
	assert.equal(pickConcise(undefined), concise, "undefined module");
});
