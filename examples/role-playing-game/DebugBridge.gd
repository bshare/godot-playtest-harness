extends Node
## DebugBridge for the JRPG Demo — written by following
## godot-playtest-harness/skills/SETUP_SKILL.md against an unfamiliar project.
##
## SECURITY: registers nothing unless OS.is_debug_build(). See BRIDGE_CONTRACT.md
## in the harness repo. Any change to _ready()'s gating deserves the same
## scrutiny as a real security fix.

## Bump on any breaking change to build_state()'s shape.
const STATE_SCHEMA_VERSION: int = 1

# Every callback MUST be held in a member variable — a JavaScriptObject that
# goes out of scope is freed and the function silently stops working.
var _dump_state_cb: JavaScriptObject
var _move_player_cb: JavaScriptObject
var _advance_dialogue_cb: JavaScriptObject
var _combat_attack_cb: JavaScriptObject
var _combat_defend_cb: JavaScriptObject
var _combat_flee_cb: JavaScriptObject
var _force_win_combat_cb: JavaScriptObject
var _force_teleport_player_cb: JavaScriptObject
var _legal_moves_cb: JavaScriptObject

var _window: JavaScriptObject

var _log: Array[String] = []
const MAX_LOG_ENTRIES: int = 500

const DIRECTIONS: Dictionary = {
	"up": Vector2i(0, -1),
	"down": Vector2i(0, 1),
	"left": Vector2i(-1, 0),
	"right": Vector2i(1, 0),
}


func _ready() -> void:
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

	_move_player_cb = JavaScriptBridge.create_callback(_on_move_player)
	_window.godotDebugMovePlayer = _move_player_cb

	_advance_dialogue_cb = JavaScriptBridge.create_callback(_on_advance_dialogue)
	_window.godotDebugAdvanceDialogue = _advance_dialogue_cb

	_combat_attack_cb = JavaScriptBridge.create_callback(_on_combat_attack)
	_window.godotDebugCombatAttack = _combat_attack_cb

	_combat_defend_cb = JavaScriptBridge.create_callback(_on_combat_defend)
	_window.godotDebugCombatDefend = _combat_defend_cb

	_combat_flee_cb = JavaScriptBridge.create_callback(_on_combat_flee)
	_window.godotDebugCombatFlee = _combat_flee_cb

	_force_win_combat_cb = JavaScriptBridge.create_callback(_on_force_win_combat)
	_window.godotDebugForceWinCombat = _force_win_combat_cb

	_force_teleport_player_cb = JavaScriptBridge.create_callback(_on_force_teleport_player)
	_window.godotDebugForceTeleportPlayer = _force_teleport_player_cb

	_legal_moves_cb = JavaScriptBridge.create_callback(_on_legal_moves)
	_window.godotDebugLegalMoves = _legal_moves_cb


# =============================================================================
# Result channel — every action calls this before returning, including on
# failure. See BRIDGE_CONTRACT.md §3 for why this is the sharpest edge.
# =============================================================================

func _report_action_result(result: Dictionary) -> void:
	if _window == null:
		return
	_window.godotDebugLastActionResult = JSON.stringify(result)


func _note(entry: String) -> void:
	_log.append(entry)
	if _log.size() > MAX_LOG_ENTRIES:
		_log.remove_at(0)


# =============================================================================
# Node lookups. The game tree looks like:
#   Game
#     Exploration
#       Grid (Player, Opponent, Object children)
#       DialogueCanvas/DialogueUI
#     Combat            <- only in the tree while combat is active
#       Combatants (Player, Opponent)
#       TurnQueue
#       CombatCanvas/UI
# =============================================================================

func _game() -> Node:
	return get_tree().current_scene


func _grid() -> Node:
	var g := _game()
	return g.get_node_or_null(^"Exploration/Grid") if g else null


func _exploration_player() -> Node:
	var g := _grid()
	return g.get_node_or_null(^"Player") if g else null


func _dialogue_ui() -> Node:
	var g := _game()
	return g.get_node_or_null(^"Exploration/DialogueCanvas/DialogueUI") if g else null


func _combat() -> Node:
	var g := _game()
	# Combat is removed from the tree outside of combat (see game.gd _ready),
	# so this is legitimately null most of the time.
	return g.get_node_or_null(^"Combat") if g else null


func _combat_ui() -> Node:
	var c := _combat()
	return c.get_node_or_null(^"CombatCanvas/UI") if c else null


