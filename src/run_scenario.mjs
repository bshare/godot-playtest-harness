// COORDINATION (2026-08-06): this file has a DOWNSTREAM COPY in
// github.com/bshare/godot-playtest-harness (the extracted, game-agnostic
// runner that will eventually replace this file). Do NOT modify it casually:
// a small/urgent fix is allowed but the commit message MUST say "needs
// porting to godot-playtest-harness"; anything non-urgent should be requested
// in the harness repo instead, where it benefits both games. The extraction
// snapshot predates several 2026-08-05/06 changes — see the porting list in
// the producer's coordination reply of 2026-08-06.
//
// Generic scenario runner — the "deterministic Playwright script" layer from
// docs/testing_and_validation.md §4.1: takes a JSON scenario file (a list of
// steps against the DebugBridge action catalog, see README.md), executes it
// exactly with no model in the loop, and writes an output bundle (every
// screenshot, a state snapshot at each dump_state step, the full step-by-step
// result log, and any browser console errors) for a later review pass to
// read. No judgment happens here — that's the point; this file is cheap to
// run precisely because it never calls a model.
//
// Usage:
//   node run_scenario.mjs scenarios/my_scenario.json
//   HEADED=1 node run_scenario.mjs scenarios/my_scenario.json
//
//   # Carry game state between separate invocations (each of which
//   # otherwise boots a fresh browser AND a fresh game — see README.md's
//   # "Cross-run state continuity" section for why this exists):
//   SESSION=my_playtest node run_scenario.mjs scenarios/round1.json
//   SESSION=my_playtest node run_scenario.mjs scenarios/round2.json  # resumes where round1 left off
//
// Requires a DEBUG Web export at build/web-debug/ (see README.md Setup).
// Never point this at build/web/ (the release export) — DebugBridge isn't
// there, and this will time out waiting for it.

// playwright is imported lazily inside the browser transport's start() rather
// than here, so `--validate` (the static, no-browser pre-flight check) works
// even in an environment where `npm install` hasn't been run for this package
// — the whole point of --validate is to be a cheap, dependency-light check a
// scenario author runs constantly while iterating. The transport modules
// themselves import only node builtins at load time.
import { setTimeout as sleep } from "node:timers/promises";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { createBrowserTransport } from "./transport/browser.mjs";
import { createDesktopTransport } from "./transport/desktop.mjs";
import { ASSERT_STATE_OPS, evaluateAssertState, reasonMatches } from "./predicates.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// ---- game configuration -----------------------------------------------------
// This runner is game-agnostic. Everything game-specific arrives from the game
// repo's playtest.config.json and the action catalog it names. See
// ACTION_CATALOG.md for the catalog format and BRIDGE_CONTRACT.md for what a
// game must implement to be drivable.
//
// Previously these were two hand-maintained tables in this file (ACTION_DEFS
// for the call convention, ACTION_ARG_SPECS for validation) carrying the same
// information in different shapes — so adding an action meant editing both, and
// they could silently drift apart. One catalog, one source of truth.
const GAME_ROOT = path.resolve(process.env.PLAYTEST_GAME_ROOT ?? process.cwd());
const CONFIG_PATH = process.env.PLAYTEST_CONFIG ?? path.join(GAME_ROOT, "playtest.config.json");

function loadJson(p, what) {
	if (!existsSync(p)) {
		console.error(`ERROR: ${what} not found at ${p}`);
		console.error(`Run from the game repo root, or set PLAYTEST_GAME_ROOT / PLAYTEST_CONFIG.`);
		process.exit(2);
	}
	try {
		return JSON.parse(readFileSync(p, "utf8"));
	} catch (e) {
		console.error(`ERROR: ${what} at ${p} is not valid JSON: ${e.message}`);
		process.exit(2);
	}
}

const CONFIG = loadJson(CONFIG_PATH, "playtest.config.json");
const CATALOG = loadJson(
	path.resolve(GAME_ROOT, CONFIG.action_catalog ?? "playtest.actions.json"),
	"action catalog",
);

const ACTION_DEFS = CATALOG.actions ?? {};
const RUNNER_ACTION_SPECS = CATALOG.runner_actions ?? {};

// "1920x1080" -> {width, height}; anything else -> null (fall through to the
// config value or the 1280x720 default). Malformed input falls back silently
// on purpose: a typo'd viewport should not abort a run the way a typo'd
// scenario should — the manifest records the size actually used.
// A step's `label` — and a ui_sweep stop id, which comes out of the game's own
// state — becomes a FILENAME. path.join resolves a traversal without complaint,
// so `{"label": "../../evil"}` wrote a PNG outside the run bundle, and a label
// containing a colon or a wildcard produced a file that some tools could not
// open and others could not delete. Neither needed malice: a label like
// "shop: after buying" is an ordinary thing for a scenario author to write.
//
// basename first (kills the separators and any drive-relative prefix), then map
// what is left to a conservative alphabet. Replacement rather than deletion so
// Every path recorded INTO a manifest goes through this: relative to the run
// bundle, forward slashes on every OS. A manifest is a portable artifact — a
// bundle produced on Windows gets read by prune/coverage/diff on Linux CI —
// and win32 path.relative's backslashes made those pointers silently
// unresolvable off-platform. Forward slashes work everywhere, including on
// Windows itself.
function relForManifest(from, to) {
	return path.relative(from, to).split(path.sep).join("/");
}

// the result still resembles what the author wrote — the filename is how a
// reviewer finds the shot, and "shop_ after buying" beats "shopafterbuying".
// `fallback` is used when nothing survives, so a screenshot is never written
// under a name the scenario cannot predict.
function safeFileLabel(raw, fallback) {
	const cleaned = path.basename(String(raw ?? "")).replace(/[^A-Za-z0-9._-]/g, "_");
	// A name that is only dots is legal on disk and confusing everywhere else.
	return /[A-Za-z0-9_-]/.test(cleaned) ? cleaned : fallback;
}

function parseViewport(spec) {
	if (!spec) return null;
	const m = /^(\d{2,5})x(\d{2,5})$/.exec(String(spec).trim());
	return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

// PLAYTEST_VIEWPORT=WxH (env) or config `viewport: {width, height}`. Default
// stays 1280x720 (the transport's own fallback); a game whose stretch math
// needs a specific window — integer-scale pixel art, high-DPI layouts — sets
// its own. Browser transport only; the desktop transport has no window.
const VIEWPORT = parseViewport(process.env.PLAYTEST_VIEWPORT) ?? CONFIG.viewport ?? undefined;

// Turns a step's `args` object into the positional argument list the bridge
// function expects, per the catalog's `positional` array. Each slot is either
// {name, default?, encode?} or {literal}. `encode: "json"` exists because some
// bridge functions take a JSON *string* rather than an object.
function buildArgs(actionName, args) {
	const def = ACTION_DEFS[actionName];
	const slots = def?.positional ?? [];
	return slots.map((slot) => {
		if ("literal" in slot) return slot.literal;
		// `bundle` hands the WHOLE args object over as one JSON string, for bridges
		// with a single generic handler per action. Declared as its own slot form
		// rather than an opaque {name:"args"} so `required`/`optional` keep
		// describing the payload's real contents — see ACTION_CATALOG.md.
		if (slot.bundle) return JSON.stringify(args ?? {});
		let v = args?.[slot.name];
		// undefined ONLY — an explicit null is a value the author wrote, and the
		// validator deliberately counts it as present ("null is a legitimate
		// asserted value"). Substituting the catalog default for it made the
		// validator say "present" while the call carried something the author
		// never typed: the silent-default class this file exists to kill.
		if (v === undefined) v = slot.default;
		if (slot.encode === "json") return JSON.stringify(v === undefined ? {} : v);
		return v;
	});
}

// ---- transport selection ----------------------------------------------------
// "browser" (the default): Playwright drives a WEB debug export through the
// window.godotDebug* functions — the original path, unchanged.
// "desktop": a --headless DESKTOP debug build is driven over a local TCP
// socket (src/transport/desktop.mjs; game side godot/tcp_bridge.template.gd;
// wire protocol in BRIDGE_CONTRACT.md "Desktop transport"). Scenarios, the
// action catalog, and every fn/var name are identical across both.
//
// An unknown value is a hard error HERE, before any browser or game boots —
// a typo'd transport silently falling back to the browser default would point
// the whole run at the wrong build, which is exactly the silent-substitution
// failure class the validator exists to prevent.
const TRANSPORT_KIND = CONFIG.transport ?? "browser";
if (TRANSPORT_KIND !== "browser" && TRANSPORT_KIND !== "desktop") {
	console.error(`ERROR: playtest.config.json "transport" must be "browser" or "desktop", got ${JSON.stringify(CONFIG.transport)}`);
	process.exit(2);
}

const BUILD_DIR = path.resolve(GAME_ROOT, CONFIG.build_dir ?? "build/web-debug");
// PLAYTEST_PORT is canonical; PORT accepted as a fallback (two concurrent agent
// sessions independently added an override for the same collision on the same day).
const PORT = Number(process.env.PLAYTEST_PORT ?? process.env.PORT ?? CONFIG.port ?? 8062);
const BASE_URL = `http://localhost:${PORT}`;
const HEADED = process.env.HEADED === "1";

// ---- bridge contract --------------------------------------------------------
// The names the runner needs in order to talk to ANY game's bridge. Defaults
// match the reference DebugBridge.gd; a game only overrides what it renames.
// See BRIDGE_CONTRACT.md.
const BRIDGE = {
	state_fn: "godotDebugDumpState",
	state_var: "godotDebugLastState",
	result_var: "godotDebugLastActionResult",
	cell_pos_fn: "godotDebugGetCellScreenPos",
	save_export_fn: "godotDebugExportSave",
	save_import_fn: "godotDebugImportSave",
	control_rect_fn: "godotDebugGetControlRect",
	context_menu_fn: "godotDebugGetContextMenuState",
	audit_ui_fn: "godotDebugAuditUi",
	scroll_state_fn: "godotDebugGetScrollState",
	ui_tree_fn: "godotDebugGetUiTree",
	// The generic bridge (addons/playtest_bridge, BRIDGE_CONTRACT.md §10).
	// Defaults match what the addon registers; overridable like everything else.
	controls_fn: "godotDebugDumpControls",
	controls_var: "godotDebugLastControls",
	click_control_fn: "godotDebugClickControl",
	press_action_fn: "godotDebugPressAction",
	send_key_fn: "godotDebugSendKey",
	set_slider_fn: "godotDebugSetSlider",
	select_tab_fn: "godotDebugSelectTab",
	...(CONFIG.bridge ?? {}),
};

// ---- evidence (ROADMAP Tier 2 item 7) --------------------------------------
// ALL opt-in. With none of these enabled, the run bundle and manifest are
// byte-identical to what they were before this feature existed — silent runner
// drift is the failure class this repo's whole test suite guards against.
// Each flag can come from playtest.config.json's "evidence" object or be
// forced on from the environment (PLAYTEST_EVIDENCE_VIDEO=1 etc.), because an
// agent chasing one flaky run should not have to edit a checked-in config.
const EVIDENCE_CFG = CONFIG.evidence ?? {};
const EVIDENCE = {
	video: process.env.PLAYTEST_EVIDENCE_VIDEO === "1" || EVIDENCE_CFG.video === true,
	trace: process.env.PLAYTEST_EVIDENCE_TRACE === "1" || EVIDENCE_CFG.trace === true,
	perf: process.env.PLAYTEST_EVIDENCE_PERF === "1" || EVIDENCE_CFG.perf === true,
	// How long the rAF frame counter runs when perf is on.
	fps_window_ms: Number(EVIDENCE_CFG.fps_window_ms ?? 2000),
};

// How to get from a cold page load to a state where scenario steps can run.
// A game that boots to a title screen needs one call to advance past it;
// a game that boots straight into play leaves this empty. Each entry is
// {fn, args} and is evaluated in order.
const BOOT_SEQUENCE = CONFIG.boot_sequence ?? [];
const BOOT_SEQUENCE_WITH_INTRO = CONFIG.boot_sequence_with_intro ?? BOOT_SEQUENCE;

// SESSION becomes a FILENAME under runs/_sessions/ — the same hazard class
// safeFileLabel exists for (a step label once wrote a PNG outside the bundle
// via "../../evil"). But a session id is an IDENTITY, not a display string:
// silently mangling it could collide two sessions that the author believes are
// distinct, so an unusable id is refused outright rather than repaired.
const SESSION = (() => {
	const raw = process.env.SESSION;
	if (raw === undefined || raw === "") return null;
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(raw) || raw.includes("..")) {
		console.error(
			`ERROR: SESSION "${raw}" is not a usable session id. It names a file under runs/_sessions/, ` +
			`so it must start with a letter or digit and contain only letters, digits, dots, hyphens and ` +
			`underscores (no path separators, no "..", no ":").`);
		process.exit(2);
	}
	return raw;
})();
const RUNS_DIR = path.resolve(GAME_ROOT, CONFIG.runs_dir ?? "runs");
const SESSIONS_DIR = path.join(RUNS_DIR, "_sessions");

// Maps a scenario step's "action" to the window function DebugBridge exposes
// and how to turn that step's "args" object into the positional argument
// list the function expects. See README.md's action catalog table for the
// authoritative description of each — this is just the calling convention.


// ============================================================================
// Step validation — added after a scenario with "x"/"y" as TOP-LEVEL step
// keys (instead of nested under "args") ran 14/14 "succeeded" while every
// mouse action silently defaulted to `step.args.x ?? 0` -> pixel/cell (0,0),
// producing a false "the Close button is dead" BLOCKER verdict (blind
// critique v0.9 F1 — see f1_verify_close_button.json's note and
// test/unit/test_help_ui.gd's writeup). The runner's old behavior for any
// unrecognized/misplaced key was to silently ignore it and fall back to a
// default (often 0), which makes a malformed scenario "pass" while testing
// nothing.
//
// Rule: a step that would silently do something DIFFERENT from what its
// author wrote must be a hard error, raised before the browser even opens.
// A genuinely optional arg being absent is fine and not flagged.
// ============================================================================

// Keys every step is allowed to carry regardless of action. "ms" is
// deliberately NOT here — it's valid only on "wait" steps and is checked
// specially below, precisely because "ms" as a top-level key vs. under
// "args" is the exact mistake this validator exists to catch.
// "expect"/"expect_reason" (harness-assertions, audit finding E1) let ANY
// bridge-action step declare what it expects its own result to be —
// "success", "refused", or a specific refusal `reason` — so a refused
// mechanic recorded as a passed step (tooling_audit_v1.md Demo 1: a repair
// that correctly refuses reports `ok: true` and the run exits 0) becomes a
// FAILED step instead. Default (neither key present) is unchanged legacy
// behavior — don't judge the result at all — so the 234 scenarios that
// predate this feature stay green without modification.
const UNIVERSAL_STEP_KEYS = new Set(["action", "args", "label", "note", "screenshot_after", "expect", "expect_reason"]);

