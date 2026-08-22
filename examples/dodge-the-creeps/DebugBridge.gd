extends Node
## DebugBridge for dodge_the_creeps — written by following
## godot-playtest-harness/skills/SETUP_SKILL.md against an unfamiliar project.
##
## SECURITY: registers nothing unless OS.is_debug_build().

const STATE_SCHEMA_VERSION: int = 1

var _dump_state_cb: JavaScriptObject
var _start_game_cb: JavaScriptObject
var _move_player_cb: JavaScriptObject
var _force_hit_cb: JavaScriptObject
var _legal_moves_cb: JavaScriptObject

var _window: JavaScriptObject
var _log: Array[String] = []


func _ready() -> void:
	if not OS.is_debug_build():
		return
	if not OS.has_feature("web"):
		return
	_window = JavaScriptBridge.get_interface("window")
	if _window == null:
		return
	_dump_state_cb = JavaScriptBridge.create_callback(_on_dump_state)
	_window.godotDebugDumpState = _dump_state_cb
	_start_game_cb = JavaScriptBridge.create_callback(_on_start_game)
	_window.godotDebugStartGame = _start_game_cb
	_move_player_cb = JavaScriptBridge.create_callback(_on_move_player)
	_window.godotDebugMovePlayer = _move_player_cb
	_force_hit_cb = JavaScriptBridge.create_callback(_on_force_hit)
	_window.godotDebugForceHit = _force_hit_cb
	_legal_moves_cb = JavaScriptBridge.create_callback(_on_legal_moves)
	_window.godotDebugLegalMoves = _legal_moves_cb
	print("[DebugBridge] registered — DEBUG BUILD ONLY")


func _report_action_result(result: Dictionary) -> void:
	if _window == null:
		return
	_window.godotDebugLastActionResult = JSON.stringify(result)


func _note(entry: String) -> void:
	_log.append(entry)
	if _log.size() > 200:
		_log.remove_at(0)


func _main() -> Node:
	return get_tree().current_scene


func build_state() -> Dictionary:
	var m := _main()
	var player := m.get_node_or_null(^"Player") if m else null
	var mobs := get_tree().get_nodes_in_group(&"mobs")
	var score_timer := m.get_node_or_null(^"ScoreTimer") if m else null
	var running: bool = score_timer != null and not score_timer.is_stopped()
	return {
		"version": STATE_SCHEMA_VERSION,
		"run": {
			"state": "IN_PROGRESS" if running else "IDLE",
			"score": (m.score if m and m.score != null else 0),
		},
		"player": {
			"visible": player.visible if player else false,
			"x": player.position.x if player else 0.0,
			"y": player.position.y if player else 0.0,
		},
		"mob_count": mobs.size(),
		"log": _log,
	}


func _on_dump_state(_args: Array) -> void:
	if _window == null:
		return
	_window.godotDebugLastState = JSON.stringify(build_state())


func _on_start_game(_args: Array) -> void:
	var m := _main()
	if m == null or not m.has_method("new_game"):
		_report_action_result({"action": "start_game", "success": false, "reason": "no main scene"})
		return
	var hud := m.get_node_or_null(^"HUD")
	if hud:
		var btn := hud.get_node_or_null(^"StartButton")
		if btn:
			btn.hide()
	m.new_game()
	_report_action_result({"action": "start_game", "success": true})
	_note("start_game")


func _on_move_player(args: Array) -> void:
	if args.size() < 2:
		_report_action_result({"action": "move_player", "success": false, "reason": "expected x, y"})
		return
	var m := _main()
	var player := m.get_node_or_null(^"Player") if m else null
	if player == null:
		_report_action_result({"action": "move_player", "success": false, "reason": "no player"})
		return
	player.position = Vector2(float(args[0]), float(args[1]))
	_report_action_result({"action": "move_player", "success": true, "x": player.position.x, "y": player.position.y})
	_note("move_player(%s, %s)" % [args[0], args[1]])


func _on_force_hit(_args: Array) -> void:
	var m := _main()
	var player := m.get_node_or_null(^"Player") if m else null
	if player == null:
		_report_action_result({"action": "force_hit", "success": false, "reason": "no player"})
		return
	player.hide()
	player.hit.emit()
	_report_action_result({"action": "force_hit", "success": true})
	_note("force_hit")


func _on_legal_moves(_args: Array) -> void:
	var st := build_state()
	var moves: Array = []
	if st["run"]["state"] == "IDLE":
		moves.append({"action": "start_game", "args": {}})
	else:
		moves.append({"action": "move_player", "args": {"x": 240, "y": 450}})
		moves.append({"action": "force_hit", "args": {}})
	_report_action_result({"action": "legal_moves", "success": true, "moves": moves})
