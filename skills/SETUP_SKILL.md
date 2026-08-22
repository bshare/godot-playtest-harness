# Setup Skill — wiring this harness into a Godot game

You are an agent. You have been pointed at a Godot game repo and this harness, and asked to make the
game drivable. This document is the complete runbook. **Work through it in order and do not ask the
user anything you can determine by reading the repo or running a command.**

**Definition of done:** a real scenario runs against a real debug export, produces a run bundle with
zero console errors, and `--validate` passes over every scenario in the game repo. Not "the files
exist."

---

## Run `godot-playtest init` first — it does the deterministic 80%

`godot-playtest init --project <game-dir>` (`--dry-run` to preview, `--force` to overwrite) now
performs the mechanical parts of this runbook as code:

- **§0 detection, partially** — finds `project.godot`, reads `config/features` for the 4.x version
  and `config/name` for the game name.
- **The generic bridge instead of §2's hand-copy, for day one** — copies `addons/playtest_bridge/`
  in and enables the plugin in `[editor_plugins]` (surgically; the rest of `project.godot` is
  untouched). The plugin registers the `PlaytestBridge` autoload the next time the editor loads the
  project — including a headless export run.
- **§3's two files** — `playtest.config.json` (port auto-picked from 8060-8079, avoiding sibling
  games' configs) and an empty-skeleton `playtest.actions.json` for the game's own semantic
  actions — the six generic-bridge actions are runner built-ins and must NOT be re-declared in
  the catalog (a catalog entry shadows the built-in, and `dump_controls` then loses its payload).
- **§3's export preset** — writes the minimal Web preset with `variant/thread_support=false` when
  none exists; when one exists it audits it and warns loudly on `thread_support=true`.
- **§1's `.gitignore` entry for `runs/`**, and a starter `scenarios/smoke.json` that `--validate`
  accepts.

What init deliberately does NOT do — the judgment calls this document remains for: finding the
Godot binary and running the exports (§1, §4), the boot sequence past a title screen (§0.4),
semantic actions and the hand-written bridge (§2), the seedable-game adapter and sim tier (§2b),
the verification ladder and deliberate breakage (§4-§5), and affordance parity (§6). Start from
init's output, then work this runbook for the rest.

---

## 0. Before anything: find out what you're working with

Run these and read the answers. Do not proceed on assumptions.

```bash
ls project.godot                      # confirm it IS a Godot project
grep -n "config/features" project.godot   # engine version
grep -n "^\[autoload\]" -A 20 project.godot
ls addons/ 2>/dev/null                # is GUT already installed?
grep -rn "export_presets" -l . 2>/dev/null | head -1
cat export_presets.cfg 2>/dev/null | grep -n "^name=\|^platform="
```

You need four facts before writing anything:

1. **The Godot binary path.** Not on PATH usually. Look for it in `CLAUDE.md`, a `.env`, a script,
   or `$GODOT`. If you genuinely cannot find it, that is one of the two things worth asking about.
2. **Whether a Web export preset exists**, and what it's called. Usually `"Web"`.
3. **What the game's core loop is** — read the design docs if there are any, or the main scene.
   You cannot choose which actions to expose without this.
4. **Whether the game boots straight into play**, or into a title/menu screen. This determines the
   boot sequence in the config. `grep -n "run/main_scene" project.godot` answers it. If it boots to a
   menu, **grep that scene's script for its own scene-transition call** (`change_scene_to_file`,
   `change_scene_to_packed`) and have your boot action call exactly that. Do not reimplement the
   transition or load the gameplay scene yourself — mirroring the game's own call is what keeps the
   boot path real.
5. **Whether the game can be seeded.** `grep -rniE "set_seed|randomize\(|RandomNumberGenerator.new"`
   over the source. This decides whether the **sim tier** (§2b) is available at all, and it is
   usually the ugliest surprise in a setup — see `SIM_TIER.md`, where seeding one small game took
   three separate RNG streams. The browser tier does not need it; every number the sim tier produces
   does.

---

## 1. The two exports, and the security boundary

Set up **two** export targets before writing bridge code:

```bash
mkdir -p build/web build/web-debug   # Godot does NOT create the output directory itself
"$GODOT" --headless --export-release "Web" build/web/index.html        # players
"$GODOT" --headless --export-debug   "Web" build/web-debug/index.html  # harness only
```

Add to `.gitignore`: `build/`, `runs/`, `reports/`.

**Check before adding `screenshots/`** — many projects already have a top-level `screenshots/` for
their README or store page, and blanket-ignoring it would hide real assets. Playtest output lives at
`runs/<name>/screenshots/`, which is already covered by `runs/`.

### The purity check — and two wrong versions of it