// Required/optional argument names for each DebugBridge action, mirroring
// ACTION_DEFS' buildArgs above. "required" missing (absent or undefined) is a
// hard error. Unknown keys inside "args" that aren't in either list are a
// warning (likely a typo — support-but-warn, since we can't be sure it's not
// a deliberately-ignored extra field some caller relies on).
// Required/optional argument names per action, read straight off the catalog.
// A "required" arg that is absent or undefined is a hard error. Unknown keys inside
// "args" are a warning — likely a typo, but we can't be certain it isn't a
// deliberately-ignored extra some caller relies on.
const ACTION_ARG_SPECS = Object.fromEntries(
	Object.entries(ACTION_DEFS).map(([name, def]) => [
		name,
		{ required: def.required ?? [], optional: def.optional ?? [] },
	]),
);

// Non-bridge (runner-level) pseudo-actions. "wait" has no "args" spec at all
// — its ONLY parameter, "ms", is a top-level step key, not an args key. That
// asymmetry (every bridge action takes args, wait doesn't) is exactly what
// makes it easy to write `{"action": "wait", "args": {"ms": ...}}` by
// analogy, which is the incident this validator exists to prevent.
// Runner-level pseudo-actions. "wait" has no "args" spec at all — its ONLY
// parameter, "ms", is a top-level step key, not an args key. That asymmetry
// (every bridge action takes args, wait doesn't) is exactly what makes it easy
// to write {"action": "wait", "args": {"ms": ...}} by analogy, which is the
// incident this validator exists to prevent.
// Runner-level pseudo-actions are capabilities of THIS RUNNER, not facts about
// a game, so they ship built in and a game's catalog does not have to declare
// them. Found the hard way: the first fresh game wired up after the extraction
// wrote its own catalog, omitted these (reasonably — it had no way to know they
// existed), and silently lost assert_state and every mouse action.
//
// A game's `runner_actions` still merges on top, so it can add or override —
// but declaring nothing now gets you everything the runner can do.
//
// Some of these need an optional bridge function (cell/control/UI-tree helpers).
// They are still listed here: a missing bridge function fails loudly at runtime
// with a message naming what to implement, which is far better than the action
// silently not existing at validation time.
// THESE SPECS ARE THE PUBLISHED CONTRACT, and they must name exactly what the
// handlers actually read. Five of them did not, and the failure was silent by
// construction: the validator green-lights the arg it declares, the handler
// reads a different key, finds nothing, falls back to a default, and the step
// records ok:true. A `mouse_scroll` with the documented `dy` validated cleanly
// and then scrolled (0, 0). `mouse_click_menu_item` demanded a `text` arg the
// runtime never looked at while ignoring the `label`/`id` it does read.
// `ui_lint` advertised a `rules` key that no line consumes and hid the six that
// it does. `ui_sweep` and `scroll_stability` each hid half their surface.
//
// test/arg_contract.test.mjs now walks every handler's real consumption against
// this table, so the next drift is a red test rather than an incident. When an
// entry here looks redundant, check that test before deleting it.
const BUILTIN_RUNNER_ACTIONS = {
	dump_state: { required: [], optional: [] },
	screenshot: { required: [], optional: [] },
	// `label` is a TOP-LEVEL step key (UNIVERSAL_STEP_KEYS), not an arg. It was
	// listed here too, which invited scenarios to nest it under args where the
	// runtime would never see it.
	assert_state: { required: ["path", "op"], optional: ["value", "fatal"] },
	wait_for: { required: ["path", "op"], optional: ["value", "timeout_ms", "poll_ms", "fatal"] },
	mouse_move: { required: ["x", "y"], optional: ["steps"] },
	mouse_click: { required: ["x", "y"], optional: ["steps"] },
	mouse_right_click: { required: ["x", "y"], optional: ["steps"] },
	// dx/dy are the documented names and now the ones the handler prefers;
	// delta_y stays a supported alias for back-compat with catalogs written
	// before the dx/dy axes existed, so dropping it would break scenarios
	// written against those older catalogs.
	mouse_scroll: { required: ["x", "y"], optional: ["dx", "dy", "delta_y"] },
	mouse_move_cell: { required: ["x", "y"], optional: ["steps"] },
	mouse_click_cell: { required: ["x", "y"], optional: ["steps"] },
	mouse_right_click_cell: { required: ["x", "y"], optional: ["steps"] },
	// `node_name` is the legacy spelling the handler still accepts.
	mouse_move_control: { required: ["node"], optional: ["steps", "node_name"] },
	mouse_click_control: { required: ["node"], optional: ["steps", "node_name"] },
	// Neither label nor id is required at validation time because EITHER will
	// do; menuItemToPagePoint throws by name when both are missing.
	mouse_click_menu_item: { required: [], optional: ["label", "id", "steps"] },
	ui_lint: {
		required: [],
		optional: ["whitelist", "fatal", "text_inset", "sibling_overlap",
			"near_misalign", "clipped_text", "min_inset", "overlap_tolerance"],
	},
	ui_sweep: {
		required: [],
		optional: ["whitelist", "seconds", "samples", "screenshots", "include_chart", "fatal"],
	},
	assert_ui_swept: { required: [], optional: ["fatal"] },
	assert_no_occlusion: { required: [], optional: ["whitelist", "fatal"] },
	assert_board_visible: { required: [], optional: ["fatal"] },
	assert_consistent: { required: [], optional: ["rules", "fatal"] },
	scroll_stability: { required: [], optional: ["seconds", "samples", "fatal"] },
};

const NON_BRIDGE_ARG_SPECS = { ...BUILTIN_RUNNER_ACTIONS, ...RUNNER_ACTION_SPECS };

// Built-in actions for the GENERIC bridge (addons/playtest_bridge,
// BRIDGE_CONTRACT.md §10). These are plain bridge calls — they work over both
// transports — but they ship built into the runner for the same reason the
// pseudo-actions above do: they are a fact about the harness's own addon, not
// about any one game, and a game driving the generic bridge should not have to
// declare them in a catalog it may not even have written yet.
//
// Deliberately the LOWEST precedence: a game's catalog (`actions` or
// `runner_actions`) that defines one of these names wins, both in validation
// and at runtime, so adopting the addon never shadows a hand-written action.
// Unlike the pseudo-actions, these DO produce a bridge {"success": ...} result,
// so "expect"/"expect_reason" are valid on them.
const GENERIC_BRIDGE_ACTIONS = {
	dump_controls: { required: [], optional: [] },
	click_control: { required: ["path"], optional: [] },
	press_action: { required: ["action_name"], optional: ["pressed"] },
	send_key: { required: ["keycode"], optional: ["pressed", "unicode"] },
	set_slider: { required: ["path", "value"], optional: [] },
	select_tab: { required: ["path", "tab_index"], optional: [] },
};

// Every argument name used by ANY action, across both specs — this is the
// "looks like a misplaced arg" set. A stray top-level step key matching one
// of these is the exact motivating incident (x/y as siblings of "action"
// instead of nested under "args") and is always a hard error, regardless of
// which action the step actually names — the whole danger is that it reads
// as plausible for some action. "cell" and "name" are added by hand: neither
// is an actual arg name today, but both are exactly the shape of key a
// scenario author reaches for by analogy (a cell coordinate pair, or a
// screenshot/step name) and both would silently vanish if misplaced.
const ARG_SHAPED_KEYS = new Set([
	...Object.values(ACTION_ARG_SPECS).flatMap((s) => [...s.required, ...s.optional]),
	...Object.values(NON_BRIDGE_ARG_SPECS).flatMap((s) => [...s.required, ...s.optional]),
	...Object.values(GENERIC_BRIDGE_ACTIONS).flatMap((s) => [...s.required, ...s.optional]),
	"cell", "name",
]);

// Present means "the key exists and isn't undefined". An explicit null COUNTS
// AS PRESENT, deliberately: null is a legitimate asserted value, and eight real
// scenarios use {op: "==", value: null} to assert a field was cleared. Treating
// null as missing refuses those scenarios outright.
//
// (The spec comment above the arg tables used to say "undefined/null", which
// overstated it. The harness's own test suite flagged the mismatch; validating
// the stricter reading against the real scenario library is what showed the
// CODE was right and the COMMENT was wrong, not the other way round.)
function hasOwn(obj, key) {
	return obj != null && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined;
}

// Validates one step. Pushes strings into `errors` (fatal — the run must not
// start) and `warnings` (printed but non-fatal). `index` is the step's
// position in the scenario's "steps" array, used to make every message
// locatable without needing line numbers out of raw JSON.
function validateStep(step, index, errors, warnings) {
	const where = `step ${index}${step && step.label ? ` ("${step.label}")` : ""}`;

	if (step === null || typeof step !== "object" || Array.isArray(step)) {
		errors.push(`${where}: not an object`);
		return;
	}
	if (typeof step.action !== "string" || step.action.length === 0) {
		errors.push(`${where}: missing/invalid "action" (must be a non-empty string)`);
		return;
	}
	const action = step.action;

	// Top-level keys: only the universal set, plus "ms" but ONLY on "wait".
	// Anything else at the top level that looks like it belongs under "args"
	// (x, y, cell, seconds, name, module_id, system_id, ...) is the exact
	// failure mode from the motivating incident — never silently ignored.
	for (const key of Object.keys(step)) {
		if (UNIVERSAL_STEP_KEYS.has(key)) continue;
		if (key === "ms") {
			if (action !== "wait") {
				errors.push(`${where}: top-level "ms" is only valid on "wait" steps (this step's action is "${action}") — did you mean to put it under "args"?`);
			}
			continue;
		}
		if (ARG_SHAPED_KEYS.has(key)) {
			errors.push(
				`${where}: unexpected top-level key "${key}" — this is a real argument name for some action, ` +
				`and belongs under "args" (e.g. {"action": "${action}", "args": {"${key}": ...}}), NOT as a ` +
				`sibling of "action". A misplaced key like this silently falls back to a default instead of ` +
				`erroring — see the note at the top of f1_verify_close_button.json for the incident that motivated this check.`);
		} else {
			// Doesn't match any known argument name, so it's very likely a
			// free-text annotation convention (several scenarios use "_note",
			// "_comment", "_step", "_purpose") rather than a misplaced arg —
			// harmless (the runner ignores it), but flagged so an author
			// notices if it WAS meant to do something.
			warnings.push(`${where}: unrecognized top-level key "${key}" (ignored at runtime — not a misplaced arg for any known action, but not a supported key either)`);
		}
	}

	// "wait"'s args object, if present at all, must be empty — its ms belongs
	// top-level. This is deliberately its own check (not just "unknown arg
	// key warning") because it's a hard error, not a typo-tier warning: a
	// step author who wrote {"action":"wait","args":{"ms":80000}} believes
	// they specified an 80-second wait and silently got 1000ms instead.
	if (action === "wait") {
		if (hasOwn(step, "args") && Object.keys(step.args).length > 0) {
			errors.push(
				`${where}: "wait" takes no "args" — its only parameter is the top-level "ms" key ` +
				`(got args: ${JSON.stringify(step.args)}). Writing {"action":"wait","args":{"ms":...}} ` +
				`silently sleeps the default 1000ms instead of erroring — this is the exact bug that ` +
				`produced a false BLOCKER finding in blind critique v0.9 F1.`);
		}
		// An ms that is present but not a real duration is the same failure
		// through a different door: "ms": "8000" (string), null, or a negative
		// all validated clean and then slept something the author never asked
		// for. Absent ms is fine (the documented 1000ms default); a WRITTEN ms
		// must be a finite non-negative number.
		if (hasOwn(step, "ms") && (typeof step.ms !== "number" || !Number.isFinite(step.ms) || step.ms < 0)) {
			errors.push(
				`${where}: "wait" got ms: ${JSON.stringify(step.ms)} — ms must be a finite non-negative ` +
				`number. A string, null, or negative value silently sleeps something other than what you wrote.`);
		}
		return;
	}

	// Precedence: a game's runner_actions/builtins, then its catalog, then the
	// generic-bridge builtins last — so a catalog that defines one of the
	// generic names keeps its own arg spec (see GENERIC_BRIDGE_ACTIONS).
	const spec = NON_BRIDGE_ARG_SPECS[action] ?? ACTION_ARG_SPECS[action] ?? GENERIC_BRIDGE_ACTIONS[action];
	if (!spec) {
		errors.push(`${where}: unknown action "${action}" — not in this game's action catalog. Check the catalog named by playtest.config.json.`);
		return;
	}

	const args = step.args ?? {};
	if (typeof args !== "object" || args === null || Array.isArray(args)) {
		errors.push(`${where}: "args" must be an object, got ${JSON.stringify(args)}`);
		return;
	}

	for (const req of spec.required) {
		if (!hasOwn(args, req)) {
			errors.push(`${where}: action "${action}" requires args.${req}, which is missing. No silent default is used for this — the step will not run.`);
		}
	}

	const known = new Set([...spec.required, ...spec.optional]);
	for (const key of Object.keys(args)) {
		if (!known.has(key)) {
			warnings.push(`${where}: action "${action}" got unrecognized args.${key} — likely a typo (known args: ${[...known].join(", ") || "(none)"}). It will be silently ignored.`);
		}
	}

	// assert_state's op/value coherence is checkable statically, so check it
	// here rather than letting it surface as a runtime throw after a full
	// browser boot (unknown op) or, worse, a confusing "actual >= undefined"
	// comparison failure (comparison op with no value). Found by the producer
	// stress test's malformed-input probe, 2026-08-05.
	if ((action === "assert_state" || action === "wait_for") && hasOwn(args, "op")) {
		// The executor's own set, imported — a validator accepting an op the
		// executor rejects (or vice versa) is the dual-source-of-truth bug class.
		if (!ASSERT_STATE_OPS.has(args.op)) {
			errors.push(`${where}: ${action} got unknown op ${JSON.stringify(args.op)} — must be one of ${[...ASSERT_STATE_OPS].join(", ")}`);
		} else if (args.op !== "exists" && !hasOwn(args, "value")) {
			errors.push(`${where}: ${action} op "${args.op}" requires args.value (only "exists" goes without one) — without it the comparison runs against undefined and fails confusingly at runtime.`);
		}
	}

	// A scroll with no delta at all validates the wheel event (0,0) into
	// existence: a provable no-op recorded as ok:true — the worst outcome a
	// step has available. All three spellings are individually optional (dx/dy
	// are the documented axes, delta_y the legacy alias); at least one must be
	// present.
	if (action === "mouse_scroll" && !hasOwn(args, "dx") && !hasOwn(args, "dy") && !hasOwn(args, "delta_y")) {
		errors.push(`${where}: mouse_scroll needs at least one of "dx", "dy" (or legacy "delta_y") — with none given, the wheel scrolls (0,0) and the step reports ok:true having moved nothing.`);
	}

	// harness-assertions: "expect"/"expect_reason" only make sense on a step
	// that actually produces a bridge {"success": ...} result — not on
	// dump_state/screenshot/wait/mouse_*/assert_* pseudo-actions, which either
	// have no "success" field or ARE the assertion already.
	if (hasOwn(step, "expect") || hasOwn(step, "expect_reason")) {
		if (NON_BRIDGE_ARG_SPECS[action]) {
			errors.push(`${where}: "expect"/"expect_reason" is only valid on a DebugBridge action step (this step's action "${action}" is a runner-level pseudo-action with no {"success": ...} result to check).`);
		}
		if (hasOwn(step, "expect") && step.expect !== "success" && step.expect !== "refused") {
			errors.push(`${where}: "expect" must be "success" or "refused", got ${JSON.stringify(step.expect)}`);
		}
		if (hasOwn(step, "expect_reason") && typeof step.expect_reason !== "string") {
			errors.push(`${where}: "expect_reason" must be a string, got ${JSON.stringify(step.expect_reason)}`);
		}
	}
}

