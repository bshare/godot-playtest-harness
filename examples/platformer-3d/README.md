# Platformer 3D

Harness setup for the official
[`3d/platformer`](https://github.com/godotengine/godot-demo-projects/tree/master/3d/platformer)
demo from [`godotengine/godot-demo-projects`](https://github.com/godotengine/godot-demo-projects)
(MIT). The game itself is not in this repo — clone the demos repo and point these files at it (see
Reproducing, below).

## Read this before the results

This example is **not** a scored playtest success story. It exists to show where the
zero-game-code floor stops, on a shape that hits the limit hardest: a 3D, UI-less game whose state
lives on scene nodes (`CharacterBody3D`) rather than autoload exported properties. Full account:
[`docs/FIT.md` § "You ship web"](../../docs/FIT.md#you-ship-web), the "Where the zero-game-code
floor stops" paragraph.

What that means concretely, on this demo: `dump_controls` returns an empty list at boot (`count:
0` in `runs/smoke_.../manifest.json` from the original scratch setup) — and that's *correct*, not
a bug. There are no `Control` nodes in this scene to enumerate. `dump_state`'s `autoloads` field is
also empty, every run, before and after every input. The generic bridge cannot see the player's
position, whether a coin was collected, or the enemy's state, because none of that lives anywhere
the fallback introspection can reach. Getting `assert_state`, `wait_for`, `legal_moves`, or the sim
tier on this game requires a hand-written bridge
([`BRIDGE_CONTRACT.md`](../../BRIDGE_CONTRACT.md)) that exports the values that matter — nothing
here does that.

## What this run actually demonstrates

With that ceiling stated, the floor still does real work: input synthesis and its failure modes.
`scenarios/movement.json` is the first live exercise of `press_action` (movement, jump, an
InputMap-reset action) and `send_key` (a raw spacebar keycode) against a running 3D game, plus a
negative case — `press_action` against `no_such_action`, which correctly refuses with `"no
InputMap action named 'no_such_action'"` rather than silently no-opping.

Every step passed:

| Scenario | Steps | Result |
| :--- | :--- | :--- |
| `smoke.json` | 3 | All passed, 0 console errors — `dump_controls` returns 0 controls (correct: no UI in this scene) |
| `movement.json` | 29 | All passed (including the expected refusal on `no_such_action`), 0 console errors |

But "all steps passed" here means the engine accepted every input and refused the one bad action —
it does **not** mean gameplay was verified. The only evidence that `move_forward`, `move_right`,
`jump`, and the reset action actually moved the player is qualitative: before/after screenshots at
each step (`screenshots/before_move.png` through `screenshots/after_reset.png` in the original
run). Nothing in this repo diffs those screenshots or asserts on them; a human (or a
docs-blind critique pass, per [`skills/CRITIQUE_SKILL.md`](../../skills/CRITIQUE_SKILL.md)) has to
look.

`playtest.actions.json` is the empty/generic catalog — no game-specific verbs, because this demo
has none to declare beyond the built-ins.

## Reproducing

```bash
git clone https://github.com/godotengine/godot-demo-projects
cd godot-demo-projects/3d/platformer
godot-playtest init          # writes addons/playtest_bridge/, merges export_presets.cfg
# copy this directory's playtest.config.json, playtest.actions.json, and scenarios/ over the
# generated ones (or diff them — they're the same generic-bridge setup)
# export the Web debug preset to build/web-debug, then:
godot-playtest run scenarios/smoke.json
godot-playtest run scenarios/movement.json
```

See [`skills/SETUP_SKILL.md`](../../skills/SETUP_SKILL.md) for the full init runbook.
