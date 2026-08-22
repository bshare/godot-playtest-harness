@tool
extends EditorPlugin
## Registers the generic bridge as an autoload when the plugin is enabled, and
## removes it when disabled. All the actual behavior — and all the security
## gating — lives in playtest_bridge.gd; this file only wires it into the
## project. The autoload itself refuses to register anything outside a debug
## web build, so enabling the plugin in a project that also ships release
## builds is safe by construction.

const AUTOLOAD_NAME := "PlaytestBridge"
const AUTOLOAD_PATH := "res://addons/playtest_bridge/playtest_bridge.gd"


func _enter_tree() -> void:
	add_autoload_singleton(AUTOLOAD_NAME, AUTOLOAD_PATH)


func _exit_tree() -> void:
	remove_autoload_singleton(AUTOLOAD_NAME)