// Top-level scenario keys the runner actually reads.
// `note` is here so a scenario can say why it exists. It was a STEP key and not
// a top-level one, so the natural place to write the rationale warned at you --
// which teaches authors to leave the rationale out.
const KNOWN_SCENARIO_KEYS = new Set(["name", "note", "steps", "stop_on_failure", "capture_boot", "boot_with_intro"]);

// Validates an entire loaded scenario object. Returns { errors, warnings } —
// both arrays of human-readable strings. `errors` non-empty means the
// scenario must not be run.
function validateScenario(scenario) {
	const errors = [];
	const warnings = [];

	if (!scenario.name || typeof scenario.name !== "string") {
		errors.push(`scenario: missing/invalid "name" string`);
	}
	if (!Array.isArray(scenario.steps)) {
		errors.push(`scenario: missing/invalid "steps" array`);
		return { errors, warnings };
	}
	for (const key of Object.keys(scenario)) {
		if (!KNOWN_SCENARIO_KEYS.has(key)) {
			warnings.push(`scenario: unrecognized top-level key "${key}" (known: ${[...KNOWN_SCENARIO_KEYS].join(", ")})`);
		}
	}

	// "A game's catalog wins a name collision" holds for the six GENERIC bridge
	// actions — NOT for the runner's own pseudo-actions (dump_state, wait_for,
	// mouse_click, screenshot, ...), which the executor dispatches by hardcoded
	// branch before ever consulting the catalog. A catalog entry wearing one of
	// those names can never be dispatched: it validates against the builtin's
	// spec and executes as the builtin, silently. Say so, loudly, up front.
	for (const name of Object.keys(ACTION_DEFS)) {
		if (NON_BRIDGE_ACTIONS.has(name)) {
			warnings.push(
				`catalog: action "${name}" collides with the runner's built-in pseudo-action of the same ` +
				`name — the built-in wins at execution (unlike generic bridge actions, where the catalog wins), ` +
				`so this catalog entry can never run. Rename it.`);
		}
	}

	scenario.steps.forEach((step, index) => validateStep(step, index, errors, warnings));

	// harness-assertions (tooling_audit_v1.md finding 1/D5): a scenario with no
	// assert_state, no assert_ui_swept, and no expect/expect_reason anywhere is
	// exactly the "narrative corpus, not a regression gate" shape the audit's
	// Demo 1 proved — it can run 5/5 "succeeded" while its central claim
	// silently failed. This is a WARNING, not an error: plenty of scenarios are
	// legitimately exploratory/evidence-capture runs, not verification gates
	// (the audit's own zz_tooling_audit_demo* scenarios are the documented
	// counter-example — see README.md). A scenario that's actually claimed as
	// a regression gate should not ship with this warning.
	if (Array.isArray(scenario.steps)) {
		const hasAssertion = scenario.steps.some((step) =>
			step && typeof step === "object" &&
			(step.action === "assert_state" || step.action === "wait_for" ||
			 step.action === "assert_ui_swept" ||
				hasOwn(step, "expect") || hasOwn(step, "expect_reason")));
		if (!hasAssertion) {
			warnings.push(
				`scenario: zero assertions/expectations anywhere in this scenario (no "assert_state", ` +
				`"assert_ui_swept", "expect", or "expect_reason" step) — every step result is unjudged. ` +
				`This is fine for an exploratory/evidence-capture run, but if this scenario is claimed as ` +
				`a verification/regression gate, that claim is unfounded (tooling_audit_v1.md finding 1).`);
		}
	}

	return { errors, warnings };
}

// Five step types that aren't DebugBridge actions at all: reading state,
// capturing a screenshot, a plain real-time wait (useful alongside
// set_time_scale, or waiting out a Task Board contract timer for real),
// moving the real mouse pointer over the canvas, and clicking it.
//
// `mouse_move` exists because hover is the one interaction DebugBridge
// structurally cannot drive: the hover tooltip is triggered by a genuine
// InputEventMouseMotion reaching GridManager._unhandled_input(), not by any
// action a bridge callback could invoke. Anything testing hover feel (the
// pre-show delay, suppression during placement mode, flicker between cells)
// therefore has to move Playwright's own pointer. Coordinates are in *page*
// pixels, not grid cells — see README.md's "Hovering the grid" section for
// the cell -> page-pixel conversion, which depends on the canvas scale.
//
// `mouse_click` exists for the same structural reason, one step further on:
// a handful of controls have no DebugBridge action behind them at all (the
// HUD's Ascension/Perks button, Settings, Help), so the only way to get
// those panels on screen — for a UI-styling evidence pass, say — is to
// click where they actually are. Same page-pixel coordinate space as
// `mouse_move`; the conversion note in README.md applies unchanged.
// `mouse_move_cell` / `mouse_click_cell` take a GRID CELL instead of a page
// pixel. They ask the running game where that cell actually is
// (`get_cell_screen_pos`) and drive the real pointer there.
//
// Added with the design-round-6C oblique slab camera. Cells are sheared
// parallelograms now and GridManager is scaled/re-centred by the W8-11 auto-fit,
// so the old "compute the pixel yourself" formula in README.md is no longer
// something a scenario author can get right by hand — and would rot again on the
// next camera change. Prefer these over raw `mouse_move`/`mouse_click` for
// anything aimed at the board; the pixel forms remain for UI chrome outside it.
// `assert_no_occlusion`, `scroll_stability` and `ui_sweep` are the W8-12 UI
// truth steps. They exist at the RUNNER level rather than as bare bridge calls
// because each adds something the bridge deliberately does not:
//
//   assert_no_occlusion — turns audit_ui's finding list into a step VERDICT,
//     so a covered button fails a run instead of sitting unread in a manifest
//     nobody opens.
//   scroll_stability   — samples get_scroll_state repeatedly with NO input in
//     between. One sample proves nothing; oscillation only exists across
//     samples. This is the shop-jitter check.
//   ui_sweep           — visits every enabled dock tab (and, optionally, the
//     Chart), screenshotting and auditing each. This is the state-matrix
//     primitive: put one between every pair of state-mutating steps and a
//     panel that only breaks AFTER an unlock has nowhere to hide. Auditing
//     once at boot would never have caught the Chart-lockout-after-drive-
//     repair bug, because at boot the Chart was fine.
const NON_BRIDGE_ACTIONS = new Set([...Object.keys(RUNNER_ACTION_SPECS), "wait"]);

// The runner's mouse and canvas-measurement actions need a real Playwright
// page. On the desktop transport there is none — no canvas, no pointer — so
// any step that needs one fails LOUDLY here rather than silently doing
// something else. (A desktop game's clickable surface is driven through bridge
// actions instead; that is the entire point of the bridge.)
function requirePage(t, what) {
	if (!t.page) {
		throw new Error(
			`${what} requires the browser transport — the desktop transport has no page/canvas ` +
			`to drive real mouse input against (config.transport is "${TRANSPORT_KIND}"). ` +
			`Use a bridge action instead, or run this scenario against the web export.`);
	}
	return t.page;
}

// Resolves a grid cell to page pixels via the bridge, then the live canvas rect.
// Deliberately does NOT fall back to a computed guess if the bridge says the
// cell is off-screen or unknown: a silent wrong-pixel click produces a scenario
// that "passes" while testing nothing, which is the failure mode this whole
// helper exists to remove.
async function cellToPagePoint(t, cellX, cellY) {
	const page = requirePage(t, "cell-to-pixel resolution");
	const result = await callBridgeAction(t, BRIDGE.cell_pos_fn, [cellX, cellY]);
	if (!result || result.success !== true) {
		throw new Error(
			`get_cell_screen_pos failed for cell (${cellX}, ${cellY}): ${JSON.stringify(result)}`);
	}
	if (result.on_screen === false) {
		throw new Error(
			`cell (${cellX}, ${cellY}) is off-screen (normalized ` +
			`${result.normalized_x.toFixed(3)}, ${result.normalized_y.toFixed(3)}) — ` +
			`clicking it would hit something else`);
	}
	const box = await page.locator("canvas").boundingBox();
	if (!box) throw new Error("could not measure the game canvas");
	return {
		x: box.x + box.width * result.normalized_x,
		y: box.y + box.height * result.normalized_y,
		bridge: result,
	};
}

// Resolves a named on-screen Control to page pixels via the bridge, then the
// live canvas rect — the UI-chrome twin of cellToPagePoint above. Same
// "no silent wrong-pixel guess" rule: a control that isn't found, isn't
// visible, or falls off-screen throws rather than clicking blind.
async function controlToPagePoint(t, nodeName) {
	const page = requirePage(t, "control-to-pixel resolution");
	const result = await callBridgeAction(t, BRIDGE.control_rect_fn, [nodeName]);
	if (!result || result.success !== true) {
		throw new Error(
			`get_control_rect failed for "${nodeName}": ${JSON.stringify(result)}`);
	}
	if (result.on_screen === false) {
		throw new Error(
			`control "${nodeName}" is off-screen (normalized ` +
			`${result.normalized_x.toFixed(3)}, ${result.normalized_y.toFixed(3)}) — ` +
			`clicking it would hit something else`);
	}
	const box = await page.locator("canvas").boundingBox();
	if (!box) throw new Error("could not measure the game canvas");
	return {
		x: box.x + box.width * result.normalized_x,
		y: box.y + box.height * result.normalized_y,
		bridge: result,
	};
}

// Resolves a right-click context-menu item (by label text or numeric id) to
// page pixels via get_context_menu_state, then the live canvas rect — the
// context-menu twin of cellToPagePoint/controlToPagePoint above, same "no
// silent wrong-pixel guess" rule: a closed menu, an unmatched label/id, or a
// disabled item throws rather than clicking blind. Godot's PopupMenu is a
// Window and has no public per-item rect API, so get_context_menu_state
// (GridManager.get_context_menu_state_for_bridge, DebugBridge.gd) DERIVES one
// from the popup's own screen position/size plus an even vertical split
// across its items — see that function's doc comment for the full derivation
// and its documented assumptions (uniform-height plain-text items only).
async function menuItemToPagePoint(t, { label, id } = {}) {
	if (label === undefined && id === undefined) {
		throw new Error("mouse_click_menu_item requires args.label or args.id");
	}
	const page = requirePage(t, "menu-item-to-pixel resolution");
	const menuState = await callBridgeAction(t, BRIDGE.context_menu_fn, []);
	if (!menuState || menuState.success !== true) {
		throw new Error(`get_context_menu_state failed: ${JSON.stringify(menuState)}`);
	}
	if (menuState.is_open !== true) {
		throw new Error(
			"mouse_click_menu_item: the context menu is not open — right-click a module " +
			"first (mouse_right_click_cell) before pressing a menu item");
	}
	const items = menuState.items ?? [];
	const item = items.find((it) =>
		(label !== undefined && it.text === label) || (id !== undefined && it.id === id));
	if (!item) {
		throw new Error(
			`mouse_click_menu_item: no item matching ${label !== undefined ? `label "${label}"` : `id ${id}`} — ` +
			`open items were: ${JSON.stringify(items.map((it) => ({ id: it.id, text: it.text })))}`);
	}
	if (item.disabled) {
		throw new Error(`mouse_click_menu_item: item "${item.text}" is disabled and cannot be pressed`);
	}
	if (item.on_screen === false) {
		throw new Error(
			`mouse_click_menu_item: item "${item.text}" is off-screen (normalized ` +
			`${item.normalized_x.toFixed(3)}, ${item.normalized_y.toFixed(3)})`);
	}
	const box = await page.locator("canvas").boundingBox();
	if (!box) throw new Error("could not measure the game canvas");
	return {
		x: box.x + box.width * item.normalized_x,
		y: box.y + box.height * item.normalized_y,
		item,
		menuState,
	};
}

// ============================================================================
// W8-12 · UI truth helpers
// ============================================================================

// Runs the occlusion audit and reduces it to a verdict. `whitelist` is the
// list of INTENTIONAL occluders (a modal's dimmer, a deliberate overlay) —
// matched against the occluder's node path/name/class, never against the
// control being covered, so whitelisting one expected dimmer cannot also hide
// the next unrelated overlay that lands on the same button.
async function runOcclusionAudit(t, whitelist) {
	const audit = await callBridgeAction(t, BRIDGE.audit_ui_fn, [JSON.stringify(whitelist ?? [])]);
	if (!audit || audit.success !== true) {
		throw new Error(`audit_ui failed: ${JSON.stringify(audit)}`);
	}
	return audit;
}

// Samples every visible ScrollContainer repeatedly WITHOUT touching anything.
// A value that moves between samples while no input is happening is the
// finding — that is the shop-scroll-oscillation class, which is invisible to
// both a state snapshot (the numbers are all individually valid) and a single
// screenshot (it looks fine in any one frame).
//
// Deliberately reports content_height changes too, not just scroll offsets: a
// panel whose content rebuilds on a timer is the usual CAUSE of the jitter,
// and knowing the height moved as well as the offset is what distinguishes
// "the list is being rebuilt under the scrollbar" from "something is scripting
// the scroll position".
async function runScrollStability(t, { seconds = 3, samples = 6 } = {}) {
	const count = Math.max(2, samples);
	const gapMs = Math.max(100, Math.round((seconds * 1000) / (count - 1)));
	const seen = new Map(); // path -> { name, offsets:Set, heights:Set, samples:[] }

	for (let i = 0; i < count; i++) {
		if (i > 0) await sleep(gapMs);
		const state = await callBridgeAction(t, BRIDGE.scroll_state_fn, []);
		if (!state || state.success !== true) {
			throw new Error(`get_scroll_state failed: ${JSON.stringify(state)}`);
		}
		for (const c of state.containers ?? []) {
			if (!seen.has(c.path)) {
				seen.set(c.path, { name: c.name, offsets: new Set(), heights: new Set(), samples: [] });
			}
			const rec = seen.get(c.path);
			rec.offsets.add(`${c.scroll_vertical},${c.scroll_horizontal}`);
			rec.heights.add(`${c.content_width}x${c.content_height}`);
			rec.samples.push({ v: c.scroll_vertical, h: c.scroll_horizontal, ch: c.content_height });
		}
	}

	const findings = [];
	for (const [path, rec] of seen) {
		if (rec.offsets.size <= 1 && rec.heights.size <= 1) continue;
		findings.push({
			container: path,
			name: rec.name,
			distinct_offsets: rec.offsets.size,
			distinct_content_sizes: rec.heights.size,
			samples: rec.samples,
		});
	}
	return {
		seconds, samples: count, sample_gap_ms: gapMs,
		containers_sampled: seen.size,
		finding_count: findings.length,
		findings,
	};
}

