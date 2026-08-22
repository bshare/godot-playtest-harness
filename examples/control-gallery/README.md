# Control Gallery

Harness setup for the official
[`gui/control_gallery`](https://github.com/godotengine/godot-demo-projects/tree/master/gui/control_gallery)
demo from [`godotengine/godot-demo-projects`](https://github.com/godotengine/godot-demo-projects)
(MIT). The game itself is not in this repo — clone the demos repo and point these files at it (see
Reproducing, below).

## What it proves

The densest GUI shape exercised so far: 66 controls in one dump, covering `set_slider`,
`select_tab`, `click_control`, and typed input through `send_key` — the first live run of several
generic-bridge actions. `playtest.actions.json` is the empty/generic catalog (no game-specific
verbs; `dump_controls`, `dump_state`, and `screenshot` are the only state-independent actions),
because the Control Gallery has no semantic verbs of its own to declare — everything is driven
through the bridge's built-in control actions.

## The bug this found

`scenarios/livefire.json` clicks into a `LineEdit` and sends two key events (`A`, then `B`) to
type into it. The first run against this scenario
(`runs/livefire_2026-08-22T13-16-51-228Z/manifest.json` in the original scratch setup) reported
`success: true` on every `send_key` step — but the follow-up `dump_controls` showed the field's
`text` unchanged at `"LineEdit"` (its placeholder), even though `focused: true`. The bridge's
`send_key` handler was setting `keycode` on the synthesized `InputEventKey` but never `unicode`,
so Godot's `LineEdit` had nothing to insert: the action reported success while silently typing
nothing.

That's a real defect in *this repo*, not the demo. It was fixed in `917f2d8` (`send_key set
keycode but never unicode`) by deriving ASCII from the keycode and accepting an explicit `unicode`
arg. Re-running the same scenario against the fix
(`runs/livefire_2026-08-22T13-19-18-814Z/manifest.json`) shows the field's `text` as
`"LineEditAB"` — the two characters landed.

The lesson generalizes: `expect: success` on an input-synthesis action only proves the engine
*accepted* the event, not that the UI *reacted* to it. Follow every `send_key` or `press_action`
step that matters with a `dump_controls` or `dump_state` step that reads the value back.

## Other findings

- `scenarios/edgecases.json` clicks a control on a tab that isn't selected (`Tab 3`'s
  `RichTextLabel`, while another tab is active). `click_control` refused it with
  `"reason": "control not visible"` rather than clicking through to a hidden control — the
  harness's viewport-space hit test respects Godot's own visibility, so there's no click-through
  bug to report here, just confirmation the check works. The same scenario's second click, on a
  `FoldableContainer` that *is* visible, succeeded normally.
- `scenarios/smoke.json` is the `godot-playtest init`-generated baseline: `dump_controls`,
  `screenshot`, `dump_state`, all passing.

## Results

| Scenario | Steps | Result |
| :--- | :--- | :--- |
| `smoke.json` | 3 | All passed, 0 console errors |
| `livefire.json` | 15 | All steps executed; found the `send_key` unicode bug (fixed in this repo, re-verified passing) |
| `edgecases.json` | 4 | All steps executed; hidden-tab click correctly refused, visible-control click succeeded |

`livefire.json` and `edgecases.json` are exploratory probes (no `expect`/`assert_state` steps —
`--validate` flags this with a warning, correctly), written to exercise specific control types and
capture evidence, not to gate a build. `smoke.json` is the only scenario here with `expect`
assertions.

## Reproducing

```bash
git clone https://github.com/godotengine/godot-demo-projects
cd godot-demo-projects/gui/control_gallery
godot-playtest init          # writes addons/playtest_bridge/, merges export_presets.cfg
# copy this directory's playtest.config.json, playtest.actions.json, and scenarios/ over the
# generated ones (or diff them — they're the same generic-bridge setup)
# export the Web debug preset to build/web-debug, then:
godot-playtest run scenarios/smoke.json
godot-playtest run scenarios/livefire.json
godot-playtest run scenarios/edgecases.json
```

See [`skills/SETUP_SKILL.md`](../../skills/SETUP_SKILL.md) for the full init runbook.