**The runtime gate is the security boundary, and it is sufficient.** Verified on real builds: a
release export with the bridge script compiled in exposes `window.godotDebugDumpState === undefined`
and boots with zero console errors, while the debug export of the same project exposes it as a
function. The `OS.is_debug_build()` check does its job.

**Wrong version 1: grepping the release build.** `grep -rq "godotDebug" build/web/` matches for every
game and proves nothing. GDScript compiles into the `.pck` regardless of the runtime gate, so the
function-name strings are present in a correctly-behaving release build. An agent following that
check sees a "leak" that does not exist — and the natural next move is to weaken the check.

**Wrong version 2: excluding the bridge with `exclude_filter`.** This looks like proper defence in
depth and it **breaks your release build**. `project.godot` still declares the autoload, the script
is gone, and every player gets:

```
ERROR: Attempt to open script 'res://scripts/debug/DebugBridge.gd' resulted in error 'File not found'.
ERROR: Failed to instantiate an autoload, can't load from path: res://scripts/debug/DebugBridge.gd.
```

Six console errors on every boot, measured. Godot has no per-preset autoload list, so you cannot
exclude the script and drop the declaration in the same export. **Do not use `exclude_filter` on the
bridge.** This guidance previously said the opposite; it was wrong, and a setup agent followed it
faithfully into a broken build.

**The check that is actually correct** — boot the release export and assert:

```js
typeof window.godotDebugDumpState === "undefined"   // release
typeof window.godotDebugDumpState === "function"    // debug
```

**Do exclude the harness's own files from both exports**, though — they are swept in as resources
otherwise, and there is no reason to ship your action catalog to players:

```ini
exclude_filter="playtest.*.json,scenarios/*"
```

---

## 2. Write the bridge

Copy `godot/DebugBridge.template.gd` from this repo into the game's `scripts/debug/DebugBridge.gd`
and register it as an autoload in `project.godot`.

**Before you write a single hand-rolled action, read §2b.** If this game can be seeded, the state
and the actions belong in an *adapter* that both tiers share, and the bridge becomes a thin
forwarder to it. Writing the bridge's own `build_state` and per-action callbacks first is not
neutral — it is the version that has to be undone, and a bridge that re-implements state makes the
sim/browser parity check compare your two drivers instead of the game.

**Many projects have no `[autoload]` section at all** — you add the section, you do not append to it:

```ini
[autoload]

DebugBridge="*res://scripts/debug/DebugBridge.gd"
```

The leading `*` matters: it makes the script a singleton rather than a plain scene.

Read `BRIDGE_CONTRACT.md` in full before editing it. The three rules that matter most:

1. **Gate on `OS.is_debug_build()` first.** A release build must carry nothing.
2. **Hold a reference to every callback** in a member variable. A `JavaScriptObject` that goes out of
   scope is freed and the function silently stops working.
3. **Every action calls `_report_action_result` before returning, including on failure.** This is the
   contract's sharpest edge: on the origin project two early actions predated this pattern and were
   never retrofitted, so the runner read the *previous* step's result for them and every scenario
   using them silently reported the wrong outcome while appearing to pass. An agent found it, not a
   test.

### Which actions to expose, in this order

Do not try to expose everything. Build in this order and verify each layer works before the next:

| Layer | Actions | Why first |
| :--- | :--- | :--- |
| 1. Inspection | `dump_state` | Nothing else can be verified without it |
| 2. Boot | whatever gets past the title screen | Every scenario needs it |
| 3. The core loop | the 3–6 verbs the game is *about* | This is the game |
| 4. Setup shortcuts | `force_*` to skip past what you're not testing | Only after the real ones exist |
| 5. Inspection extras | `legal_moves`, `state_hash` | Unlock interactive mode and replay |

**Driving a character whose input is polled every frame.** Most games read `Input.get_vector()` (or
similar) inside `_process`/`_physics_process` rather than being moved by direct assignment. Do not
synthesise key events, and do not teleport — **call the same function the game's own `_process`
calls**, so your action travels the real code path including collision, triggers and state updates.
Teleporting past that logic silently desynchronises the game: on a grid-based project, assigning
`player.position` left a stale occupancy cell behind and broke the very next legitimate move.

**A `force_*` action is never a substitute for the real one.** Expose `repair_system` before
`force_repair_all_systems`, or your scenarios will test the shortcut and nothing else.

### `dump_state` — get this right, everything depends on it

- **A `version: int` field from the very first write.** Not "once it settles" — the origin project
  deferred this and had to retrofit it. A scenario reading an unexpected version must be able to
  stop rather than silently misread keys whose meaning changed.
- **A human-readable `log` array.** Append-only, in words. Reviewing a failed run by diffing two
  state snapshots is the slowest part of any investigation; a narrative makes it immediate.
- Everything a scenario might assert on. When unsure, include it — this is cheap.

---

## 2b. The adapter — do this if the game can be seeded

