# 2.5D Demo with GDScript

Harness setup for the official
[`misc/2.5d`](https://github.com/godotengine/godot-demo-projects/tree/master/misc/2.5d)
demo from [`godotengine/godot-demo-projects`](https://github.com/godotengine/godot-demo-projects)
(MIT). The game itself is not in this repo — clone the demos repo and point these files at it (see
Reproducing, below).

## What it proves

This demo ships its own editor plugin (`addons/node25d/`, already enabled in `project.godot`
before the harness ever touches it) — the shape `godot-playtest init` had not yet been run against
a project with a real, pre-existing, pre-enabled plugin. `init` has to add
`addons/playtest_bridge/plugin.cfg` to the `[editor_plugins] enabled` array without disturbing the
existing entry.

## Result

`init` merged cleanly: `project.godot`'s `[editor_plugins]` section ends with a single line —

```
enabled=PackedStringArray("res://addons/node25d/plugin.cfg", "res://addons/playtest_bridge/plugin.cfg")
```

— both plugins in the same `PackedStringArray`, byte-exact, no duplicate section, no second
`enabled=` line. Re-running `init --force` against the already-initialized project reproduced the
same file (idempotent), and both smoke runs
(`runs/smoke_2026-08-22T13-16-01-506Z` and `runs/smoke_2026-08-22T13-16-19-423Z` in the original
scratch setup) passed identically before and after the `--force` re-run.

Gameplay-wise, this is the same UI-less shape as `platformer-3d/` — `dump_controls` at boot returns
almost nothing useful (a hint label is the only Control node), so `scenarios/gameplay_probe.json`
drives `move_forward` and `jump` through the demo's own InputMap actions with `press_action` and
checks before/after screenshots, the same pattern documented in
[`platformer-3d/README.md`](../platformer-3d/README.md) and
[`docs/FIT.md`](../../docs/FIT.md#you-ship-web) ("Where the zero-game-code floor stops").
`playtest.actions.json` is the empty/generic catalog — no game-specific verbs, since there's
nothing to declare beyond the built-in `dump_controls`/`dump_state`/`screenshot`.

| Scenario | Steps | Result |
| :--- | :--- | :--- |
| `smoke.json` | 3 | All passed, 0 console errors (run twice — before and after `init --force`, identical) |
| `gameplay_probe.json` | 12 | All steps passed, 0 console errors |

`gameplay_probe.json`'s own note explains why it exists: "`dump_controls` is thin for this game
(just a hint label)" — so before/after screenshots plus `dump_state` are the only available
evidence for movement, same limit as any UI-less 3D/2.5D game against the generic bridge.

## Reproducing

```bash
git clone https://github.com/godotengine/godot-demo-projects
cd godot-demo-projects/misc/2.5d
godot-playtest init          # merges addons/playtest_bridge/ into the existing enabled-plugins line
# copy this directory's playtest.config.json, playtest.actions.json, and scenarios/ over the
# generated ones (or diff them — they're the same generic-bridge setup)
# export the Web debug preset to build/web-debug, then:
godot-playtest run scenarios/smoke.json
godot-playtest run scenarios/gameplay_probe.json
```

See [`skills/SETUP_SKILL.md`](../../skills/SETUP_SKILL.md) for the full init runbook.