func _combatant(name: String) -> Node:
	var c := _combat()
	return c.get_node_or_null(NodePath("Combatants/" + name)) if c else null


# =============================================================================
# dump_state — everything a scenario might assert on.
# =============================================================================

func _on_dump_state(_args: Array) -> void:
	if _window == null:
		return
	_window.godotDebugLastState = JSON.stringify(build_state())


func build_state() -> Dictionary:
	var grid := _grid()
	var player := _exploration_player()
	var opponent := grid.get_node_or_null(^"Opponent") if grid else null
	var dlg := _dialogue_ui()
	var combat := _combat()

	var player_state := {}
	if player and grid:
		var cell: Vector2i = grid.local_to_map(player.position)
		player_state = {
			"x": player.position.x,
			"y": player.position.y,
			"cell_x": cell.x,
			"cell_y": cell.y,
			"active": player.active,
		}

	var opponent_state := {}
	if opponent:
		opponent_state = {
			"x": opponent.position.x,
			"y": opponent.position.y,
			"lost": opponent.lost,
		}

	var dialogue_state := {
		"visible": dlg.visible if dlg else false,
		"name": (dlg.get_node(^"Name").text if dlg and dlg.visible else ""),
		"text": (dlg.get_node(^"Text").text if dlg and dlg.visible else ""),
	}

	var combat_state = null
	if combat:
		var player_c := _combatant("Player")
		var opponent_c := _combatant("Opponent")
		var turn_queue := combat.get_node_or_null(^"TurnQueue")
		var active_name := ""
		if turn_queue and turn_queue.active_combatant:
			active_name = turn_queue.active_combatant.name
		combat_state = {
			"combatant_count": combat.get_node(^"Combatants").get_child_count(),
			"active_combatant": active_name,
			"player": _combatant_health(player_c),
			"opponent": _combatant_health(opponent_c),
		}

	return {
		"version": STATE_SCHEMA_VERSION,
		"mode": ("COMBAT" if combat else "EXPLORATION"),
		"player": player_state,
		"opponent_exploration": opponent_state,
		"dialogue": dialogue_state,
		"combat": combat_state,
		"log": _log,
	}


func _combatant_health(combatant: Node) -> Dictionary:
	if combatant == null:
		return {}
	var health := combatant.get_node_or_null(^"Health")
	if health == null:
		return {}
	return {
		"life": health.life,
		"max_life": health.max_life,
		"armor": health.armor,
		"active": combatant.active,
	}


# =============================================================================
# Core loop — layer 3
# =============================================================================

## The real player-facing move: WASD / arrow keys, read every frame in
## Walker._process via Input.get_vector. This calls the same
## Grid.request_move + Walker.move_to path directly, which is the correct way
## to drive a per-frame-polled input character from an external bridge
## (simulating individual JS key events into a canvas is unreliable — see
## CHOOSING_YOUR_TOOLING.md).
func _on_move_player(args: Array) -> void:
	if args.size() < 1:
		_report_action_result({"action": "move_player", "success": false, "reason": "expected 1 argument (direction)"})
		return

	var direction_name: String = str(args[0])
	if not DIRECTIONS.has(direction_name):
		_report_action_result({"action": "move_player", "success": false, "reason": "unknown direction '%s'" % direction_name})
		return

	var grid := _grid()
	var player := _exploration_player()
	if grid == null or player == null:
		_report_action_result({"action": "move_player", "success": false, "reason": "not in exploration"})
		return
	if not player.active:
		_report_action_result({"action": "move_player", "success": false, "reason": "player is not active (dialogue or combat in progress)"})
		return

	var direction: Vector2i = DIRECTIONS[direction_name]
	player.update_look_direction(Vector2(direction))
	var target_position: Vector2 = grid.request_move(player, direction)

	var moved := false
	if target_position:
		player.move_to(target_position)
		moved = true
	else:
		# Either blocked by an obstacle, or the move opened dialogue
		# (Grid.request_move calls dialogue_ui.show_dialogue as a side effect
		# when the target cell holds an NPC/object with a DialoguePlayer).
		player.bump()

	_report_action_result({
		"action": "move_player",
		"success": true,
		"direction": direction_name,
		"moved": moved,
		"dialogue_opened": (_dialogue_ui().visible if _dialogue_ui() else false),
	})
	_note("move_player(%s) -> moved=%s" % [direction_name, moved])


