// concise.mjs — the /state projection for control_server.mjs, alone in its own
// module so it is testable: control_server does real work (server, browser,
// static host) at import time by design, which makes anything living inside it
// untestable without a game. This module decides WHAT A TEXT-DRIVEN AGENT CAN
// SEE on every /state and /act, so it is the piece that must be pinned.
//
// WHAT TO KEEP IS GAME-SPECIFIC, so the real projection belongs to the game.
// A deckbuilder's "this enemy is an elite" flag matters; an idle game's tick
// counter matters; a shooter's ammo count matters — and this module can know
// none of them. A game declares its projection by exporting `concise(state)`
// from the module named by playtest.config.json's `game_module` (the SAME
// module that already exports `consistencyRules` for run_scenario's
// assert_consistent). control_server picks it up through pickConcise() below.
//
// THE DEFAULT, for a game that exports none, is the identity: the full state
// passes through untouched, guarding only the no-state case. It deliberately
// makes NO guess about which fields matter. That is not laziness — it is the
// one safe default. The hazard this module exists to prevent is a filter that
// silently drops a field the game marked as important: an early persona pass
// on a turn-based game fought two "elite" enemies and reported, confidently
// and wrongly, that none appeared, because an over-eager filter ate the elite
// flag the game's dump carried. A silent omission in what an agent can
// perceive turns every downstream report into fiction about the omitted field.
// Showing everything can be noisy; hiding the wrong thing is a lie. A game
// whose raw state is too large for an agent's context is exactly the game that
// should write its own `concise` — a decision only its author can make
// correctly.

// The fallback projection: return the state as the game reported it. `!state`
// (null, or an unset window var read as null) becomes an explicit error object
// rather than a crash, so the caller distinguishes "no state yet" from "bridge
// broken" the same way the runner does.
export function concise(state) {
	if (!state) return { error: "no state" };
	return state;
}

// Selects the projection control_server will apply. A game_module that exports
// a `concise` function owns the projection; anything else (no module, a module
// without the export, a non-function export) falls back to the identity above.
// Extracted from control_server so the selection rule is unit-testable without
// booting a server or a browser.
export function pickConcise(gameModule) {
	const fn = gameModule?.concise;
	return typeof fn === "function" ? fn : concise;
}
