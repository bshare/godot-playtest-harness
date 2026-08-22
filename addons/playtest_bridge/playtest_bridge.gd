extends Node
## PlaytestBridge — the GENERIC debug bridge. Installed as an addon, registered
## as an autoload by plugin.gd, and it gives any Godot 4.x game baseline
## drivability with zero custom code: a Control-tree dump (the accessibility
## tree a canvas lacks), input-synthesizing generic actions, and a fallback
## state dump built from autoload exported properties.
##
## It deliberately knows nothing about any specific game. Semantic actions
## ("repair_system"), a real dump_state schema, legal_moves, and the sim tier
## all come from a hand-written bridge (godot/DebugBridge.template.gd), which
## COEXISTS with this one and WINS wherever the two overlap — see
## _register_state_fallback below.
##
## SECURITY: this registers nothing unless OS.is_debug_build() is true. A
## --export-release build carries no callbacks. Any change to _ready()'s gating
## deserves the same scrutiny as a real security fix. test/addon_contract.test.mjs
## statically asserts the gate precedes every registration — keep it passing.

## Every callback MUST be held in a member variable. A JavaScriptObject that
## goes out of scope is freed and the function silently stops working — the
## symptom is an action that "does nothing" with no error anywhere.
var _dump_controls_cb: JavaScriptObject
var _click_control_cb: JavaScriptObject
var _press_action_cb: JavaScriptObject
var _send_key_cb: JavaScriptObject
var _set_slider_cb: JavaScriptObject
var _select_tab_cb: JavaScriptObject
var _dump_state_cb: JavaScriptObject

var _window: JavaScriptObject


func _ready() -> void:
	# THE security gate. Both conditions, in this order, before anything is
	# created or assigned. BRIDGE_CONTRACT.md §1.
	if not OS.is_debug_build():
		return
	if not OS.has_feature("web"):
		return

	_window = JavaScriptBridge.get_interface("window")
	if _window == null:
		push_warning("[PlaytestBridge] no window interface; bridge not registered")
		return

	_register_callbacks()
	# The state fallback must not race a hand-written DebugBridge autoload that
	# happens to be ordered after this one. Deferring runs the check after every
	# autoload's _ready, so a hand-written godotDebugDumpState is visible and wins.
	call_deferred("_register_state_fallback")
	print("[PlaytestBridge] generic bridge registered — DEBUG BUILD ONLY")


func _register_callbacks() -> void:
	_dump_controls_cb = JavaScriptBridge.create_callback(_on_dump_controls)
	_window.godotDebugDumpControls = _dump_controls_cb

	_click_control_cb = JavaScriptBridge.create_callback(_on_click_control)
	_window.godotDebugClickControl = _click_control_cb

	_press_action_cb = JavaScriptBridge.create_callback(_on_press_action)
	_window.godotDebugPressAction = _press_action_cb

	_send_key_cb = JavaScriptBridge.create_callback(_on_send_key)
	_window.godotDebugSendKey = _send_key_cb

	_set_slider_cb = JavaScriptBridge.create_callback(_on_set_slider)
	_window.godotDebugSetSlider = _set_slider_cb

	_select_tab_cb = JavaScriptBridge.create_callback(_on_select_tab)
	_window.godotDebugSelectTab = _select_tab_cb


## The fallback state dump registers ONLY when no hand-written bridge already
## claimed godotDebugDumpState. The hand-written bridge is the upgrade path —
## it knows the game's real state — so it wins, unconditionally. Checking
## through JavaScriptBridge.eval (not a member flag) means the check is against
## what the browser actually sees, whichever autoload got there first.
func _register_state_fallback() -> void:
	if str(JavaScriptBridge.eval("typeof window.godotDebugDumpState")) != "undefined":
		print("[PlaytestBridge] hand-written godotDebugDumpState found; generic fallback not registered")
		return
	_dump_state_cb = JavaScriptBridge.create_callback(_on_dump_state)
	_window.godotDebugDumpState = _dump_state_cb


# =============================================================================
# The result channel — BRIDGE_CONTRACT.md §3
# =============================================================================