The harness has two tiers (see `SIM_TIER.md`). The headless one runs the real game under
`godot --headless -s`, roughly a thousand times cheaper per run, and it is where balance questions
belong. **Both tiers drive one object**: `res://tools/sim/playtest_core.gd`.

```
playtest_core.gd  ← all game knowledge lives here
   ↑                    ↑
DebugBridge          sim_runner.gd
(browser tier)        (headless tier)
```

Implement seven methods — the contract is documented in full at the top of
`godot/sim_runner.template.gd`:

| Method | Notes |
| :--- | :--- |
| `reset(seed)` | Every RNG the game touches, seeded from here. This is the hard one |
| `build_state()` | The one state builder. The bridge's `dump_state` returns *this*, not its own |
| `legal_moves()` | `[{action, args}]` legal right now. A driver without it can only guess |
| `dispatch(action, args)` | Apply one action, return real success/failure |
| `is_over()`, `outcome()` | End conditions |
| `state_hash()` | Stable over everything that must reproduce |

Then copy `godot/sim_runner.template.gd` to `res://tools/sim/sim_runner.gd` — **you never edit that
file per game** — and have the bridge instantiate the adapter and forward `sim_reset`,
`legal_moves`, `dispatch`, `state_hash` and `policy_step` to it. `examples/` has no worked sim-tier
example yet; the one that exists lives in the roguelike port described in `SIM_TIER.md`.

**Put the hash's own inputs into `build_state`.** If `state_hash()` folds in a monster roster, a
card order, a queue — expose that too. When a parity check fails you get a number, and a number
cannot be debugged; on the first real divergence found this way the diverging turn had byte-identical
player state and localising it meant adding the roster to state first.

If the game **cannot** be seeded, stop here and say so in your hand-back. The browser tier works
fine without the adapter. Do not fake reproducibility.

---

## 3. Write the config and catalog

Two files at the game repo root.

A boot function that takes no arguments gets `"args": []` — the `args` key is required, the array
may be empty. (README's example shows `"args": [false]`, which is one game's boot flag, not a
convention.)

**`playtest.config.json`** — see `README.md` for every key. Minimum:

```json
{
  "game": "<name>",
  "action_catalog": "playtest.actions.json",
  "build_dir": "build/web-debug",
  "runs_dir": "runs",
  "port": 8062,
  "boot_sequence": []
}
```

**Pick a port no other game in your workspace uses.** The runner fails fast on a collision, but two
games sharing 8062 will block each other; give each project its own.

**You do not need to declare `runner_actions`.** `dump_state`, `screenshot`, `assert_state`, the
mouse actions and the UI-lint steps are capabilities of the runner and ship built in. Declare them
only to add a game-specific one or override a spec.

`boot_sequence` is empty if the game boots straight into play. If it boots to a title screen, put the
one call that advances past it here.

**No `export_presets.cfg`?** Many small projects have none, and it cannot be created headlessly —
write it by hand. A minimal working Web preset:

```ini
[preset.0]

name="Web"
platform="Web"
runnable=true
export_filter="all_resources"
include_filter=""
exclude_filter="playtest.*.json,scenarios/*"
export_path=""
script_export_mode=2

[preset.0.options]

variant/extensions_support=false
variant/thread_support=false
html/export_icon=true
html/canvas_resize_policy=2
html/focus_canvas_on_start=true
```

**`variant/thread_support` must be `false`.** A threaded Web export requires cross-origin isolation
(COOP/COEP) headers that a plain static file server does not send, so the game never finishes
booting — and the symptom is not an error, it is the runner sitting at "Waiting for DebugBridge to
register" until something times out. This cost a full debugging cycle the first time it was hit.

**One preset, used for both exports.** `--export-debug` and `--export-release` against the same
preset name is all you need; the bridge's runtime gate is what differs between them, not the preset.
See §1 for why a separate bridge-excluding release preset is a mistake.

**`playtest.actions.json`** — the format is in `ACTION_CATALOG.md`. One entry per action:

```json
{
  "catalog_version": 1,
  "game": "<name>",
  "actions": {
    "play_card": {
      "fn": "godotDebugPlayCard",
      "positional": [{ "name": "hand_index" }, { "name": "target_index", "default": -1 }],
      "required": ["hand_index"],
      "optional": ["target_index"]
    }
  },
  "runner_actions": {
    "dump_state": { "required": [], "optional": [] },
    "screenshot": { "required": [], "optional": [] }
  }
}
```

**Keep the catalog and the bridge in sync in the same edit.** An action in one and not the other is
the failure this format exists to prevent.

---

## 4. Verify, in this exact order

Each step catches a different class of problem. Do not skip ahead.

**Steps 3 and 4 need a browser.** If Playwright's download fails or the machine already ships a
Chromium, point at it rather than fighting it: `PLAYWRIGHT_EXECUTABLE_PATH=/path/to/chrome`, or
`browser_executable` in the config. A sandboxed environment will otherwise stall here, before any of
this is verified.