// The state-matrix primitive. Visits every ENABLED dock tab (plus the Chart if
// it is unlocked and `include_chart` is on), and at each stop: screenshots,
// runs the occlusion audit, and samples scroll stability.
//
// The point is to be run MORE THAN ONCE — once per state mutation. A panel
// that is fine at boot and broken after a drive repair is a real bug class
// (owner finding #5) that a single boot-time audit structurally cannot see.
//
// A tab that refuses to open is recorded as `unreachable`, not skipped
// silently: "select_right_dock_tab returned success: false and the screenshot
// therefore shows the PREVIOUS panel" has already cost two runs their tab
// beats (see README's critique-tour note), and a sweep that quietly moved on
// would repeat that with the audit attached to the wrong panel.
async function runUiSweep(t, screenshotsDir, runDir, label, opts = {}) {
	const {
		whitelist = [], seconds = 3, samples = 6,
		screenshots = true, include_chart: includeChart = true,
	} = opts;

	const state = await dumpState(t);
	const ui = state?.ui ?? {};
	const stops = [];

	// Which screens exist, and how to reach one, is per-game. playtest.config.json
	// describes both declaratively so the sweep's lint/screenshot logic below
	// stays generic. A game with a single screen configures no sweep at all.
	const sweep = CONFIG.ui_sweep ?? {};
	const listed = ui?.[sweep.stops_from_ui ?? "dock_tabs"] ?? [];
	for (const item of listed) {
		if (sweep.stop_filter_field && !item[sweep.stop_filter_field]) continue;
		stops.push({ kind: "listed", id: item[sweep.stop_id_field ?? "tab_name"] });
	}
	for (const ex of sweep.extra_stops ?? []) {
		const gate = ex.when_state ? ex.when_state.split(".").reduce((o, k) => o?.[k], state) : true;
		if (includeChart && gate) stops.push({ kind: "extra", id: ex.id, navigate: ex.navigate });
	}

	const visited = [];
	const shots = [];
	let occlusionFindings = 0;
	let scrollFindings = 0;

	for (const stop of stops) {
		const stopLabel = safeFileLabel(`${label}_${stop.id}`, `${label}_stop`);
		let reachable = true;
		let selectResult = null;

		// $STOP_ID is substituted with the stop being visited, so one navigate
		// recipe covers every listed stop.
		const recipe = stop.navigate ?? sweep.navigate ?? [];
		for (const call of recipe) {
			const callArgs = (call.args ?? []).map((a) => (a === "$STOP_ID" ? stop.id : a));
			selectResult = await callBridgeAction(t, call.fn, callArgs);
		}
		reachable = recipe.length === 0 ? true : selectResult?.success === true;
		await sleep(400); // let the panel actually lay out before measuring it

		const entry = { stop: stop.id, kind: stop.kind, reachable, select_result: selectResult };

		if (!reachable) {
			// The audit would be attached to whatever panel is still on screen,
			// which is worse than no audit at all.
			entry.unreachable_note =
				"tab/view refused to open — audit and screenshot SKIPPED so they are not " +
				"silently attributed to the previously-open panel";
			visited.push(entry);
			continue;
		}

		if (screenshots) {
			const filePath = path.join(screenshotsDir, `${stopLabel}.png`);
			const shot = await t.screenshot(filePath);
			if (shot === null) {
				// Desktop headless has no capture. Recording the skip (rather
				// than failing, or silently omitting the field) keeps "never
				// captured" distinguishable from "captured and pruned" — the
				// same tombstone discipline prune_run.mjs enforces.
				entry.screenshot_skipped = "desktop transport";
			} else {
				entry.screenshot = relForManifest(runDir, filePath);
				shots.push(entry.screenshot);
			}
		}

		const audit = await runOcclusionAudit(t, whitelist);
		entry.occlusion = {
			controls_checked: audit.controls_checked,
			finding_count: audit.finding_count,
			findings: audit.findings,
		};
		occlusionFindings += audit.finding_count;

		const scroll = await runScrollStability(t, { seconds, samples });
		entry.scroll = scroll;
		scrollFindings += scroll.finding_count;

		visited.push(entry);
	}

	return {
		label,
		stops_planned: stops.length,
		stops_visited: visited.filter((v) => v.reachable).length,
		unreachable: visited.filter((v) => !v.reachable).map((v) => v.stop),
		occlusion_finding_count: occlusionFindings,
		scroll_finding_count: scrollFindings,
		screenshots: shots,
		visited,
	};
}

// ============================================================================
// visual-lint (harness-visual-lint, 2026-08-05 owner screenshot critique) —
// deterministic checks over get_ui_tree's own output for the class of visual
// bug the occlusion audit structurally cannot see: nothing is COVERED, the
// layout is just wrong on its own terms (padding, overlap, clipped text) or
// two on-screen facts contradict each other. All computed over the EXISTING
// get_ui_tree bridge action and dump_state() — no new DebugBridge actions,
// same tier as assert_no_occlusion/ui_sweep above.
// ============================================================================

function rectFromArray(r) {
	return { x: r[0], y: r[1], w: r[2], h: r[3] };
}

function rectsIntersectArea(a, b) {
	const x1 = Math.max(a.x, b.x);
	const y1 = Math.max(a.y, b.y);
	const x2 = Math.min(a.x + a.w, b.x + b.w);
	const y2 = Math.min(a.y + a.h, b.y + b.h);
	if (x2 <= x1 || y2 <= y1) return 0;
	return (x2 - x1) * (y2 - y1);
}

function isAncestorPath(ancestorPath, path) {
	return path !== ancestorPath && path.startsWith(ancestorPath + "/");
}

function matchesWhitelist(path, name, cls, whitelist) {
	if (!whitelist || whitelist.length === 0) return false;
	return whitelist.some((w) => path.includes(w) || name.includes(w) || cls.includes(w));
}

// B1 text-inset: a Label/RichTextLabel/Button with non-empty text whose rect
// sits closer than min_inset px to its PARENT panel's edge. "Parent panel" is
// approximated as the nearest ancestor control in the tree whose rect fully
// contains this control's rect and is strictly larger — get_ui_tree has no
// explicit parent pointer, only `path`, so the immediate parent is found by
// taking the longest prefix-match path among all entries.
function findParentByPath(entries, entry) {
	const parts = entry.path.split("/");
	for (let cut = parts.length - 1; cut > 0; cut--) {
		const candidatePath = parts.slice(0, cut).join("/");
		const found = entries.find((e) => e.path === candidatePath);
		if (found) return found;
	}
	return null;
}

// Only these classes read as a visually FRAMED panel a viewer perceives as
// having an edge — plain layout containers (HBoxContainer, VBoxContainer,
// MarginContainer, Control, TabContainer's page root, ...) have no visible
// border/background at all, so "6px from this container's edge" is a
// meaningless measurement against them. Tuning decision (2026-08-05 baseline
// run): the FIRST empty-whitelist pass against `develop` fired text-inset on
// ~127-136 controls at every matrix row, almost all of them Labels sitting
// flush inside an HBoxContainer/MarginContainer that itself has no drawn
// edge — not a real padding bug, just this rule measuring against invisible
// geometry. Restricting the "parent panel" to classes that actually draw a
// frame (a StyleBox background/border, or a NinePatchRect/ColorRect used as
// one) cut the false-positive volume without touching the real class of bug
// (a Label crammed against an ACTUAL panel's edge) — see README.md's
// "Visual lint" section for the same rationale in the human-facing docs.
const FRAMED_PANEL_CLASSES = new Set(["PanelContainer", "Panel", "NinePatchRect", "ColorRect"]);

function lintTextInset(entries, minInset, whitelist) {
	const findings = [];
	const TEXTY = new Set(["Label", "RichTextLabel", "Button"]);
	for (const entry of entries) {
		if (!TEXTY.has(entry.class)) continue;
		if (!entry.text || String(entry.text).trim().length === 0) continue;
		if (matchesWhitelist(entry.path, entry.name, entry.class, whitelist)) continue;
		// Walk up from the immediate parent to the nearest FRAMED ancestor —
		// the nearest ancestor a viewer would actually read as "the panel this
		// text sits inside", not just the nearest node in the tree.
		let parent = findParentByPath(entries, entry);
		while (parent && !FRAMED_PANEL_CLASSES.has(parent.class)) {
			parent = findParentByPath(entries, parent);
		}
		if (!parent) continue;
		const r = rectFromArray(entry.rect);
		const p = rectFromArray(parent.rect);
		// Only meaningful if this control is actually inside the parent's rect —
		// a control that pokes outside its parent entirely is sibling-overlap's
		// or a layout bug's job, not this rule's.
		if (r.x < p.x - 1 || r.y < p.y - 1 || r.x + r.w > p.x + p.w + 1 || r.y + r.h > p.y + p.h + 1) continue;
		const insets = {
			left: r.x - p.x, top: r.y - p.y,
			right: (p.x + p.w) - (r.x + r.w), bottom: (p.y + p.h) - (r.y + r.h),
		};
		const worst = Math.min(insets.left, insets.top, insets.right, insets.bottom);
		if (worst < minInset) {
			findings.push({
				rule: "text-inset", path: entry.path, name: entry.name, class: entry.class,
				text: String(entry.text).slice(0, 60), parent: parent.path,
				worst_inset_px: Math.round(worst * 10) / 10, min_inset: minInset, insets,
			});
		}
	}
	return findings;
}

// B1 sibling-overlap: two visible SIBLING controls (same immediate parent per
// findParentByPath) whose rects intersect by more than overlap_tolerance px^2
// of area, where neither is an ancestor/descendant of the other (a Panel
// legitimately contains its children — that's not overlap, it's nesting).
function lintSiblingOverlap(entries, tolerancePx, whitelist) {
	const findings = [];
	const byParent = new Map();
	for (const entry of entries) {
		const parent = findParentByPath(entries, entry);
		// Controls with no resolvable parent in get_ui_tree's own list are
		// top-level scene roots parented directly under separate CanvasLayers
		// (Main/BackgroundLayer/Background vs. Main/CanvasLayer/ConsoleShell,
		// vs. the various full-screen overlay roots — HelpUI, SettingsUI,
		// AscensionUI, ...). Tuning decision (2026-08-05 baseline run): the
		// FIRST empty-whitelist pass bucketed every one of these into a fake
		// "(root)" parent and reported the background overlapping literally
		// every full-screen overlay Control in the tree — ~46 identical
		// findings on every single matrix row, because Godot's CanvasLayer
		// stacking IS full-screen-overlapping-by-design (that's how layering
		// works) and none of them are actually visible at once. This is a
		// false positive in the RULE, not a real bug: "same immediate parent"
		// is required to mean anything for sibling-overlap, so entries with no
		// resolvable parent are excluded entirely rather than bucketed
		// together.
		if (!parent) continue;
		const key = parent.path;
		if (!byParent.has(key)) byParent.set(key, []);
		byParent.get(key).push(entry);
	}
	for (const [parentPath, siblings] of byParent) {
		for (let i = 0; i < siblings.length; i++) {
			for (let j = i + 1; j < siblings.length; j++) {
				const a = siblings[i], b = siblings[j];
				if (isAncestorPath(a.path, b.path) || isAncestorPath(b.path, a.path)) continue;
				if (matchesWhitelist(a.path, a.name, a.class, whitelist)) continue;
				if (matchesWhitelist(b.path, b.name, b.class, whitelist)) continue;
				const area = rectsIntersectArea(rectFromArray(a.rect), rectFromArray(b.rect));
				// overlap_tolerance is a LINEAR px budget (matching the other
				// rules' units); squared to compare against the intersection AREA
				// so two controls nudged by <= tolerance px in one axis alone
				// (a common, harmless 1px rounding overlap) doesn't fire.
				if (area > tolerancePx * tolerancePx) {
					findings.push({
						rule: "sibling-overlap", parent: parentPath,
						a: { path: a.path, name: a.name, class: a.class },
						b: { path: b.path, name: b.name, class: b.class },
						overlap_area_px2: Math.round(area), tolerance_px: tolerancePx,
					});
				}
			}
		}
	}
	return findings;
}

// B1 near-misalign (WARNING, non-fatal by default). Siblings under the SAME
// parent whose corresponding edge (left/right on the same row, top/bottom in
// the same column) differs by 1-3px — the "almost lined up" look that reads
// as sloppy without being a hard bug. Tuned hard for noise per the task brief
// — see README.md's "Visual lint" section for the rationale behind each of
// these four guards:
//   1. same parent only (cross-parent alignment is coincidental, not a layout
//      intent — comparing everything-to-everything produced hundreds of
//      meaningless near-misses in manual testing).
//   2. same axis only (compare left-to-left / top-to-top, never left-to-top).
//   3. minimum control size (24px) — tiny controls (icons, spacers) trip a
//      1-3px "misalignment" constantly and it is never visually perceptible.
//   4. only when the two controls are roughly on the same row/column already
//      (their OTHER axis overlaps) — otherwise every unrelated pair of small
//      gaps anywhere in the tree "aligns" by coincidence.
function lintNearMisalign(entries, whitelist) {
	const MIN_SIZE = 24;
	const findings = [];
	const byParent = new Map();
	for (const entry of entries) {
		const r = rectFromArray(entry.rect);
		if (r.w < MIN_SIZE || r.h < MIN_SIZE) continue;
		if (matchesWhitelist(entry.path, entry.name, entry.class, whitelist)) continue;
		const parent = findParentByPath(entries, entry);
		// Same rationale as lintSiblingOverlap's parent-resolution fix above —
		// a top-level scene root under a separate CanvasLayer has no
		// meaningful "alignment" relationship with another one.
		if (!parent) continue;
		const key = parent.path;
		if (!byParent.has(key)) byParent.set(key, []);
		byParent.get(key).push({ entry, r });
	}
	for (const [parentPath, siblings] of byParent) {
		for (let i = 0; i < siblings.length; i++) {
			for (let j = i + 1; j < siblings.length; j++) {
				const A = siblings[i], B = siblings[j];
				if (isAncestorPath(A.entry.path, B.entry.path) || isAncestorPath(B.entry.path, A.entry.path)) continue;
				// Same row candidate: vertical ranges overlap -> compare left/right.
				const vOverlap = Math.min(A.r.y + A.r.h, B.r.y + B.r.h) - Math.max(A.r.y, B.r.y);
				if (vOverlap > 0) {
					const dLeft = Math.abs(A.r.x - B.r.x);
					const dRight = Math.abs((A.r.x + A.r.w) - (B.r.x + B.r.w));
					for (const [edge, d] of [["left", dLeft], ["right", dRight]]) {
						if (d >= 1 && d <= 3) {
							findings.push({
								rule: "near-misalign", severity: "warning", parent: parentPath, axis: "horizontal", edge,
								a: A.entry.path, b: B.entry.path, delta_px: d,
							});
						}
					}
				}
				// Same column candidate: horizontal ranges overlap -> compare top/bottom.
				const hOverlap = Math.min(A.r.x + A.r.w, B.r.x + B.r.w) - Math.max(A.r.x, B.r.x);
				if (hOverlap > 0) {
					const dTop = Math.abs(A.r.y - B.r.y);
					const dBottom = Math.abs((A.r.y + A.r.h) - (B.r.y + B.r.h));
					for (const [edge, d] of [["top", dTop], ["bottom", dBottom]]) {
						if (d >= 1 && d <= 3) {
							findings.push({
								rule: "near-misalign", severity: "warning", parent: parentPath, axis: "vertical", edge,
								a: A.entry.path, b: B.entry.path, delta_px: d,
							});
						}
					}
				}
			}
		}
	}
	return findings;
}