## EVERY action calls this before returning, INCLUDING on the failure path.
## An action that returns without reporting leaves the previous action's result
## on the window, so the runner reads a stale result and the scenario reports
## the wrong outcome while appearing to pass. That has happened for real on the
## origin project; test/addon_contract.test.mjs guards it here.
func _report_action_result(result: Dictionary) -> void:
	if _window == null:
		return
	# _jsonable (below) maps NAN/INF floats to null before they hit
	# JSON.stringify — a value like set_slider's Range.value can legitimately be
	# non-finite, and the non-standard token Godot would otherwise emit crashes
	# a strict JS-side JSON.parse.
	_window.godotDebugLastActionResult = JSON.stringify(_jsonable(result))


# =============================================================================
# Control-tree dump — the accessibility tree the canvas doesn't have
# =============================================================================

## Walks the whole scene tree and emits every visible Control. This is what
## lets an agent "click the button labeled Start" on a game it has never seen,
## instead of guessing pixel coordinates against an opaque canvas.
##
## The full tree goes to window.godotDebugLastControls (it can be large); the
## result var carries the summary, per the contract's result pattern.
func _on_dump_controls(_args: Array) -> void:
	var controls: Array = []
	_collect_controls(get_tree().root, controls)
	_window.godotDebugLastControls = JSON.stringify({
		"version": 1,
		"controls": controls,
	})
	_report_action_result({"action": "dump_controls", "success": true, "count": controls.size()})


func _collect_controls(node: Node, out: Array) -> void:
	if node is Control:
		var c := node as Control
		if c.is_visible_in_tree():
			# get_global_rect is canvas-space. Good for reading layout; the
			# click action recomputes through get_screen_transform so a scaled
			# or transformed CanvasLayer still gets hit where it renders.
			var rect: Rect2 = c.get_global_rect()
			var entry: Dictionary = {
				"name": str(c.name),
				"path": str(c.get_path()),
				"class": c.get_class(),
				"global_rect": {
					"x": rect.position.x, "y": rect.position.y,
					"w": rect.size.x, "h": rect.size.y,
				},
				# Only some Controls (BaseButton family) have `disabled`; for the
				# rest get() returns null and this reads false, which is truthful.
				"disabled": c.get("disabled") == true,
				"focused": c.has_focus(),
			}
			# Buttons, labels, LineEdits… anything with a text property. The
			# label an agent will address the control by.
			var text: Variant = c.get("text")
			if text is String and text != "":
				entry["text"] = text
			# Sliders, SpinBoxes, ScrollBars, ProgressBars — anything that is a
			# Range. Layout alone can't tell an agent whether set_slider landed;
			# only the live value can.
			if c is Range:
				var r := c as Range
				entry["value"] = r.value
				entry["min_value"] = r.min_value
				entry["max_value"] = r.max_value
			# Toggle-mode buttons (CheckBox, CheckButton, toggle Buttons) carry
			# real on/off state. Plain push buttons don't have a meaningful
			# pressed state, so they're left alone — same truthful-typing rule
			# as `text` above.
			if c is BaseButton and (c as BaseButton).toggle_mode:
				entry["button_pressed"] = (c as BaseButton).button_pressed
			if c is OptionButton:
				var ob := c as OptionButton
				entry["selected"] = ob.selected
				if ob.selected >= 0:
					entry["selected_text"] = ob.get_item_text(ob.selected)
			if c is TabContainer:
				entry["tab"] = (c as TabContainer).current_tab
			elif c is TabBar:
				entry["tab"] = (c as TabBar).current_tab
			out.append(entry)
	for child in node.get_children():
		_collect_controls(child, out)


# =============================================================================
# Generic actions — real InputEvents through Input.parse_input_event
# =============================================================================
# Synthesizing input instead of calling methods is the point: a click that
# travels the real input pipeline proves the control is actually hittable —
# not obscured, not mouse_filter'd away — where calling pressed.emit() proves
# only that the method works. CHOOSING_YOUR_TOOLING.md concedes exactly this
# gap to godot-mcp; this closes most of it.