```bash
# 1. Catalog and config parse, and every scenario is well-formed.
#    Needs no browser, no build, not even npm install.
node $PLAYTEST_HOME/src/run_scenario.mjs --validate scenarios/*.json

# 2. The debug export builds and exposes the bridge.
mkdir -p build/web build/web-debug
"$GODOT" --headless --export-debug "Web" build/web-debug/index.html

# 3. The release export builds and does NOT expose it — behaviourally, not by
#    grepping (see §1).  Boot it and check window.godotDebugDumpState.
"$GODOT" --headless --export-release "Web" build/web/index.html

# 4. A real scenario runs end to end.
node $PLAYTEST_HOME/src/run_scenario.mjs scenarios/smoke.json
```

Your first scenario should be the smallest thing that proves the loop works:

```json
{
  "name": "smoke",
  "stop_on_failure": true,
  "steps": [
    { "action": "dump_state", "label": "boot" },
    { "action": "<one core-loop action>", "args": {}, "screenshot_after": true },
    { "action": "dump_state", "label": "after" }
  ]
}
```

**Then read `runs/smoke_*/manifest.json` and confirm the two `dump_state` snapshots actually
differ in the way the action should have changed them.** A scenario that runs without erroring but
changes nothing is the single most common false pass. Check the state, not the exit code.

### When the target game already spams console errors

"Zero console errors" is part of the definition of done, and on somebody else's game it may be
unreachable through no fault of yours. **Establish whether the errors are yours before treating them
as a blocker:**

```bash
"$GODOT" --headless <the gameplay scene>.tscn    # no bridge, no harness, no browser
```

If the same errors appear there, they are a defect in the game. Report them — with that command as
the evidence — and continue; do not try to fix the game, and do not weaken the check. One real setup
ran with 12,228 console errors per run from a tile-atlas mismatch that reproduced with zero harness
code involved.

If they appear **only** through the harness, they are yours. Stop and fix them.

---

## 5. Prove an action can fail

Before declaring setup done, **deliberately break something and confirm the harness notices**:

- Point a step at an action name that doesn't exist → `--validate` must reject it.
- Add `{"action": "wait", "args": {"ms": 5000}}` → must be a hard error, not a silent 1000ms sleep.
- Put `x` as a top-level step key instead of under `args` → must be a hard error.

All three shipped as silent failures on the origin project and produced false conclusions in real
playtests. If any of them passes quietly here, the harness is not wired up correctly and every
result it later produces is worthless.

---

## 6. Affordance parity — do this now, not later

Keep a map from every player-facing action to the UI control that performs it, and a test that fails
when an action has no entry.

**Twice on the origin project a feature shipped fully implemented, fully tested through the bridge,
and completely unreachable by a player**, because nobody had written down which screen it lived on.
A bridge action is not a substitute for the affordance it stands in for.

`force_*` and inspection actions are exempt — they have no player equivalent by design.

---

## 7. What to hand back

When you're done, report:

- The action list, and which layer (§2) each belongs to
- The verification output from §4, all four steps
- The result of §5's three deliberate breakages
- **Whether the sim tier is available** (§2b), and if not, exactly which RNG streams are unseeded
- If you built the adapter: `node $PLAYTEST_HOME/src/batch.mjs --game . --runs 10 --verify-determinism`
  and one `play_run.mjs --parity` run **with its negative control** (`--sim-policy` differing, which
  must fail at turn 1). A parity check never seen to fail proves nothing
- Anything you could not determine and had to assume — stated plainly, not buried
- **Every place this document was ambiguous, wrong, or insufficient for your game.** This is the most
  valuable thing you produce. Quote the passage. Four of the fixes in this file came from setup
  agents reporting exactly that

**If the machine already has a Chromium** whose build number doesn't match the Playwright version npm
resolved, do not fight the download — point at the existing one:
`PLAYWRIGHT_EXECUTABLE_PATH=/path/to/chrome`, or `browser_executable` in the config.

Then point the next agent at `PLAYTEST_SKILL.md` (mechanics vs. spec) or `CRITIQUE_SKILL.md`
(docs-blind experience critique). Those are different jobs and should not be run by the same agent in
the same session — see the header of either file.

---

## The two things worth asking a human about

Everything else you can determine yourself. Ask only if:

1. **You cannot find the Godot binary** after checking `CLAUDE.md`, `$GODOT`, scripts, and the usual
   install locations. (Export templates matching the engine version must also be installed, or every
   export fails — `~/.local/share/godot/export_templates/<version>/`.)
2. **The game has no Web export preset** and adding one would change how the project ships.

Anything else — action naming, state schema shape, which force actions to add — is your call. Make
it, write down what you chose, and move on.
