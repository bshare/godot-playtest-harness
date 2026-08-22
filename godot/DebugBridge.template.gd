extends Node
## DebugBridge — exposes named actions to browser JavaScript so an automated
## harness can drive this game's Web export without guessing pixel coordinates
## against a canvas.
##
## TEMPLATE. Copy to scripts/debug/DebugBridge.gd in your game, register it as
## an autoload, and replace the EXAMPLE section with your game's actions.
## Read BRIDGE_CONTRACT.md before editing.
##
## SECURITY: this registers nothing unless OS.is_debug_build() is true. A
## --export-release build carries no callbacks. Any change to _ready()'s gating
## deserves the same scrutiny as a real security fix, and scripts/ci/
## assert_no_bridge_in_release.sh exists to make a mistake there loud.

## Bump on ANY breaking change to dump_state's shape. A scenario reading an
## unexpected version must stop rather than silently misread keys whose meaning
## changed. Version from the first write — retrofitting this later is painful.
const STATE_SCHEMA_VERSION: int = 1

## Every callback MUST be held in a member variable. A JavaScriptObject that
## goes out of scope is freed and the function silently stops working — the
## symptom is an action that "does nothing" with no error anywhere.
var _dump_state_cb: JavaScriptObject
var _legal_moves_cb: JavaScriptObject
var _state_hash_cb: JavaScriptObject
var _export_save_cb: JavaScriptObject
var _import_save_cb: JavaScriptObject
# --- EXAMPLE: one per action ---
var _example_action_cb: JavaScriptObject

var _window: JavaScriptObject

## Append-only, human-readable. A reviewer reading a failed run needs a
## narrative, not two state snapshots to diff. Cheap, and it is consistently
## the fastest way to understand what actually happened.
var _log: Array[String] = []
const MAX_LOG_ENTRIES: int = 500


func _ready() -> void:
	# THE security gate. Both conditions, in this order.
	if not OS.is_debug_build():
		return
	if not OS.has_feature("web"):
		return

	_window = JavaScriptBridge.get_interface("window")
	if _window == null:
		push_warning("[DebugBridge] no window interface; bridge not registered")
		return

	_register_callbacks()
	print("[DebugBridge] registered — DEBUG BUILD ONLY")


func _register_callbacks() -> void:
	_dump_state_cb = JavaScriptBridge.create_callback(_on_dump_state)
	_window.godotDebugDumpState = _dump_state_cb

	_legal_moves_cb = JavaScriptBridge.create_callback(_on_legal_moves)
	_window.godotDebugLegalMoves = _legal_moves_cb

	_state_hash_cb = JavaScriptBridge.create_callback(_on_state_hash)
	_window.godotDebugStateHash = _state_hash_cb

	_export_save_cb = JavaScriptBridge.create_callback(_on_export_save)
	_window.godotDebugExportSave = _export_save_cb

	_import_save_cb = JavaScriptBridge.create_callback(_on_import_save)
	_window.godotDebugImportSave = _import_save_cb

	# --- EXAMPLE: replace with your game's actions -------------------------
	_example_action_cb = JavaScriptBridge.create_callback(_on_example_action)
	_window.godotDebugExampleAction = _example_action_cb


# =============================================================================
# The result channel — read BRIDGE_CONTRACT.md §3
# =============================================================================

## EVERY action must call this before returning, INCLUDING on the failure path.
## An action that returns without reporting leaves the previous action's result
## on the window, so the runner reads a stale result and the scenario reports
## the wrong outcome while appearing to pass. This has happened for real: two
## actions written before this pattern existed were never retrofitted, and every
## scenario using them was silently wrong until an agent noticed.
##
## THE ONE EXCEPTION is dump_state: it writes godotDebugLastState — its own
## dedicated channel — and reports nothing here. That is the contract's design
## (the runner reads the state var directly), not an omission to "fix"; the TCP
## template documents the same exception. Every OTHER action reports.
##
## Add a test asserting every registered action reports its own result. Write it
## when you add the second action, not the twentieth.
func _report_action_result(result: Dictionary) -> void:
	if _window == null:
		return
	_window.godotDebugLastActionResult = JSON.stringify(_jsonable(result))