## godotDebugClickControl(path) — left mouse press+release at the center of the
## Control's on-screen rect.
func _on_click_control(args: Array) -> void:
	if args.size() < 1:
		_report_action_result({"action": "click_control", "success": false, "reason": "expected path argument"})
		return
	var c := _resolve_control(str(args[0]), "click_control")
	if c == null:
		return
	if not c.is_visible_in_tree():
		_report_action_result({"action": "click_control", "success": false, "path": str(args[0]), "reason": "control not visible"})
		return

	# get_screen_transform includes CanvasLayer offsets but lands in the
	# viewport's CANVAS (design-resolution) space — while parse_input_event
	# expects WINDOW coordinates, because the input pipeline applies the
	# stretch transform to incoming events itself. Injecting canvas coords
	# therefore misses by the stretch factor; verified live against a
	# canvas_items/expand 1920x1080 game in a 1280x720 window, where the
	# "successful" click landed on empty background. get_final_transform is
	# identity when the viewport is unstretched, so this is a no-op there.
	var canvas_center: Vector2 = c.get_screen_transform() * (c.size * 0.5)
	var center: Vector2 = c.get_viewport().get_final_transform() * canvas_center

	var press := InputEventMouseButton.new()
	press.button_index = MOUSE_BUTTON_LEFT
	press.pressed = true
	press.position = center
	press.global_position = center
	Input.parse_input_event(press)

	var release := InputEventMouseButton.new()
	release.button_index = MOUSE_BUTTON_LEFT
	release.pressed = false
	release.position = center
	release.global_position = center
	Input.parse_input_event(release)

	_report_action_result({
		"action": "click_control", "success": true,
		"path": str(args[0]), "x": center.x, "y": center.y,
		"canvas_x": canvas_center.x, "canvas_y": canvas_center.y,
	})


## godotDebugPressAction(action_name, pressed=true) — any InputMap action,
## which is how a UI-less game (player movement, pause, confirm) is driven.
func _on_press_action(args: Array) -> void:
	if args.size() < 1:
		_report_action_result({"action": "press_action", "success": false, "reason": "expected action_name argument"})
		return
	var action_name := str(args[0])
	var pressed: bool = true if args.size() < 2 else bool(args[1])
	if not InputMap.has_action(action_name):
		_report_action_result({
			"action": "press_action", "success": false,
			"reason": "no InputMap action named '%s'" % action_name,
		})
		return
	var ev := InputEventAction.new()
	ev.action = action_name
	ev.pressed = pressed
	Input.parse_input_event(ev)
	_report_action_result({"action": "press_action", "success": true, "name": action_name, "pressed": pressed})


## godotDebugSendKey(keycode, pressed=true, unicode=auto) — a raw key, for
## games reading keys directly rather than through InputMap. Keycodes are
## Godot's Key enum values.
##
## `unicode` is what LineEdit/TextEdit/CodeEdit actually read to decide what
## character to insert — they do not treat `keycode` as a character, only as
## a shortcut/navigation key (backspace, enter, arrows...). Leaving the codec
## unset therefore made every send_key into a focused text field silently type
## nothing, with `success: true` and no error anywhere — verified live against
## control_gallery's LineEdit. An explicit 3rd argument wins; otherwise this
## derives unicode from keycode when it falls in the printable ASCII range,
## which covers the common case (KEY_A == 65 == 'A', KEY_0..KEY_9 == ASCII
## digits) without requiring every caller to compute a codepoint by hand. A
## caller needing a character the keycode can't express alone (lowercase,
## shifted symbols) passes unicode explicitly.
func _on_send_key(args: Array) -> void:
	if args.size() < 1:
		_report_action_result({"action": "send_key", "success": false, "reason": "expected keycode argument"})
		return
	var keycode: int = int(args[0])
	var pressed: bool = true if args.size() < 2 else bool(args[1])
	var unicode: int = int(args[2]) if args.size() > 2 else (keycode if keycode >= 32 and keycode <= 126 else 0)
	var ev := InputEventKey.new()
	ev.keycode = keycode
	ev.physical_keycode = keycode
	ev.unicode = unicode
	ev.pressed = pressed
	Input.parse_input_event(ev)
	_report_action_result({"action": "send_key", "success": true, "keycode": keycode, "pressed": pressed, "unicode": unicode})


