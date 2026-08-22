# Playtest Bridge — the generic bridge addon

Baseline drivability for any Godot 4.x web export with **zero game code**. Where
`godot/DebugBridge.template.gd` asks you to write your game's bridge by hand before the harness can
do anything, this addon makes day one "install, enable, export, run" — and leaves the hand-written
bridge as the upgrade path rather than the entry fee.

## Install

1. Copy this directory into your game repo as `addons/playtest_bridge/` (the whole folder, so the
   path inside the project is `res://addons/playtest_bridge/`).
2. In the Godot editor: **Project → Project Settings → Plugins**, enable **Playtest Bridge**. This
   registers the `PlaytestBridge` autoload; disabling the plugin removes it again.
3. Export a **debug** web build to `build/web-debug/` as usual (`thread_support` off — the harness's
   server sends no COOP/COEP headers).

That's it. No script to edit, no actions to declare before the first run.

**Security is unchanged from the hand-written contract:** the autoload registers nothing unless
`OS.is_debug_build()` **and** the build is a web export. Enabling the plugin project-wide is safe;
a `--export-release` build carries no callbacks. Verify like always — in the release build's console,
`window.godotDebugDumpControls` must be `undefined`.

## What you get for free

| Browser function | Does |
| :--- | :--- |
| `godotDebugDumpControls()` | Walks the scene tree; writes every visible `Control` — name, path, class, text, global rect, disabled, focused — to `window.godotDebugLastControls`. The accessibility tree the canvas doesn't have. Also carries live state where it applies: `value`/`min_value`/`max_value` on a `Range`, `button_pressed` on a toggle-mode button, `selected`/`selected_text` on an `OptionButton`, `tab` on a `TabContainer`/`TabBar` — so a scenario can verify `set_slider` or `select_tab` actually took, not just infer it from a screenshot. |
| `godotDebugClickControl(path)` | Synthesized left mouse press+release at the control's on-screen center, through `Input.parse_input_event()` — the real input pipeline, so an obscured or `mouse_filter`-blocked control fails honestly instead of "working". |
| `godotDebugPressAction(name, pressed)` | Any `InputMap` action as a real `InputEventAction`. How a UI-less game (movement, pause, confirm) is driven. |
| `godotDebugSendKey(keycode, pressed)` | A raw `InputEventKey`, for games reading keys directly. Keycodes are Godot's `Key` enum values. |
| `godotDebugSetSlider(path, value)` | Sets any `Range` (slider, spin box). Direct property set — no single input event means "value = 0.7" — and reports the value the `Range` actually clamped to. |
| `godotDebugSelectTab(path, tab_index)` | Selects a tab on a `TabContainer` or `TabBar`, bounds-checked. |
| `godotDebugDumpState()` | **Fallback only** — see below. Current scene name plus every autoload's script-exported properties, tagged `"generic_bridge": true`. |

Every action writes its result — success or failure, with a reason — to
`window.godotDebugLastActionResult` before returning, per `BRIDGE_CONTRACT.md` §3. `path` arguments
are the absolute node paths that `godotDebugDumpControls` reports (e.g. `/root/Main/UI/StartButton`).

The intended loop for an agent: dump controls, find the button whose `text` says what you want,
click it by `path`, dump state. No pixel guessing at any step.

## Coexistence with a hand-written DebugBridge

The two are designed to run side by side, and the hand-written bridge **wins**:

- The generic actions (`godotDebugDumpControls`, `godotDebugClickControl`, …) use names no
  hand-written bridge uses, so they simply add to whatever the game exposes.
- `godotDebugDumpState` is registered **only if nothing else has claimed it**. The addon checks
  `typeof window.godotDebugDumpState` (deferred, after every autoload's `_ready`) and stands down if
  a hand-written one exists — regardless of autoload order.

So the upgrade path is incremental: start with the addon alone, and the day the generic state dump
stops being enough, copy in `DebugBridge.template.gd` and write a real `dump_state`. Nothing about
the addon needs to change or be removed; your scenarios that used generic actions keep working.

## What it can't know

The generic bridge knows the scene tree; it does not know your game. It cannot provide semantic
actions (`repair_system`, `play_card`), a meaningful state schema (`run.state`, a `log`, a `seed`),
`legal_moves`, `state_hash`, save export/import for `SESSION` continuity — or anything the sim tier
needs. Those live in the hand-written bridge and the per-game adapter, and always will: they are
knowledge about the game, not about Godot.

## Tests

`test/addon_contract.test.mjs` (part of `npm test`, no Godot required) statically parses
`playtest_bridge.gd` and asserts the contract invariants: security gate before any registration,
every callback held in a member variable, every action reporting its result, and input synthesis —
not method calls — behind click/press/key.