## JSON has no encoding for NaN/Infinity; Godot's JSON.stringify emits
## non-standard tokens (nan, inf, -inf) for them that crash a strict JS-side
## JSON.parse. A game value that is legitimately NaN or infinite (a
## division-by-zero in a stat calc, an unset velocity) must not turn into a
## hard step failure on the harness side — null is the honest signal: "not a
## finite number". Route every outgoing Dictionary through this before
## JSON.stringify.
func _jsonable(value: Variant, depth: int = 0) -> Variant:
	if depth > 32:
		# A Dictionary/Array containing itself (legal in GDScript) would recurse
		# forever and stack-overflow the whole bridge mid-dump; depth-cap instead.
		return "<max depth exceeded - possible cycle>"
	match typeof(value):
		TYPE_FLOAT:
			if is_nan(value) or is_inf(value):
				return null
			return value
		TYPE_ARRAY:
			var out_arr: Array = []
			for v in value:
				out_arr.append(_jsonable(v, depth + 1))
			return out_arr
		TYPE_DICTIONARY:
			var out_dict: Dictionary = {}
			for k in value:
				out_dict[str(k)] = _jsonable(value[k], depth + 1)
			return out_dict
		_:
			return value


func _note(entry: String) -> void:
	_log.append(entry)
	if _log.size() > MAX_LOG_ENTRIES:
		_log.remove_at(0)


# =============================================================================
# Inspection
# =============================================================================

func _on_dump_state(_args: Array) -> void:
	if _window == null:
		return
	_window.godotDebugLastState = JSON.stringify(_jsonable(build_state()))


## Return everything a scenario might reasonably assert on. When unsure whether
## to include a field, include it — this is cheap and a missing field costs a
## rebuild-and-rerun cycle to discover.
func build_state() -> Dictionary:
	return {
		"version": STATE_SCHEMA_VERSION,
		# --- EXAMPLE: replace with real game state ---
		"run": {
			"state": "IN_PROGRESS",  # IN_PROGRESS | WON | LOST
			"seed": 0,
		},
		"log": _log,
	}


## OPTIONAL but high value: return the actions that are legal RIGHT NOW, with
## their args. Without it a driving agent guesses and handles rejections; with
## it, it picks from a list and every choice is valid. This is what turns
## "write a scenario blind and commit to it" into a real request/response
## playtest, and it is the single biggest quality difference in how an agent can
## use this harness.
func _on_legal_moves(_args: Array) -> void:
	var moves: Array = []
	# --- EXAMPLE ---
	# for i in hand.size():
	#     if hand[i].is_playable():
	#         moves.append({"action": "play_card", "args": {"hand_index": i}})
	_report_action_result({"action": "legal_moves", "success": true, "moves": moves})


## OPTIONAL, for deterministic games: a stable hash over everything that must
## reproduce — seed, position, and every RNG stream's current offset. With it,
## replaying a recorded action list can be asserted to reach an identical state,
## which is what turns an interesting run into a regression test.
func _on_state_hash(_args: Array) -> void:
	var h: int = 0
	# h = hash([seed, node, air, streams.map(s => s.offset)])
	_report_action_result({"action": "state_hash", "success": true, "hash": h})


# =============================================================================
# Save export/import — OPTIONAL, enables SESSION continuity across runs
# =============================================================================

func _on_export_save(_args: Array) -> void:
	var save_json: String = ""  # SaveSystem.export_to_json()
	_report_action_result({"action": "export_save", "success": true, "save_json": save_json})


func _on_import_save(args: Array) -> void:
	if args.size() < 1:
		_report_action_result({"action": "import_save", "success": false, "reason": "missing save_json"})
		return
	var ok: bool = true  # SaveSystem.import_from_json(str(args[0]))
	_report_action_result({"action": "import_save", "success": ok})


# =============================================================================
# EXAMPLE ACTION — the shape every game action follows
# =============================================================================

## Note the structure, which is the same every time:
##   1. validate arity, report failure, return
##   2. do the thing
##   3. report the outcome, success or not
##   4. note it in the log
##
## Args arrive as an Array in the order playtest.actions.json's `positional`
## declares. Dictionary-valued args arrive as a JSON *string* (the catalog marks
## those with `encode: "json"`), so parse them here.
func _on_example_action(args: Array) -> void:
	if args.size() < 1:
		_report_action_result({
			"action": "example_action",
			"success": false,
			"reason": "expected 1 argument, got %d" % args.size(),
		})
		return

	var target_id: String = str(args[0])

	# ... do the thing, and get a real success/failure out of it ...
	var ok: bool = true

	# Report the REAL outcome. An action that reports success unconditionally is
	# worse than one that fails, because a scenario asserting on it passes while
	# testing nothing.
	_report_action_result({"action": "example_action", "success": ok, "target": target_id})
	_note("example_action(%s) -> %s" % [target_id, ok])