## godotDebugSetSlider(path, value) — sets any Range (HSlider, SpinBox,
## ProgressBar…). Set directly rather than synthesized: there is no single
## InputEvent that means "value = 0.7", only a drag gesture whose outcome
## depends on step/page/orientation. The reported `value` is what the Range
## actually clamped to, which is the truthful outcome.
func _on_set_slider(args: Array) -> void:
	if args.size() < 2:
		_report_action_result({"action": "set_slider", "success": false, "reason": "expected path and value arguments"})
		return
	var c := _resolve_control(str(args[0]), "set_slider")
	if c == null:
		return
	if not (c is Range):
		_report_action_result({"action": "set_slider", "success": false, "path": str(args[0]), "reason": "control is not a Range"})
		return
	var r := c as Range
	r.value = float(args[1])
	_report_action_result({"action": "set_slider", "success": true, "path": str(args[0]), "value": r.value})


## godotDebugSelectTab(path, tab_index) — TabContainer or TabBar. Direct for
## the same reason as set_slider: a tab switch has no single input event.
func _on_select_tab(args: Array) -> void:
	if args.size() < 2:
		_report_action_result({"action": "select_tab", "success": false, "reason": "expected path and tab_index arguments"})
		return
	var c := _resolve_control(str(args[0]), "select_tab")
	if c == null:
		return
	var tab_index: int = int(args[1])
	if c is TabContainer:
		var tc := c as TabContainer
		if tab_index < 0 or tab_index >= tc.get_tab_count():
			_report_action_result({"action": "select_tab", "success": false, "path": str(args[0]), "reason": "tab_index %d out of range (0..%d)" % [tab_index, tc.get_tab_count() - 1]})
			return
		tc.current_tab = tab_index
	elif c is TabBar:
		var tb := c as TabBar
		if tab_index < 0 or tab_index >= tb.tab_count:
			_report_action_result({"action": "select_tab", "success": false, "path": str(args[0]), "reason": "tab_index %d out of range (0..%d)" % [tab_index, tb.tab_count - 1]})
			return
		tb.current_tab = tab_index
	else:
		_report_action_result({"action": "select_tab", "success": false, "path": str(args[0]), "reason": "control is not a TabContainer or TabBar"})
		return
	_report_action_result({"action": "select_tab", "success": true, "path": str(args[0]), "tab_index": tab_index})


## Shared lookup. Reports the failure itself (so callers just return on null) —
## which is why a null return here never leaves a stale result behind.
func _resolve_control(path: String, action: String) -> Control:
	# Resolved from the TREE ROOT, not from this autoload. dump_controls emits
	# absolute paths (str(get_path()) -> /root/...), which resolve identically
	# either way — but a hand-written scene-relative path used to resolve
	# against /root/PlaytestBridge, producing a confusing "no node at path" (or,
	# worse, an accidental match on a child of the bridge itself).
	var node: Node = get_tree().root.get_node_or_null(NodePath(path))
	if node == null:
		_report_action_result({"action": action, "success": false, "path": path, "reason": "no node at path"})
		return null
	if not (node is Control):
		_report_action_result({"action": action, "success": false, "path": path, "reason": "node is not a Control"})
		return null
	return node as Control


# =============================================================================
# Fallback state dump — only when no hand-written bridge exists
# =============================================================================

