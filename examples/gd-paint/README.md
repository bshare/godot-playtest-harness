# GD Paint

Harness setup for the official
[`gui/gd_paint`](https://github.com/godotengine/godot-demo-projects/tree/master/gui/gd_paint)
demo from [`godotengine/godot-demo-projects`](https://github.com/godotengine/godot-demo-projects)
(MIT). The game itself is not in this repo — clone the demos repo and point these files at it (see
Reproducing, below).

## What it proves

GD Paint uses `content_scale_mode = "viewport"` — the harness's highest-risk spot for mouse input,
since a click has to be translated from browser/canvas pixels through the letterboxed viewport
transform before it lands on the right control. `scenarios/click_probe.json` clicks four tool
buttons and drags a slider through that transform and checks the result both by control state
(`dump_controls`) and screenshot. `playtest.actions.json` is the empty/generic catalog —
`dump_controls`, `dump_state`, and `screenshot` are the only state-independent actions; GD Paint
has no semantic verbs of its own, so everything runs through the bridge's generic control actions.

## Result

All four clicks and the slider drag landed on the intended control, confirmed two ways:

- `click_control`'s own result reports both the raw canvas coordinates and the letterbox-adjusted
  viewport coordinates it actually clicked (e.g. clicking `ButtonToolEraser` at browser point
  (201.5, 93.5) resolved to viewport point (137.5, 57.5) — the offset from the 350px tools panel
  plus letterboxing, composed correctly by `get_final_transform()`).
- The follow-up `dump_controls` after each click shows the expected side effect: `LabelTools`'
  text changes from `"Selected tool: Pencil"` to `"Selected tool: Eraser"` then `"...Circle
  shape"`, the clicked button's `focused` flips to `true`, and after `set_slider` on
  `HScrollBarBrushSize` the brush-size label reads `"Brush size: 5.0px"` — the requested value.

| Scenario | Steps | Result |
| :--- | :--- | :--- |
| `smoke.json` | 3 | All passed, 0 console errors |
| `click_probe.json` | 13 | All steps passed, 0 console errors — viewport-stretch click transform verified correct |

One gap this run does **not** close: GD Paint's stretch landed on `1×` scale (the browser viewport
matched the game's base resolution), so this proves offset-only letterboxing, not a combined
scale+offset case. Forcing a 2× case (smaller browser viewport, or a per-game viewport override)
is tracked in [ROADMAP.md](../../ROADMAP.md) under "Combined scale+offset stretch untested."

`click_probe.json`'s own note calls it a "manual probe for viewport-stretch `click_control`
validation, not part of the harness's own test suite" — it carries `expect: success` on each
click/slider step, so `--validate` passes clean with no warnings, but it was written to exercise
this one risk spot rather than to gate a build. `smoke.json` is the `godot-playtest init` baseline.

## Reproducing

```bash
git clone https://github.com/godotengine/godot-demo-projects
cd godot-demo-projects/gui/gd_paint
godot-playtest init          # writes addons/playtest_bridge/, merges export_presets.cfg
# copy this directory's playtest.config.json, playtest.actions.json, and scenarios/ over the
# generated ones (or diff them — they're the same generic-bridge setup)
# export the Web debug preset to build/web-debug, then:
godot-playtest run scenarios/smoke.json
godot-playtest run scenarios/click_probe.json
```

See [`skills/SETUP_SKILL.md`](../../skills/SETUP_SKILL.md) for the full init runbook.