// B1 clipped-text: a text control whose clipped_rect is SMALLER than its rect
// (Godot's own effective-visible-rect after ancestor clip_contents), outside
// any ScrollContainer ancestor — a ScrollContainer intentionally clips its
// content to its viewport, so a Label that's merely scrolled off is not a
// bug, whereas the same shrink happening for any other reason usually means
// truncated/cut-off text.
function lintClippedText(entries, whitelist) {
	const findings = [];
	const TEXTY = new Set(["Label", "RichTextLabel", "Button"]);
	// W13-T7: TextureRects (icons) too — the G7 cost-icon row shipped rendering
	// half-cut at a card boundary and evaded this rule entirely because it only
	// inspected text classes; only the producer's eye caught it. An icon cut
	// mid-glyph is the same defect as truncated text. Same ScrollContainer
	// exemption applies; a TextureRect has no text so the empty-text skip is
	// bypassed for it.
	const ICONY = new Set(["TextureRect"]);
	for (const entry of entries) {
		if (!TEXTY.has(entry.class) && !ICONY.has(entry.class)) continue;
		if (TEXTY.has(entry.class) && (!entry.text || String(entry.text).trim().length === 0)) continue;
		if (matchesWhitelist(entry.path, entry.name, entry.class, whitelist)) continue;
		if (entry.path.includes("ScrollContainer")) continue;
		// Walk ancestors by path prefix looking for a ScrollContainer class —
		// path alone doesn't carry class for ancestors, so cross-reference entries.
		const parts = entry.path.split("/");
		let underScroll = false;
		for (let cut = 1; cut < parts.length; cut++) {
			const ancestorPath = parts.slice(0, cut).join("/");
			const ancestor = entries.find((e) => e.path === ancestorPath);
			if (ancestor && ancestor.class === "ScrollContainer") { underScroll = true; break; }
		}
		if (underScroll) continue;
		const r = rectFromArray(entry.rect);
		const c = rectFromArray(entry.clipped_rect);
		if (c.w < r.w - 0.5 || c.h < r.h - 0.5) {
			findings.push({
				rule: ICONY.has(entry.class) ? "clipped-texture" : "clipped-text",
				path: entry.path, name: entry.name, class: entry.class,
				text: String(entry.text ?? "").slice(0, 60), rect: entry.rect, clipped_rect: entry.clipped_rect,
			});
		}
	}
	return findings;
}

async function runUiLint(t, opts = {}) {
	const {
		whitelist = [],
		text_inset: textInset = true, sibling_overlap: siblingOverlap = true,
		near_misalign: nearMisalign = true, clipped_text: clippedText = true,
		min_inset: minInset = 6, overlap_tolerance: overlapTolerance = 2,
	} = opts;

	const tree = await callBridgeAction(t, BRIDGE.ui_tree_fn, [false]);
	if (!tree || tree.success !== true) {
		throw new Error(`get_ui_tree failed: ${JSON.stringify(tree)}`);
	}
	const entries = tree.controls ?? tree.entries ?? [];

	let findings = [];
	if (textInset) findings = findings.concat(lintTextInset(entries, minInset, whitelist));
	if (siblingOverlap) findings = findings.concat(lintSiblingOverlap(entries, overlapTolerance, whitelist));
	if (nearMisalign) findings = findings.concat(lintNearMisalign(entries, whitelist));
	if (clippedText) findings = findings.concat(lintClippedText(entries, whitelist));

	// near-misalign is a warning-severity rule — split it out of the fatal count.
	const fatalFindings = findings.filter((f) => f.severity !== "warning");
	return {
		controls_checked: entries.length,
		finding_count: findings.length,
		fatal_finding_count: fatalFindings.length,
		findings,
	};
}

// ============================================================================
// B2 · assert_consistent — contradiction rules evaluated against ONE fresh
// dump_state() snapshot per step. See README.md's "Visual lint" section for
// exactly what each rule checks and, where dump_state doesn't expose the
// ideal field, what proxy is used and why.
// ============================================================================

// Cross-field invariants ("chart_unlocked must be true iff comms_relay is
// repaired") are statements about ONE game's rules, so they live in that game's
// repo, not here. playtest.config.json names a module exporting
// `consistencyRules`; a game that defines none simply has no rules to check and
// assert_consistent becomes a no-op it can still call safely.
// LOADED LAZILY, and that is a security property rather than a performance one.
// This import used to run at module scope, which meant `--validate` — sold as a
// cheap STATIC pre-flight that needs no browser, no game and no npm install —
// silently executed arbitrary JavaScript from the game repo. Validating an
// untrusted scenario against an untrusted config was advertised as safe and was
// not. Nothing but assert_consistent needs these rules, and assert_consistent
// only runs against a live game, so the import now happens the first time that
// action is reached and never on the validate path.
let CONSISTENCY_RULES = null;

async function consistencyRules() {
	if (CONSISTENCY_RULES !== null) return CONSISTENCY_RULES;
	CONSISTENCY_RULES = {};
	if (CONFIG.game_module) {
		const mod = await import(pathToFileURL(path.resolve(GAME_ROOT, CONFIG.game_module)).href);
		CONSISTENCY_RULES = mod.consistencyRules ?? {};
	}
	return CONSISTENCY_RULES;
}

async function runAssertConsistent(t, opts = {}) {
	const rules = await consistencyRules();
	const { rules: ruleIds = Object.keys(rules) } = opts;
	const state = await dumpState(t);
	const findings = [];
	for (const id of ruleIds) {
		const rule = rules[id];
		if (!rule) throw new Error(`assert_consistent: unknown rule id "${id}" — known rules: ${Object.keys(rules).join(", ")}`);
		const problem = rule.check(state);
		if (problem) {
			findings.push({ rule: id, description: rule.description, detail: problem });
		}
	}
	return { rules_checked: ruleIds, finding_count: findings.length, findings };
}

// ============================================================================
// B3 · assert_board_visible — every occupied grid cell resolves on-screen
// AND outside the HUD (StatusStrip). Mirrors cellToPagePoint's "fail loudly,
// never guess" rule: get_cell_screen_pos refusing a cell throws, it is never
// silently skipped, per the task brief.
// ============================================================================