## The real player-facing dialogue advance: clicking the dialogue box's
## Button (or pressing the focused ui_accept action, which activates it).
func _on_advance_dialogue(_args: Array) -> void:
	var dlg := _dialogue_ui()
	if dlg == null or not dlg.visible:
		_report_action_result({"action": "advance_dialogue", "success": false, "reason": "no dialogue visible"})
		return
	dlg._on_Button_button_up()
	_report_action_result({
		"action": "advance_dialogue",
		"success": true,
		"dialogue_visible": dlg.visible,
	})
	_note("advance_dialogue -> visible=%s" % dlg.visible)


## The real player-facing Attack button.
func _on_combat_attack(_args: Array) -> void:
	_combat_button_action("attack", "_on_Attack_button_up")


## The real player-facing Defend button.
func _on_combat_defend(_args: Array) -> void:
	_combat_button_action("defend", "_on_Defend_button_up")


## The real player-facing Flee button.
func _on_combat_flee(_args: Array) -> void:
	_combat_button_action("flee", "_on_Flee_button_up")


func _combat_button_action(action_name: String, method_name: String) -> void:
	var ui := _combat_ui()
	if ui == null:
		_report_action_result({"action": action_name, "success": false, "reason": "not in combat"})
		return
	var player_c := _combatant("Player")
	if player_c == null or not player_c.active:
		_report_action_result({"action": action_name, "success": false, "reason": "not the player's turn"})
		return
	ui.call(method_name)
	_report_action_result({"action": action_name, "success": true})
	_note("%s (combat)" % action_name)


# =============================================================================
# Setup shortcuts — layer 4. Never a substitute for the real actions above.
# =============================================================================

## Skips combat resolution by dealing lethal damage directly, to set up a
## scenario that only cares about what happens *after* a win.
func _on_force_win_combat(_args: Array) -> void:
	var opponent_c := _combatant("Opponent")
	if opponent_c == null:
		_report_action_result({"action": "force_win_combat", "success": false, "reason": "not in combat"})
		return
	var health := opponent_c.get_node_or_null(^"Health")
	if health == null:
		_report_action_result({"action": "force_win_combat", "success": false, "reason": "opponent has no Health node"})
		return
	health.take_damage(9999)
	_report_action_result({"action": "force_win_combat", "success": true})
	_note("force_win_combat")


## Skips walking across the map, to set up a scenario near an NPC/object
## without spending steps on transit.
func _on_force_teleport_player(args: Array) -> void:
	if args.size() < 2:
		_report_action_result({"action": "force_teleport_player", "success": false, "reason": "expected x, y"})
		return
	var grid := _grid()
	var player := _exploration_player()
	if grid == null or player == null:
		_report_action_result({"action": "force_teleport_player", "success": false, "reason": "not in exploration"})
		return
	var target_cell := Vector2i(int(args[0]), int(args[1]))
	var target_local: Vector2 = grid.map_to_local(target_cell)
	# Keep the tile map's occupancy in sync so a subsequent move_player sees
	# the player where we actually put it.
	var current_cell: Vector2i = grid.local_to_map(player.position)
	grid.set_cell(current_cell, -1, Vector2i.ZERO)
	grid.set_cell(target_cell, grid.CellType.ACTOR, Vector2i.ZERO)
	player.position = target_local
	_report_action_result({
		"action": "force_teleport_player",
		"success": true,
		"cell_x": target_cell.x,
		"cell_y": target_cell.y,
	})
	_note("force_teleport_player(%s, %s)" % [target_cell.x, target_cell.y])


# =============================================================================
# Inspection extras — layer 5
# =============================================================================

func _on_legal_moves(_args: Array) -> void:
	var moves: Array = []
	var st := build_state()

	if st["dialogue"]["visible"]:
		moves.append({"action": "advance_dialogue", "args": {}})
	elif st["mode"] == "COMBAT":
		var combat: Dictionary = st["combat"]
		if combat.get("player", {}).get("active", false):
			moves.append({"action": "combat_attack", "args": {}})
			moves.append({"action": "combat_defend", "args": {}})
			moves.append({"action": "combat_flee", "args": {}})
	else:
		for dir_name in DIRECTIONS.keys():
			moves.append({"action": "move_player", "args": {"direction": dir_name}})

	_report_action_result({"action": "legal_moves", "success": true, "moves": moves})
