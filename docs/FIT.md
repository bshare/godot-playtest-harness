# Does this fit my game?

A decision page. Find your row, follow the link, and don't read the rest.

| Your situation | Fit | Where to go |
| :--- | :--- | :--- |
| Godot 4.x, ships a web build | **Yes** — the original, most-proven path | [README quickstart](../README.md#quickstart) |
| Godot 4.x, desktop only | **Yes** — desktop transport, no browser, no pixels | [§ Desktop-only](#you-ship-desktop-only) |
| Need many runs / statistics / CI | **Yes** — this is the reason the harness exists | [§ Many runs](#you-need-many-runs) |
| Want editor-speed iteration on a feature | **Not this** — use godot-mcp for that loop | [§ Editor-speed](#you-want-editor-speed-iteration) |
| Want per-seed balance numbers (sim tier) | **Conditional** — the game must qualify | [§ Sim tier](#you-want-the-sim-tier) |
| Godot 3.x | **No** — 4.x only, stated plainly below | [§ Godot 3.x](#godot-3x-not-supported) |

## You ship web

The primary path. The harness drives the real web export — the artifact players receive — in a
headless browser, through a debug-build-only bridge instead of pixel guessing. The generic addon
([`addons/playtest_bridge/`](../addons/playtest_bridge/README.md)) gives baseline drivability with
zero game code; the hand-written bridge ([`BRIDGE_CONTRACT.md`](../BRIDGE_CONTRACT.md)) is the
upgrade path for semantic actions and a real state schema.

One export quirk to know up front: the debug export must be built with `thread_support` **off** —
the harness's server sends no COOP/COEP headers. `godot-playtest init` writes the preset that way,
and warns loudly when an existing preset has it on.

**Where the zero-game-code floor stops** (measured against the official 3D platformer demo): if
your game's state lives on scene nodes rather than autoload exported properties — typical for a
3D or UI-less game, where the player is a `CharacterBody3D` in the scene — the generic bridge
gives you input synthesis (`press_action`, `send_key`), InputMap validation, console errors, and
qualitative screenshot evidence ("the camera moved"), but position, score, and physics state are
structurally invisible to the fallback `dump_state`. `assert_state` and `wait_for` on gameplay
values, `legal_moves`, and the sim tier all require the hand-written bridge on that shape. The
Control-tree dump also reports layout, not live values — a slider's `value` or a checkbox's
pressed state is verified by screenshot until the dump schema grows those fields (tracked in
[ROADMAP.md](../ROADMAP.md)).

## You ship desktop only

Also supported, since the desktop transport landed
([`BRIDGE_CONTRACT.md` §8](../BRIDGE_CONTRACT.md#8-desktop-transport)). A `--headless` desktop
**debug** build serves the same contract over local TCP (`godot/tcp_bridge.template.gd` is the game
side; `"transport": "desktop"` in `playtest.config.json` is the harness side). Same scenarios, same
catalog, same validator — nothing per-transport leaks into scenario files.

What you give up: there is no canvas, so no screenshots and no real mouse input. `screenshot` steps
are recorded as skipped, and the runner's mouse actions fail loudly rather than pretending. Drive a
desktop game through bridge actions; that is the point of the bridge. If you want screenshots for a
docs-blind critique pass, you need a web export — most Godot projects can produce one even if they
don't ship it.

## You need many runs

Balance sweeps, seeded regression, statistical claims, unattended CI loops. This is the harness's
home ground: a web export is just a page, so N headless browsers run in parallel, and the sim tier
goes further — milliseconds per run, no browser at all. The editor-bound alternative
([godot-mcp](https://github.com/satelliteoflove/godot-mcp)) is architecturally single-client, so
anything needing N runs has to come through here. See
[`CHOOSING_YOUR_TOOLING.md`](../CHOOSING_YOUR_TOOLING.md) for the full comparison.

## You want editor-speed iteration

Use [godot-mcp](https://github.com/satelliteoflove/godot-mcp), not this. No export step, real input
stack, frame-accurate time control — nothing here competes with that inner loop, and
[`CHOOSING_YOUR_TOOLING.md`](../CHOOSING_YOUR_TOOLING.md) says so at length. Most projects that
ship web and develop on desktop want **both**: godot-mcp while writing a feature, this harness to
lock it in as a committed, validated, seeded regression.

## You want the sim tier

The sim tier (thousands of headless runs, aggregate metrics, policy comparison —
[`SIM_TIER.md`](../SIM_TIER.md)) has two hard requirements, and both are properties of the *game*,
not things the harness can supply:

1. **Seeded reproducibility.** Same seed plus same action list must reach the same state. If your
   RNG streams aren't seeded, no tooling fixes that from outside.
2. **A fixed-step tick entry point.** The tier does not need turns — "advance time" is just another
   action, proven on a real idle game — but it cannot drive logic that sits inline in `_process`
   bodies using the frame's own delta. That advances by wall-clock time, so two runs of one seed
   differ by machine speed.

If your game qualifies, you also write a per-game adapter (`playtest_core.gd`) — hand-written, the
main cost of sim-tier onboarding. If it doesn't qualify, the browser tier still works: a game can
adopt the browser tier alone.

## Godot 3.x: not supported

**This harness supports Godot 4.x only.** In 3.x the web-export JavaScript interface is the
`JavaScript` singleton, not 4.x's `JavaScriptBridge`, so the bridge templates don't run there, and
the generic addon (`addons/playtest_bridge/`) is written against the 4.x API. There is no plan to
backport: 4.x is where new projects are, and the cost of maintaining a second bridge dialect
outweighs the audience. If you're on 3.x, godot-mcp won't help either (it requires 4.5+) — your
practical options are GUT/gdUnit4 for in-engine tests, or migrating.