function rectContainsPoint(rect, x, y) {
	return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

async function runAssertBoardVisible(t) {
	const page = requirePage(t, "assert_board_visible");
	const state = await dumpState(t);
	const grid = state?.grid;
	if (!grid) throw new Error("assert_board_visible: dump_state has no grid section");

	const tree = await callBridgeAction(t, BRIDGE.ui_tree_fn, [false]);
	if (!tree || tree.success !== true) throw new Error(`get_ui_tree failed: ${JSON.stringify(tree)}`);
	const entries = tree.controls ?? tree.entries ?? [];
	const statusStrip = entries.find((e) => e.name === "StatusStrip");
	const hudRect = statusStrip ? rectFromArray(statusStrip.rect) : null;

	const viewport = { x: 0, y: 0, w: 1280, h: 720 }; // matches the runner's fixed page viewport

	const cells = [];
	for (const module of grid.modules ?? []) {
		for (const cell of module.occupied_cells ?? []) {
			cells.push({ module_id: module.module_id, x: cell.x, y: cell.y });
		}
	}

	const findings = [];
	const checked = [];
	for (const cell of cells) {
		// get_cell_screen_pos throws (via cellToPagePoint's own hard-fail) on a
		// refused/off-screen cell — "fail loudly rather than silently skip" per
		// the task brief, so a genuinely broken board crashes this step instead
		// of quietly reporting zero findings over an empty result set.
		const resolved = await cellToPagePoint(t, cell.x, cell.y);
		// The approximate "sprite top" point: one cell-height above the resolved
		// centre, in SCREEN space. Documented as inexact: the deck is drawn in
		// oblique/sheared projection (README.md's "Hovering the grid" section),
		// so a fixed vertical page-pixel offset is not the true top of a sheared
		// tile's sprite — it is a cheap, directionally-correct approximation
		// good enough to catch "the whole board is off past the top of the
		// viewport", not a geometrically exact sprite-bounds check.
		const box = await page.locator("canvas").boundingBox();
		const cellHeightPx = box ? box.height / Math.max(1, grid.height) : 64;
		const spriteTop = { x: resolved.x, y: resolved.y - cellHeightPx };

		checked.push({ cell, resolved: { x: resolved.x, y: resolved.y }, sprite_top: spriteTop });

		for (const [label, pt] of [["centre", resolved], ["sprite_top", spriteTop]]) {
			if (!rectContainsPoint(viewport, pt.x, pt.y)) {
				findings.push({
					rule: "off-viewport", module_id: cell.module_id, cell: { x: cell.x, y: cell.y },
					point: label, at: pt, viewport,
				});
				continue;
			}
			if (hudRect && rectContainsPoint(hudRect, pt.x, pt.y)) {
				findings.push({
					rule: "under-hud", module_id: cell.module_id, cell: { x: cell.x, y: cell.y },
					point: label, at: pt, hud_rect: hudRect,
				});
			}
		}
	}

	return {
		cells_checked: cells.length,
		hud_rect_found: hudRect !== null,
		finding_count: findings.length,
		findings,
		checked,
	};
}

// ============================================================================
// harness-assertions (tooling_audit_v1.md finding 1 / backlog #1) — the
// missing VERDICT primitive. Before this, a scenario's only automated fail
// signals were a step throwing, a browser console error, or a non-empty
// ui_findings array — a bridge action that the game correctly REFUSES came
// back as {"success": false} and the step was still recorded `ok: true`,
// because nothing ever read what the result actually said. Demo 1 in the
// audit proved this concretely: a repair set up to fail reported
// "5/5 steps succeeded", exit 0.
// ============================================================================

// parsePath / resolvePath / reasonMatches / evaluateAssertState now live in
// predicates.mjs (imported at the top of this file) — the first extraction of
// the planned run_scenario split, done so the predicate semantics are
// unit-testable without spawning this file as a child process.

// Where a session snapshot's lineage sidecar lives: "<session>.json" pairs
// with "<session>.meta.json".
function sessionMetaPath(stateFile) {
	return stateFile.replace(/\.json$/, ".meta.json");
}

function readSessionMeta(stateFile) {
	const metaFile = sessionMetaPath(stateFile);
	if (!existsSync(metaFile)) return null;
	try {
		return JSON.parse(readFileSync(metaFile, "utf-8"));
	} catch {
		return null;
	}
}

// Invoke a bridge action and return its parsed result. The transport owns the
// mechanics (the browser transport does the evaluate + 250ms result-settle +
// window read exactly as this function used to inline; the desktop transport
// does one call round-trip on the socket, whose response IS the result).
async function callBridgeAction(t, fnName, args) {
	return t.call(fnName, args);
}

// harness-assertions: "expect"/"expect_reason" turn a bridge action's own
// result into a step verdict, same shape as assert_state. Default (neither key
// present) is legacy behavior — the result is recorded but not judged. Shared
// by catalog actions and the generic-bridge builtins, both of which produce a
// {"success": ...} result; extracted verbatim from the catalog-action branch.
function applyExpectCheck(step, record) {
	if (!step.expect && !step.expect_reason) return;
	const success = record.result?.success;
	const reason = record.result?.reason;
	const mismatches = [];
	if (step.expect === "success" && success !== true) {
		mismatches.push(`expected success:true, got success:${JSON.stringify(success)}`);
	}
	if (step.expect === "refused" && success !== false) {
		mismatches.push(`expected success:false (refused), got success:${JSON.stringify(success)}`);
	}
	// MATCHES THE REASON CODE, NOT ONLY THE WHOLE STRING. A useful
	// refusal carries detail — "card_mismatch: expected brace at 0,
	// found vent" — and exact-match forces the scenario to hardcode
	// that sentence, so improving the message breaks every scenario
	// that asserted on it. The `code: detail` convention is what
	// bridges already write, so honour it: the code alone matches,
	// and the full string still matches for anyone who wants to pin
	// the detail deliberately.
	if (step.expect_reason && !reasonMatches(reason, step.expect_reason)) {
		mismatches.push(`expected reason:"${step.expect_reason}", got reason:${JSON.stringify(reason)}`);
	}
	record.expect_check = { expect: step.expect ?? null, expect_reason: step.expect_reason ?? null, pass: mismatches.length === 0 };
	if (mismatches.length > 0) {
		throw new Error(`expect failed on "${step.action}": ${mismatches.join("; ")} (full result: ${JSON.stringify(record.result)})`);
	}
}

// Perf sampling (evidence.perf). Browser transport only — everything here goes
// through page.evaluate. performance.memory is Chromium-only and may be absent
// even there, so its absence is recorded truthfully rather than guessed at.
async function samplePerf(page, fpsWindowMs) {
	const heap = await page.evaluate(() => {
		const m = performance.memory;
		if (!m) return null;
		return {
			used_js_heap_size: m.usedJSHeapSize,
			total_js_heap_size: m.totalJSHeapSize,
			js_heap_size_limit: m.jsHeapSizeLimit,
		};
	});
	// FPS over a rAF counter: count real presented frames for the window, then
	// divide. A game that has stalled its render loop shows up here in a way no
	// state snapshot can.
	const fps = await page.evaluate((windowMs) => new Promise((resolve) => {
		let frames = 0;
		const start = performance.now();
		const tick = () => {
			frames += 1;
			const elapsed = performance.now() - start;
			if (elapsed >= windowMs) {
				resolve({ frames, elapsed_ms: Math.round(elapsed), fps: Math.round((frames * 1000 / elapsed) * 10) / 10 });
			} else {
				requestAnimationFrame(tick);
			}
		};
		requestAnimationFrame(tick);
	}), fpsWindowMs);
	return {
		js_heap: heap,
		...(heap === null ? { js_heap_note: "performance.memory unavailable (non-Chromium browser)" } : {}),
		fps,
	};
}

async function dumpState(t) {
	// The invoke/settle/read dance lives in the TRANSPORT now (see
	// BRIDGE_SETTLE_MS in transport/browser.mjs). This used to sleep a fixed
	// 150ms and read whatever was there — one of four independent guesses at
	// the same event, and the one whose failure mode was a state snapshot from
	// the step BEFORE this one.
	return t.invokeAndRead(BRIDGE.state_fn, [], BRIDGE.state_var);
}

// Writes screenshots/INDEX.md: every screenshot this run produced, in the
// order a player would have encountered it, with the step's label/note and
// the action that produced it.
//
// This exists for the design-critique protocol. A mechanics-validation review
// reads manifest.json and treats screenshots as spot-checks, so an unordered
// pile of PNGs is fine. A critique review does the opposite — screenshots ARE
// the evidence and their ORDER is the narrative ("minute 1 vs minute 15") —
// and reconstructing that order out of a 200-entry manifest by hand is exactly
// the kind of friction that ends with a reviewer glancing at three images and
// calling it a pass.
function writeScreenshotIndex(runDir, manifest) {
	const rows = [];
	for (const shot of manifest.boot_screenshots ?? []) {
		rows.push({ file: shot, action: "(boot)", note: "Captured before any scenario step ran." });
	}
	for (const step of manifest.steps ?? []) {
		for (const key of ["screenshot", "screenshot_after"]) {
			if (step[key]) rows.push({ file: step[key], action: step.action, index: step.index, note: step.note ?? "" });
		}
		// A ui_sweep takes one screenshot per stop, inside the step. They belong
		// in the index like any other — a sweep is the densest evidence a
		// critique run produces and leaving it out of the reading order would
		// hide it from the exact reviewer it was captured for.
		for (const stop of step.sweep?.visited ?? []) {
			if (!stop.screenshot) continue;
			const flags = [];
			if ((stop.occlusion?.finding_count ?? 0) > 0) flags.push(`${stop.occlusion.finding_count} occluded`);
			if ((stop.scroll?.finding_count ?? 0) > 0) flags.push(`${stop.scroll.finding_count} scroll-unstable`);
			rows.push({
				file: stop.screenshot, action: "ui_sweep", index: step.index,
				note: `${step.note ? step.note + " — " : ""}stop "${stop.stop}"${flags.length ? ` — ${flags.join(", ")}` : ""}`,
			});
		}
	}
	if (rows.length === 0) return;

	const lines = [
		`# Screenshot index — ${manifest.scenario}`,
		"",
		`Run started ${manifest.started_at}. ${rows.length} screenshot(s), in capture order.`,
		"",
		"| # | File | Step | Action | Note |",
		"| :-- | :--- | :--- | :--- | :--- |",
	];
	rows.forEach((r, i) => {
		lines.push(`| ${i + 1} | \`${r.file.replace(/\\/g, "/")}\` | ${r.index ?? "—"} | \`${r.action}\` | ${r.note.replace(/\|/g, "\\|")} |`);
	});
	lines.push("");
	writeFileSync(path.join(runDir, "screenshots", "INDEX.md"), lines.join("\n"));
}

function loadScenario(scenarioPath) {
	const resolved = path.resolve(scenarioPath);
	const raw = readFileSync(resolved, "utf-8");
	const scenario = JSON.parse(raw);
	if (!scenario.name || !Array.isArray(scenario.steps)) {
		throw new Error(`Scenario file must have a "name" string and a "steps" array: ${resolved}`);
	}
	return scenario;
}

// Runs validation and prints results. Returns true if the scenario is clean
// enough to run (i.e. no errors — warnings alone don't block a run).
function checkScenario(scenarioPath, scenario) {
	const { errors, warnings } = validateScenario(scenario);
	if (warnings.length > 0) {
		console.warn(`\n${scenarioPath}: ${warnings.length} warning(s):`);
		for (const w of warnings) console.warn(`  ! ${w}`);
	}
	if (errors.length > 0) {
		console.error(`\n${scenarioPath}: ${errors.length} error(s) — this scenario will NOT run:`);
		for (const e of errors) console.error(`  x ${e}`);
		return false;
	}
	if (warnings.length === 0) {
		console.log(`${scenarioPath}: OK (${scenario.steps.length} steps, no errors or warnings)`);
	} else {
		console.log(`${scenarioPath}: OK (${scenario.steps.length} steps, 0 errors, ${warnings.length} warning(s) above)`);
	}
	return true;
}

async function runScenario(scenario, scenarioPath) {
	// Validate before touching the browser/server at all — a malformed step
	// must abort the whole run, loudly, not produce a manifest full of
	// silently-defaulted actions. See the block comment above validateStep.
	if (!checkScenario(scenarioPath ?? scenario.name, scenario)) {
		throw new Error("Scenario failed validation — aborting before launching the browser. See errors above.");
	}

	// The scenario's display name becomes the run DIRECTORY's name. "Chapter 1:
	// The Beginning" is a perfectly reasonable display name and an invalid
	// directory name on Windows; a name containing separators or ".." would
	// escape runs/ entirely. Same fix, same reasons, as step labels.
	const runId = `${safeFileLabel(scenario.name, "unnamed_scenario")}_${new Date().toISOString().replace(/[:.]/g, "-")}`;
	const runDir = path.join(RUNS_DIR, runId);
	const screenshotsDir = path.join(runDir, "screenshots");
	mkdirSync(screenshotsDir, { recursive: true });

	// One transport per run. The browser transport carries the whole original
	// Playwright path verbatim (port-collision probe, python http.server,
	// chromium launch, goto — see src/transport/browser.mjs, which is a straight
	// extraction of the code that used to live here); the desktop transport
	// spawns the --headless game binary and connects a TCP client to its
	// tcp_bridge (src/transport/desktop.mjs).
	const transport = TRANSPORT_KIND === "desktop" ? createDesktopTransport() : createBrowserTransport();

	const manifest = {
		scenario: scenario.name,
		started_at: new Date().toISOString(),
		finished_at: null,
		build_dir: BUILD_DIR,
		console_errors: [],
		// W8-12. Every occlusion / scroll-instability finding, collected across
		// the whole run so a reviewer does not have to walk a 200-entry step log
		// looking for them. Non-empty means the run found a SURFACE problem —
		// something a player could see or bump into — as opposed to the
		// mechanical failures `steps[].ok` already covers.
		ui_findings: [],
		// Failed checks the author explicitly marked fatal:false. They never
		// fail the run — that is what the flag means — but they must not
		// vanish into stderr either: a manifest reader has to be able to see
		// "this was checked, it failed, and the author chose to continue".
		soft_failures: [],
		steps: [],
	};
	// The browser path's manifest is deliberately byte-identical to what it was
	// before the transport seam existed; a `transport` key is recorded only on
	// the non-default path, where a reader genuinely needs it.
	if (TRANSPORT_KIND !== "browser") manifest.transport = TRANSPORT_KIND;

	// --- flushing the manifest, from either exit ------------------------------
	//
	// The manifest is built in memory across the whole run and written ONCE, in
	// the finally below. That is fine for every ending except the common one:
	// Ctrl+C. A run interrupted at step 40 of 60 used to write nothing at all —
	// no manifest, no screenshot index, forty steps of evidence on disk with no
	// record of what produced them — and left Chromium, a python http.server and
	// (on desktop) the game process running behind it.
	//
	// So the write is a function now, and a signal calls it. Extracted rather
	// than duplicated so the two paths cannot produce differently-shaped
	// bundles, which is the failure that would make the interrupted one
	// unreadable by the same tools.
	const flushManifest = () => {
		// Video and trace files only exist once the browser has closed, so the
		// transport finalizes them in stop() and reports them here. Recorded by
		// relative path, same convention as screenshots.
		const artifacts = typeof transport.artifacts === "function" ? transport.artifacts() : {};
		if (artifacts.video) manifest.video = relForManifest(runDir, artifacts.video);
		if (artifacts.trace) manifest.trace = relForManifest(runDir, artifacts.trace);
		manifest.finished_at = new Date().toISOString();
		// Temp-then-rename, because the flush most likely to matter is the one
		// racing a dying process: a direct overwrite interrupted mid-write
		// leaves truncated JSON, and the repo's own tooling treats a corrupt
		// manifest as poison (prune refuses the whole bundle). The rename is
		// atomic on the same volume on both platforms.
		const manifestPath = path.join(runDir, "manifest.json");
		writeFileSync(`${manifestPath}.tmp`, JSON.stringify(manifest, null, 2));
		renameSync(`${manifestPath}.tmp`, manifestPath);
		writeScreenshotIndex(runDir, manifest);
	};

	let interrupted = false;
	const onSignal = (sig) => {
		// A second Ctrl+C while the first is still tearing down means "stop
		// asking" — go immediately rather than starting a second teardown.
		if (interrupted) process.exit(130);
		interrupted = true;
		console.error(`\n${sig} — flushing the manifest and shutting down. ` +
			`The bundle will be marked incomplete.`);
		// `complete` and `interrupted` appear ONLY on this path. A normal run's
		// manifest is byte-identical to what it has always been; a reader who
		// sees these keys is looking at a bundle that was cut short, and one who
		// does not is not being told anything by their absence that was not
		// already true.
		manifest.complete = false;
		manifest.interrupted = sig;
		manifest.note = `INTERRUPTED by ${sig} after ${manifest.steps.length} step(s). The scenario ` +
			`did not finish, so an absent assertion here means "never reached", not "passed". The ` +
			`last step may have been mid-flight when the signal arrived.`;
		try { flushManifest(); } catch (e) { console.error(`  could not write the manifest: ${e.message}`); }
		// stop() is idempotent on both transports, so the finally below reaching
		// it as well is harmless. Flushed AGAIN after stop(): video/trace only
		// exist once the browser has closed, so the pre-stop flush (which must
		// come first — it is the one guaranteed to run) can never list them.
		// Without the second flush an interrupted run's finalized video.webm
		// sat on disk unreferenced by the manifest that survived.
		Promise.resolve()
			.then(() => transport.stop())
			.catch(() => { /* a half-started transport has little to stop */ })
			.then(() => { try { flushManifest(); } catch { /* the pre-stop flush already landed */ } })
			.finally(() => process.exit(130));
	};
	const signals = ["SIGINT", "SIGTERM"];
	const handlers = signals.map((sig) => [sig, () => onSignal(sig)]);
	for (const [sig, fn] of handlers) process.on(sig, fn);

	try {
		// The transport's error collection IS the manifest's console_errors —
		// the same live array object, aliased before start() so even errors on
		// a failed boot land in the manifest — so entries keep arriving exactly
		// as the old page.on(...) pushes did. On desktop the array collects the
		// game process's stderr lines instead.
		manifest.console_errors = transport.consoleErrors();

		// PLAYWRIGHT_EXECUTABLE_PATH lets a machine that already has a Chromium
		// use it instead of downloading one. Containers and CI images commonly ship
		// a browser whose build number does not match whatever Playwright version
		// npm resolved, and the download then fails with no usable fallback.
		// evidence.video / evidence.trace are BROWSER-transport features —
		// Playwright records them. On desktop the request is recorded as
		// skipped (same tombstone discipline as screenshots there): a reader
		// must be able to tell "not asked for" from "asked for, cannot exist".
		if (transport.kind !== "browser") {
			if (EVIDENCE.video) manifest.video_skipped = "desktop transport";
			if (EVIDENCE.trace) manifest.trace_skipped = "desktop transport";
			if (EVIDENCE.perf) manifest.perf_skipped = "desktop transport";
		}
		// Recorded only when non-default: stretch math depends on window size,
		// so a bundle from an overridden viewport must say so or its click
		// coordinates and screenshots read as anomalies.
		if (VIEWPORT) manifest.viewport = VIEWPORT;

		await transport.start({
			buildDir: BUILD_DIR,
			port: PORT,
			baseUrl: BASE_URL,
			headed: HEADED,
			browserExecutable: process.env.PLAYWRIGHT_EXECUTABLE_PATH ?? CONFIG.browser_executable ?? undefined,
			viewport: VIEWPORT,
			stateFn: BRIDGE.state_fn,
			resultVar: BRIDGE.result_var,
			desktop: CONFIG.desktop ?? {},
			// Opt-in evidence (ROADMAP Tier 2 item 7). The browser transport
			// records into the run bundle; the desktop transport ignores these.
			video: EVIDENCE.video ? { dir: runDir } : null,
			trace: EVIDENCE.trace ? { path: path.join(runDir, "trace.zip") } : null,
		});

		// `capture_boot` exists for the DESIGN-CRITIQUE protocol
		// (CRITIQUE_SKILL.md), which cares about something no ordinary
		// scenario does: what a first-time player actually sees in the
		// seconds before the game is interactive. Every normal scenario's
		// first screenshot step runs *after* the bridge has registered and
		// the first economy ticks have settled, so the entire boot moment —
		// loading bar, whether there's a title screen at all, what greets
		// you first — is structurally invisible to it. That blindness is
		// not hypothetical: "there is no title screen" was one of seven
		// owner-found issues that no amount of prior scenario playtesting
		// surfaced. These two shots are taken before any scenario step runs.
		if (scenario.capture_boot) {
			const bootEarly = path.join(screenshotsDir, "boot_00_first_paint.png");
			const shot = await transport.screenshot(bootEarly);
			if (shot === null) {
				// Desktop headless has no capture — record the skip so a later
				// reader can tell "never captured" from "captured and pruned".
				manifest.boot_screenshots_skipped = "desktop transport";
			} else {
				manifest.boot_screenshots = [relForManifest(runDir, bootEarly)];
				console.log("[boot] captured first paint (pre-bridge)");
			}
		}

		await transport.waitReady();

		// evidence.perf: load time is navigation start → bridge-ready, which is
		// exactly what waitReady just finished awaiting. performance.now()'s
		// origin IS navigation start, so reading it here — before the settle
		// sleep below — measures the game, not the runner's own pauses.
		if (EVIDENCE.perf && transport.kind === "browser") {
			manifest.perf = {
				bridge_ready_ms: Math.round(await transport.page.evaluate(() => performance.now())),
				fps_window_ms: EVIDENCE.fps_window_ms,
			};
		}

		await sleep(500); // let the first economy tick or two settle

		// capture_boot's second shot lands BEFORE the title-screen advance on
		// purpose: the title screen IS part of the boot experience a critique
		// run exists to see (the calibration run's top finding was that no
		// ordinary scenario could ever witness this moment).
		if (scenario.capture_boot) {
			const bootReady = path.join(screenshotsDir, "boot_01_interactive.png");
			const shot = await transport.screenshot(bootReady);
			if (shot !== null) {
				manifest.boot_screenshots.push(relForManifest(runDir, bootReady));
				console.log("[boot] captured first interactive frame (post-bridge, pre-step)");
			}
		}

		// The export now boots to a title screen (feature/first-run-experience),
		// so every scenario's old assumption — boot lands in gameplay — needs
		// this one bridge call. Idempotent: a no-op if gameplay is already
		// running. `false` = Continue semantics (loads the existing user:// save,
		// exactly what booting Main.tscn directly used to do), which keeps
		// SESSION resume behavior unchanged.
		// `boot_with_intro` (default false) is the ONE opt-in that routes the
		// boot through the New Game opening cinematic instead of straight into
		// gameplay. Default-off, and the direction matters: every other
		// scenario in tools/playtest/scenarios/ asserts on gameplay state
		// immediately after this line, so an intro that played by default would
		// break all of them at once. Only the intro evidence run sets it.
		// A game that boots straight into a playable state configures no boot
		// sequence and this is a no-op. A game that boots to a title screen has
		// its config carry the one call that advances past it. `boot_with_intro`
		// is the single opt-in that routes through the opening cinematic instead:
		// default-off, and the direction matters, because every other scenario
		// asserts on gameplay state immediately after this point and an intro
		// playing by default would break all of them at once.
		const bootSeq = scenario.boot_with_intro ? BOOT_SEQUENCE_WITH_INTRO : BOOT_SEQUENCE;
		if (bootSeq.length > 0) {
			console.log(scenario.boot_with_intro ? "Booting through the intro..." : "Running boot sequence...");
			for (const call of bootSeq) {
				await transport.invoke(call.fn, call.args ?? []);
			}
			await sleep(CONFIG.boot_settle_ms ?? 1500); // scene change + _ready() + save load
		}

		// evidence.perf's heap and FPS samples land AFTER the boot sequence, when
		// the game is actually playing — a title screen's frame rate flatters
		// everyone and measures nothing.
		if (EVIDENCE.perf && transport.kind === "browser") {
			console.log(`[perf] sampling JS heap and FPS over ${EVIDENCE.fps_window_ms}ms...`);
			Object.assign(manifest.perf, await samplePerf(transport.page, EVIDENCE.fps_window_ms));
		}

		manifest.session = SESSION;
		if (SESSION) {
			const stateFile = path.join(SESSIONS_DIR, `${SESSION}.json`);
			if (existsSync(stateFile)) {
				console.log(`[session] Resuming "${SESSION}" from ${stateFile}...`);
				const saveJson = readFileSync(stateFile, "utf-8");
				// Desktop wire preflight: the TCP bridge drops any peer whose
				// request line exceeds 1 MiB (its anti-memory-bomb cap), and the
				// whole save blob rides in ONE line. Past the cap the failure
				// presented as a mystery "socket closed with requests in
				// flight"; name the real constraint before sending instead.
				// 900KB of blob leaves headroom for JSON escaping + envelope.
				if (TRANSPORT_KIND === "desktop" && Buffer.byteLength(saveJson, "utf8") > 900_000) {
					throw new Error(
						`session snapshot for "${SESSION}" is ${Buffer.byteLength(saveJson, "utf8")} bytes — ` +
						`too large for the desktop transport's 1 MiB request-line cap (BRIDGE_CONTRACT.md §8). ` +
						`SESSION resume over TCP has a size ceiling; slim the save, or run this session on the browser transport.`);
				}
				const importResult = await callBridgeAction(transport, BRIDGE.save_import_fn, [saveJson]);
				manifest.session_resumed_from = stateFile;
				manifest.session_import_result = importResult;
				// Lineage of the snapshot being resumed, recorded into this
				// run's manifest. The session file is overwritten by EVERY
				// round using the name, including a re-run of an earlier
				// round, so it is entirely possible to resume from a snapshot
				// older than the round you think you are continuing — which
				// looks exactly like the game losing state. The systems UAT's
				// "crafted modules lost on save/load" CRITICAL finding was
				// this and nothing else (see uat_systems_coverage.md §4 and
				// its follow-up); without this field there was no way to tell
				// the two apart from the run bundle alone.
				manifest.session_resumed_meta = readSessionMeta(stateFile);
				if (manifest.session_resumed_meta) {
					console.log(`[session]   snapshot was written by "${manifest.session_resumed_meta.scenario}" at ${manifest.session_resumed_meta.saved_at}`);
				} else {
					console.log(`[session]   WARNING: no sidecar metadata for this snapshot — its lineage is unknown.`);
				}
				if (!importResult || !importResult.success) {
					// A failed resume means every assertion downstream evaluates
					// against the WRONG state while the verdict computes as
					// normal — the "crafted modules lost on save/load" CRITICAL
					// was a stderr warning nobody read. Abort by default; a
					// scenario that genuinely wants to press on says so.
					if (CONFIG.session_continue_on_import_failure) {
						console.error(`[session] WARNING: import_save reported failure — continuing anyway (session_continue_on_import_failure is set). Check manifest.session_import_result.`);
					} else {
						throw new Error(
							`session import failed for "${SESSION}" — every later assertion would run against ` +
							`fresh state, not the state you resumed. Result: ${JSON.stringify(importResult)}. ` +
							`Set "session_continue_on_import_failure": true in playtest.config.json to press on anyway.`);
					}
				}
			} else {
				console.log(`[session] No prior state for "${SESSION}" — starting fresh (this file will be created at the end of this run).`);
			}
		}

		// harness-assertions (audit finding E3/D4): tracks whether ANY UI-truth
		// sweep (ui_sweep, or the raw audit_ui bridge action) has run yet in this
		// scenario, so assert_ui_swept can fail a scenario that never actually
		// looked at the surface — closing the "empty ui_findings is
		// indistinguishable from never-swept" hole.
		let uiSweptSoFar = false;

		for (const [index, step] of scenario.steps.entries()) {
			const record = { index, action: step.action, args: step.args ?? null, timestamp: new Date().toISOString() };
			// `note` is free-text carried straight through to the manifest and
			// the screenshot index. A design-critique run needs to know what
			// BEAT each screenshot represents ("first thing you see after
			// placing your first module") — that framing is what the reviewer
			// reacts to, and it cannot be recovered from an action name.
			if (step.note) record.note = step.note;
			// `label` was printed to the console but never written to the
			// manifest, so a review pass querying "the dump_state labelled
			// helium_check" found nothing and had to fall back to step indices.
			// Found by the producer stress test, 2026-08-05.
			if (step.label) record.label = step.label;
			console.log(`[${index}] ${step.action}${step.label ? ` (${step.label})` : ""}`);

			try {
				if (step.action === "dump_state") {
					record.state = await dumpState(transport);
				} else if (step.action === "screenshot") {
					const label = safeFileLabel(step.label, `step_${index}`);
					const filePath = path.join(screenshotsDir, `${label}.png`);
					const shot = await transport.screenshot(filePath);
					// Desktop headless has no capture: the step is recorded as
					// SKIPPED, not failed — a scenario shared between transports
					// must not fail just because one of them cannot photograph.
					if (shot === null) record.screenshot_skipped = "desktop transport";
					else record.screenshot = relForManifest(runDir, filePath);
				} else if (step.action === "wait") {
					await sleep(step.ms ?? 1000);
				} else if (step.action === "mouse_move") {
					const page = requirePage(transport, step.action);
					const { x = 0, y = 0, steps: moveSteps = 8 } = step.args ?? {};
					// `steps` makes Playwright emit intermediate motion events
					// rather than one teleport — the realistic case for a hover
					// delay, which must not fire while the pointer is still
					// sweeping across cells on its way somewhere else.
					await page.mouse.move(x, y, { steps: moveSteps });
					record.mouse = { x, y };
				} else if (step.action === "mouse_click") {
					const page = requirePage(transport, step.action);
					const { x = 0, y = 0, steps: moveSteps = 8 } = step.args ?? {};
					// Move first, then click, rather than page.mouse.click()'s
					// implicit teleport: Godot only updates a Control's hover
					// state from motion events, and a Button that never saw
					// the pointer arrive can swallow the press.
					await page.mouse.move(x, y, { steps: moveSteps });
					await page.mouse.click(x, y);
					record.mouse_click = { x, y };
				} else if (step.action === "mouse_move_cell" || step.action === "mouse_click_cell") {
					const page = requirePage(transport, step.action);
					const { x: cellX = 0, y: cellY = 0, steps: moveSteps = 8 } = step.args ?? {};
					const point = await cellToPagePoint(transport, cellX, cellY);
					await page.mouse.move(point.x, point.y, { steps: moveSteps });
					if (step.action === "mouse_click_cell") {
						await page.mouse.click(point.x, point.y);
					}
					// Both the cell asked for and the pixel it resolved to are
					// recorded: when a placement lands on the wrong tile, the
					// question is always whether the resolve or the click was
					// wrong, and this is what answers it.
					record.cell = { x: cellX, y: cellY };
					record.mouse = { x: point.x, y: point.y };
					record.cell_resolve = point.bridge;
				} else if (step.action === "mouse_move_control" || step.action === "mouse_click_control") {
					// `node` is what the validator requires and what every
					// scenario therefore writes; `node_name` is what this line
					// read for as long as the action has existed. The two never
					// met, so the argument arrived `undefined` on every call and
					// the bridge was asked to resolve a control called "undefined"
					// — after which the only question left was which error message
					// you got. Accepting both keeps any scenario written against
					// the old spelling working; `node` wins because the validator
					// says so and the validator is the published contract.
					const page = requirePage(transport, step.action);
					const { node, node_name, steps: moveSteps = 8 } = step.args ?? {};
					const nodeName = node ?? node_name;
					if (nodeName === undefined) {
						throw new Error(
							`${step.action} requires args.node (the "%UniqueName" of a Control)`);
					}
					const point = await controlToPagePoint(transport, nodeName);
					await page.mouse.move(point.x, point.y, { steps: moveSteps });
					if (step.action === "mouse_click_control") {
						await page.mouse.click(point.x, point.y);
					}
					record.node_name = nodeName;
					record.mouse = { x: point.x, y: point.y };
					record.control_resolve = point.bridge;
				} else if (step.action === "mouse_right_click") {
					const page = requirePage(transport, step.action);
					const { x = 0, y = 0, steps: moveSteps = 8 } = step.args ?? {};
					await page.mouse.move(x, y, { steps: moveSteps });
					await page.mouse.click(x, y, { button: "right" });
					record.mouse_right_click = { x, y };
				} else if (step.action === "mouse_right_click_cell") {
					const page = requirePage(transport, step.action);
					const { x: cellX = 0, y: cellY = 0, steps: moveSteps = 8 } = step.args ?? {};
					const point = await cellToPagePoint(transport, cellX, cellY);
					await page.mouse.move(point.x, point.y, { steps: moveSteps });
					await page.mouse.click(point.x, point.y, { button: "right" });
					record.cell = { x: cellX, y: cellY };
					record.mouse = { x: point.x, y: point.y };
					record.cell_resolve = point.bridge;
				} else if (step.action === "mouse_click_menu_item") {
					const page = requirePage(transport, step.action);
					const { label, id, steps: moveSteps = 8 } = step.args ?? {};
					const point = await menuItemToPagePoint(transport, { label, id });
					await page.mouse.move(point.x, point.y, { steps: moveSteps });
					await page.mouse.click(point.x, point.y);
					record.menu_item = { label: label ?? null, id: id ?? null };
					record.mouse = { x: point.x, y: point.y };
					record.menu_item_resolve = point.item;
				} else if (step.action === "mouse_scroll") {
					// dx/dy are what the spec has always DECLARED; delta_y is what
					// this line has always READ. So a scenario written from the
					// documentation validated cleanly and then scrolled (0, 0) —
					// a step that reports ok:true having moved nothing, which is
					// the worst outcome available. Both spellings work now, dy
					// wins, and the horizontal axis is finally wired up: `dx` was
					// declared, accepted, and then hardcoded to 0 on the wheel.
					const page = requirePage(transport, step.action);
					const { x = 0, y = 0, dx = 0, dy, delta_y } = step.args ?? {};
					const deltaY = dy ?? delta_y ?? 0;
					await page.mouse.move(x, y);
					await page.mouse.wheel(dx, deltaY);
					// delta_y stays in the record as well as dy: manifests are read
					// by tooling that predates this fix.
					record.mouse_scroll = { x, y, dx, dy: deltaY, delta_y: deltaY };
				} else if (step.action === "assert_no_occlusion") {
					const { whitelist = [], fatal = true } = step.args ?? {};
					const audit = await runOcclusionAudit(transport, whitelist);
					record.occlusion = audit;
					uiSweptSoFar = true;
					if (audit.finding_count > 0) {
						manifest.ui_findings.push({
							step: index, label: step.label ?? null, kind: "occlusion",
							count: audit.finding_count, findings: audit.findings,
							// waived: the author WROTE fatal:false — an explicit
							// decision that this finding must not fail the run. A
							// defaulted fatal never waives; only a written one.
							// (Same field on every ui_findings entry below.)
							waived: step.args?.fatal === false,
						});
						// Fatal by default. An occluded button is not an
						// observation to file away — it is a control the player
						// cannot press, which is the whole reason this step exists.
						if (fatal) {
							throw new Error(
								`${audit.finding_count} occluded interactive control(s): ` +
								audit.findings.map((f) => `${f.name} <- ${f.occluders.join(", ")}`).join("; "));
						}
					}
				} else if (step.action === "scroll_stability") {
					const { seconds = 3, samples = 6, fatal = false } = step.args ?? {};
					const scroll = await runScrollStability(transport, { seconds, samples });
					record.scroll = scroll;
					if (scroll.finding_count > 0) {
						manifest.ui_findings.push({
							step: index, label: step.label ?? null, kind: "scroll_instability",
							count: scroll.finding_count, findings: scroll.findings,
							waived: step.args?.fatal === false,
						});
						// NOT fatal by default: a panel legitimately re-laying out
						// once (a list gaining a row as resources tick past a
						// threshold) is a single content-size change, not jitter,
						// and failing the run on it would train everyone to pass
						// fatal:false everywhere. Read the samples.
						if (fatal) {
							throw new Error(
								`${scroll.finding_count} scroll container(s) moved with no input: ` +
								scroll.findings.map((f) => f.name).join(", "));
						}
					}
				} else if (step.action === "ui_sweep") {
					const label = safeFileLabel(step.label, `sweep_${index}`);
					const sweep = await runUiSweep(transport, screenshotsDir, runDir, label, step.args ?? {});
					record.sweep = sweep;
					uiSweptSoFar = true;
					if (sweep.occlusion_finding_count > 0 || sweep.scroll_finding_count > 0) {
						manifest.ui_findings.push({
							step: index, label, kind: "ui_sweep",
							waived: step.args?.fatal === false,
							occlusion: sweep.occlusion_finding_count,
							scroll: sweep.scroll_finding_count,
							visited: sweep.visited.filter(
								(v) => (v.occlusion?.finding_count ?? 0) > 0 || (v.scroll?.finding_count ?? 0) > 0),
						});
					}
					// A sweep RECORDS rather than throws even when fatal, unless
					// asked: the whole value of a state matrix is finishing the
					// matrix. Aborting at the first bad cell tells you one thing
					// where the run could have told you six.
					if ((step.args?.fatal ?? false) && sweep.occlusion_finding_count > 0) {
						throw new Error(`ui_sweep "${label}" found ${sweep.occlusion_finding_count} occluded control(s)`);
					}
				} else if (step.action === "wait_for") {
					// Wait on a CONDITION, not a duration. `wait ms` sleeps a guessed
					// number and hopes the game got there — the failure mode behind
					// eleven checked-in scenarios that silently slept 1000ms and one
					// playtest that reported a critical bug which did not exist.
					// Same predicate vocabulary as assert_state, so no new concepts.
					const {
						path: pathExpr, op, value,
						timeout_ms: timeoutMs = 10000,
						poll_ms: pollMs = 250,
						fatal = true,
					} = step.args ?? {};
					const started = Date.now();
					let result = null;
					let polls = 0;
					while (Date.now() - started < timeoutMs) {
						const state = await dumpState(transport);
						polls++;
						result = evaluateAssertState(state, pathExpr, op, value);
						if (result.pass) break;
						await sleep(pollMs);
					}
					const waitedMs = Date.now() - started;
					record.wait_for = { ...result, waited_ms: waitedMs, polls, timeout_ms: timeoutMs };
					if (!result || !result.pass) {
						// A timeout is a real failure, not a slow pass. Reporting the
						// last observed value is what makes it diagnosable.
						const detail = `waited ${waitedMs}ms (${polls} polls) for ${pathExpr} ${op} ` +
							`${JSON.stringify(value)}, last saw ${JSON.stringify(result ? result.actual : undefined)}`;
						if (fatal) throw new Error(`wait_for timed out: ${detail}`);
						console.error(`  wait_for (non-fatal) timed out: ${detail}`);
						manifest.soft_failures.push({ step: index, label: step.label ?? null, kind: "wait_for", detail });
					} else {
						console.log(`      condition met after ${waitedMs}ms (${polls} polls)`);
					}
				} else if (step.action === "assert_state") {
					const { path: pathExpr, op, value, fatal = true } = step.args ?? {};
					// "Latest dump_state" per the spec — a fresh snapshot taken at the
					// moment this step runs, not a stale one from an earlier step, so
					// an assertion is always checking what's true RIGHT NOW.
					const state = await dumpState(transport);
					const result = evaluateAssertState(state, pathExpr, op, value);
					record.assert = result;
					if (!result.pass) {
						const detail = result.message
							? result.message
							: `expected ${pathExpr} ${op} ${JSON.stringify(result.expected)}, got ${JSON.stringify(result.actual)}`;
						if (fatal) {
							throw new Error(`assert_state failed: ${detail}`);
						} else {
							console.error(`  assert_state (non-fatal) failed: ${detail}`);
								manifest.soft_failures.push({ step: index, label: step.label ?? null, kind: "assert_state", detail });
						}
					}
				} else if (step.action === "assert_ui_swept") {
					const { fatal = true } = step.args ?? {};
					record.assert_ui_swept = { swept: uiSweptSoFar };
					if (!uiSweptSoFar) {
						const detail = "no audit_ui/ui_sweep/assert_no_occlusion step ran earlier in this scenario — " +
							"the surface was never actually looked at (tooling_audit_v1.md finding E2/D4)";
						if (fatal) throw new Error(`assert_ui_swept failed: ${detail}`);
						else {
								console.error(`  assert_ui_swept (non-fatal) failed: ${detail}`);
								manifest.soft_failures.push({ step: index, label: step.label ?? null, kind: "assert_ui_swept", detail });
							}
					}
				} else if (step.action === "ui_lint") {
					const { fatal = true, ...lintOpts } = step.args ?? {};
					const lint = await runUiLint(transport, lintOpts);
					record.ui_lint = lint;
					uiSweptSoFar = true;
					if (lint.finding_count > 0) {
						manifest.ui_findings.push({
							step: index, label: step.label ?? null, kind: "ui_lint",
							count: lint.finding_count, fatal_count: lint.fatal_finding_count, findings: lint.findings,
							waived: step.args?.fatal === false,
						});
						// Only FATAL (non-warning) findings abort the step, same
						// convention as assert_no_occlusion: near-misalign is
						// warning-severity by design (see runUiLint's comment) and
						// must not fail a run on its own.
						if (fatal && lint.fatal_finding_count > 0) {
							throw new Error(
								`${lint.fatal_finding_count} ui_lint finding(s): ` +
								lint.findings.filter((f) => f.severity !== "warning")
									.map((f) => `${f.rule}@${f.path ?? f.a?.path ?? "?"}`).join("; "));
						}
					}
				} else if (step.action === "assert_consistent") {
					const { fatal = true, rules } = step.args ?? {};
					const consistency = await runAssertConsistent(transport, rules ? { rules } : {});
					record.consistency = consistency;
					if (consistency.finding_count > 0) {
						manifest.ui_findings.push({
							step: index, label: step.label ?? null, kind: "consistency",
							count: consistency.finding_count, findings: consistency.findings,
							waived: step.args?.fatal === false,
						});
						if (fatal) {
							throw new Error(
								`${consistency.finding_count} consistency finding(s): ` +
								consistency.findings.map((f) => `${f.rule}: ${f.detail}`).join("; "));
						}
					}
				} else if (step.action === "assert_board_visible") {
					const { fatal = true } = step.args ?? {};
					const board = await runAssertBoardVisible(transport);
					record.board_visible = board;
					if (board.finding_count > 0) {
						manifest.ui_findings.push({
							step: index, label: step.label ?? null, kind: "board_visible",
							count: board.finding_count, findings: board.findings,
							waived: step.args?.fatal === false,
						});
						if (fatal) {
							throw new Error(
								`${board.finding_count} board-visibility finding(s): ` +
								board.findings.map((f) => `${f.rule}@(${f.cell.x},${f.cell.y})/${f.point}`).join("; "));
						}
					}
				} else if (ACTION_DEFS[step.action]) {
					const def = ACTION_DEFS[step.action];
					const args = buildArgs(step.action, step.args ?? {});
					record.result = await callBridgeAction(transport, def.fn, args);
					if (step.action === "audit_ui") uiSweptSoFar = true;

					// See applyExpectCheck — extracted so the generic-bridge
					// builtins below get the identical verdict semantics.
					applyExpectCheck(step, record);
				} else if (GENERIC_BRIDGE_ACTIONS[step.action]) {
					// Built-in generic-bridge actions (BRIDGE_CONTRACT.md §10).
					// Plain bridge calls — identical over both transports. This
					// branch sits AFTER the catalog branch on purpose: a game
					// whose catalog defines one of these names keeps its own
					// definition (same precedence the validator applies).
					const a = step.args ?? {};
					if (step.action === "dump_controls") {
						// Like dump_state: the fn writes the (possibly large)
						// tree to its own var and the summary to the result var.
						// Both land in the step record; `label` is already on it.
						record.result = await callBridgeAction(transport, BRIDGE.controls_fn, []);
						const controls = await transport.readVar(BRIDGE.controls_var);
						record.controls = controls;
					} else {
						const callFor = {
							click_control: [BRIDGE.click_control_fn, [a.path]],
							press_action: [BRIDGE.press_action_fn, [a.action_name, a.pressed ?? true]],
							send_key: [BRIDGE.send_key_fn, a.unicode !== undefined ? [a.keycode, a.pressed ?? true, a.unicode] : [a.keycode, a.pressed ?? true]],
							set_slider: [BRIDGE.set_slider_fn, [a.path, a.value]],
							select_tab: [BRIDGE.select_tab_fn, [a.path, a.tab_index]],
						};
						const [fn, callArgs] = callFor[step.action];
						record.result = await callBridgeAction(transport, fn, callArgs);
					}
					// These produce a real {"success": ...} result, so expect/
					// expect_reason judge them exactly like catalog actions.
					applyExpectCheck(step, record);
				} else {
					throw new Error(`Unknown action "${step.action}" — not in this game's action catalog. Check the catalog named by playtest.config.json.`);
				}

				// Optional convenience: any step can request a screenshot
				// immediately after it runs, without a separate "screenshot" step.
				if (step.screenshot_after) {
					const label = step.label ? `${safeFileLabel(step.label, `step_${index}`)}_after` : `step_${index}_after`;
					const filePath = path.join(screenshotsDir, `${label}.png`);
					const shot = await transport.screenshot(filePath);
					if (shot === null) record.screenshot_skipped = "desktop transport";
					else record.screenshot_after = relForManifest(runDir, filePath);
				}

				record.ok = true;
			} catch (err) {
				record.ok = false;
				record.error = String(err);
				console.error(`  FAILED: ${err}`);
				manifest.steps.push(record);
				if (scenario.stop_on_failure) {
					console.error("stop_on_failure is set — aborting the rest of the scenario.");
					break;
				}
				continue;
			}
			manifest.steps.push(record);
		}

		if (SESSION) {
			const stateFile = path.join(SESSIONS_DIR, `${SESSION}.json`);
			console.log(`[session] Saving "${SESSION}" state for the next round...`);
			// A round that FAILED steps still exports below (state is state —
			// the failure may be exactly the thing the next round investigates),
			// but the manifest carries steps_failed so a resumer can see it,
			// and the writes are temp-then-rename so a crash mid-save cannot
			// leave a corrupt snapshot (or a new snapshot beside a stale
			// sidecar — wrong lineage was the exact confusion the sidecar was
			// built to dispel).
			const exportResult = await callBridgeAction(transport, BRIDGE.save_export_fn, []);
			if (exportResult && exportResult.success && exportResult.save_json) {
				mkdirSync(SESSIONS_DIR, { recursive: true });
				// Sidecar lineage for whoever resumes this snapshot next — see
				// the session_resumed_meta comment above for why this matters.
				// Deliberately a separate file: the snapshot itself has to stay
				// a byte-for-byte SaveSystem blob that import_save can take.
				const meta = {
					scenario: scenario.name ?? "(unnamed scenario)",
					saved_at: new Date().toISOString(),
					run_dir: path.basename(runDir),
					steps_run: manifest.steps.length,
					steps_failed: manifest.steps.filter((s) => !s.ok).length,
				};
				// Meta FIRST: a crash between the two writes then leaves a stale
				// snapshot with fresh meta — visible as a date mismatch — rather
				// than a fresh snapshot with stale lineage, which reads as the
				// game losing state.
				writeFileSync(`${sessionMetaPath(stateFile)}.tmp`, JSON.stringify(meta, null, 2));
				renameSync(`${sessionMetaPath(stateFile)}.tmp`, sessionMetaPath(stateFile));
				writeFileSync(`${stateFile}.tmp`, exportResult.save_json);
				renameSync(`${stateFile}.tmp`, stateFile);
				manifest.session_saved_to = stateFile;
				manifest.session_saved_meta = meta;
				console.log(`[session] Saved to ${stateFile} — pass the same SESSION=${SESSION} to the next round to resume from here.`);
			} else {
				console.error(`[session] WARNING: export_save failed — no state file written. The next round with this SESSION will start fresh instead of resuming.`);
				manifest.session_export_failed = true;
			}
		}

	} finally {
		// Uninstalled here so a caller that runs more than one scenario in one
		// process does not accumulate a handler per run, each closing over a
		// stale manifest.
		for (const [sig, fn] of handlers) process.off(sig, fn);
		// stop() is guarded because a throwing teardown (browser crashed during
		// close, socket already destroyed) used to propagate out of this finally
		// BEFORE flushManifest ran — losing every step record of the run to an
		// opaque teardown stack. The whole signal-handler apparatus exists so an
		// interrupted run still writes its manifest; a bad teardown must not be
		// the one path that erases that guarantee.
		try {
			await transport.stop();
		} catch (err) {
			manifest.teardown_error = String(err?.message ?? err);
			console.error(`WARNING: transport teardown failed (recorded in manifest): ${manifest.teardown_error}`);
		}
		flushManifest();
	}

	console.log(`\nRun bundle written to: ${runDir}`);
	console.log(`  ${manifest.steps.filter((s) => s.ok).length}/${manifest.steps.length} steps succeeded`);
	if (manifest.console_errors.length > 0) {
		console.error(`  ${manifest.console_errors.length} browser console error(s) — see manifest.json`);
	}
	if (manifest.soft_failures.length > 0) {
		console.error(`  ${manifest.soft_failures.length} soft (fatal:false) check failure(s) — see manifest.json's "soft_failures"`);
	}
	if (manifest.ui_findings.length > 0) {
		console.error(`\n  ${manifest.ui_findings.length} UI SURFACE finding(s) — see manifest.json's "ui_findings":`);
		for (const f of manifest.ui_findings) {
			const at = `step ${f.step}${f.label ? ` (${f.label})` : ""}${f.waived ? " [waived: fatal:false]" : ""}`;
			if (f.kind === "ui_sweep") {
				console.error(`   x ${at}: sweep found ${f.occlusion} occlusion, ${f.scroll} scroll finding(s)`);
				for (const v of f.visited) {
					for (const o of v.occlusion?.findings ?? []) {
						console.error(`       [${v.stop}] "${o.text || o.name}" (${o.class}) blocked by ${o.occluders.join(", ")}`);
					}
					for (const s of v.scroll?.findings ?? []) {
						console.error(`       [${v.stop}] scroll "${s.name}" moved with no input (${s.distinct_offsets} distinct offsets)`);
					}
				}
			} else {
				console.error(`   x ${at}: ${f.count} ${f.kind} finding(s)`);
			}
		}
	}

	return manifest;
}

async function main() {
	const args = process.argv.slice(2);
	const validateOnly = args.includes("--validate");
	// Windows shells (PowerShell, cmd) do not expand globs before handing them
	// to node, so README.md's own documented sweep command
	// (`--validate scenarios/*.json`) arrived here as a literal "*.json" path
	// and failed with ENOENT. Expand simple `dir/*.json`-style patterns
	// ourselves; anything without a "*" passes through untouched.
	const scenarioPaths = args.filter((a) => a !== "--validate").flatMap((a) => {
		if (!a.includes("*")) return [a];
		const dir = path.dirname(a);
		const pattern = new RegExp("^" + path.basename(a).split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
		let names;
		try {
			names = readdirSync(dir);
		} catch {
			return [a]; // fall through to the usual FAILED TO LOAD path
		}
		const matches = names.filter((n) => pattern.test(n)).map((n) => path.join(dir, n));
		return matches.length > 0 ? matches : [a];
	});

	if (scenarioPaths.length === 0) {
		console.error("Usage: node run_scenario.mjs <scenario.json>");
		console.error("       node run_scenario.mjs --validate <scenario.json> [more.json ...]");
		process.exitCode = 1;
		return;
	}

	if (validateOnly) {
		// Pure static check, no browser/server: the pre-flight step every
		// scenario author should run before a live run (see README.md).
		// Exits non-zero if ANY of the given scenarios has errors.
		let allOk = true;
		for (const scenarioPath of scenarioPaths) {
			let scenario;
			try {
				scenario = loadScenario(scenarioPath);
			} catch (err) {
				console.error(`${scenarioPath}: FAILED TO LOAD — ${err}`);
				allOk = false;
				continue;
			}
			if (!checkScenario(scenarioPath, scenario)) allOk = false;
		}
		process.exitCode = allOk ? 0 : 1;
		return;
	}

	// RUN mode takes exactly one scenario. --validate accepts many, so an
	// author who learned that shape will reasonably glob here too — and used to
	// get exactly one run with the rest silently discarded, the exit code
	// reflecting only the first. Refusing beats guessing which one they meant.
	if (scenarioPaths.length > 1) {
		console.error(`ERROR: run mode takes ONE scenario, got ${scenarioPaths.length}:`);
		for (const p of scenarioPaths) console.error(`  ${p}`);
		console.error(`(--validate accepts many; to RUN a suite, invoke once per scenario.)`);
		process.exitCode = 2;
		return;
	}
	const scenarioPath = scenarioPaths[0];
	const scenario = loadScenario(scenarioPath);
	const manifest = await runScenario(scenario, scenarioPath);

	const anyFailed = manifest.steps.some((s) => !s.ok);
	// A UI surface finding fails the run just like a console error does. It is
	// not a judgement call: a control that something else would receive the
	// click for is broken, whatever the state snapshot says. The ONE way out
	// is the author writing fatal:false on the step that produced it — an
	// explicit, in-scenario waiver ("record this, do not fail the run"), which
	// marks the entry waived. That is also exactly what fatal:false already
	// means on assert_state/wait_for, so the flag now means one thing
	// everywhere. Waived findings and soft failures stay in the manifest;
	// they are exempt from the exit code, not from the record.
	const unwaivedFindings = manifest.ui_findings.filter((f) => !f.waived);
	if (anyFailed || manifest.console_errors.length > 0 || unwaivedFindings.length > 0) {
		process.exitCode = 1;
	}
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