## The generic best-effort dump_state: every autoload's script-exported
## properties, plus the current scene. It cannot know what the game's state
## MEANS — no run/log/seed semantics, no legal_moves — which is exactly why a
## hand-written dump_state overrides it (see _register_state_fallback).
## `generic_bridge: true` lets a scenario tell which one it is talking to.
func _on_dump_state(_args: Array) -> void:
	var autoloads: Dictionary = {}
	for child in get_tree().root.get_children():
		if child == self or child == get_tree().current_scene:
			continue
		# SECURITY: this dump cannot know what an exported property MEANS, so
		# it redacts by NAME (_exported_properties) and offers a per-autoload
		# opt-out (_is_playtest_bridge_hidden). Why it matters: a debug web
		# build hosted anywhere reachable (an itch draft page, a staging URL,
		# a tunnel) hands every autoload's exported state to any page that can
		# reach window.godotDebugDumpState. Debug-build gating alone is not an
		# access control — see BRIDGE_CONTRACT.md §8.
		if _is_playtest_bridge_hidden(child):
			continue
		autoloads[str(child.name)] = _exported_properties(child)
	var scene: Node = get_tree().current_scene
	_window.godotDebugLastState = JSON.stringify({
		"version": 1,
		"generic_bridge": true,
		"current_scene": str(scene.name) if scene != null else "",
		"autoloads": autoloads,
	})
	_report_action_result({"action": "dump_state", "success": true, "generic_bridge": true})


## Opt-out for an autoload carrying data that must never leave the process,
## even in a debug build: `const PLAYTEST_BRIDGE_HIDDEN := true` on the
## autoload's script excludes it from the fallback dump entirely. A
## hand-written dump_state (DebugBridge.template.gd) is unaffected — this only
## guards the generic autoload-property dump this addon provides when no
## hand-written one exists.
func _is_playtest_bridge_hidden(node: Node) -> bool:
	var script: Script = node.get_script()
	if script == null:
		return false
	return bool(script.get_script_constant_map().get("PLAYTEST_BRIDGE_HIDDEN", false))


## Property names that smell like credentials are redacted BY DEFAULT. Exported
## autoload properties are exactly where API URLs, tokens and keys end up, and
## this generic dump would otherwise copy them into every run bundle — files
## that get committed, attached to bug reports, and read by review tooling.
## The developer who genuinely needs one dumped opts in per autoload with
## `const PLAYTEST_BRIDGE_UNREDACTED := true` (the inverse of
## PLAYTEST_BRIDGE_HIDDEN); a hand-written dump_state is unaffected, as ever.
const _SENSITIVE_NAME := "(?i)(secret|token|api_?key|password|passwd|credential|auth)"


func _exported_properties(node: Node) -> Dictionary:
	var props: Dictionary = {}
	if node.get_script() == null:
		return props
	var unredacted: bool = bool(node.get_script().get_script_constant_map().get("PLAYTEST_BRIDGE_UNREDACTED", false))
	var sensitive := RegEx.create_from_string(_SENSITIVE_NAME)
	for prop in node.get_property_list():
		var usage: int = prop.get("usage", 0)
		if usage & PROPERTY_USAGE_SCRIPT_VARIABLE and usage & PROPERTY_USAGE_EDITOR:
			if not unredacted and sensitive.search(prop.name) != null:
				# The NAME stays visible so a reader knows the field exists and
				# was withheld — "<redacted>" is a fact, absence is a mystery.
				props[prop.name] = "<redacted>"
			else:
				props[prop.name] = _jsonable(node.get(prop.name))
	return props


## JSON.stringify chokes gracefully but inconsistently on engine types; make
## the conversion explicit so a Vector2 reads the same in every dump.
func _jsonable(value: Variant, depth: int = 0) -> Variant:
	if depth > 32:
		# A Dictionary/Array containing itself (legal in GDScript) would recurse
		# forever and stack-overflow the whole bridge mid-dump; depth-cap instead.
		return "<max depth exceeded - possible cycle>"
	match typeof(value):
		TYPE_NIL, TYPE_BOOL, TYPE_INT, TYPE_STRING:
			return value
		TYPE_FLOAT:
			# JSON has no encoding for NaN/Infinity; Godot's JSON.stringify emits
			# non-standard tokens (nan, inf, -inf) for them that crash a strict
			# JS-side JSON.parse. null is the honest signal: "not a finite number".
			if is_nan(value) or is_inf(value):
				return null
			return value
		TYPE_ARRAY:
			var out: Array = []
			for v in value:
				out.append(_jsonable(v, depth + 1))
			return out
		TYPE_DICTIONARY:
			var out: Dictionary = {}
			for k in value:
				out[str(k)] = _jsonable(value[k], depth + 1)
			return out
		_:
			return str(value)
