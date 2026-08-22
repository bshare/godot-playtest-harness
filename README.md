# godot-playtest-harness

Automated playtesting for Godot 4.x that ends in a **verdict you can trust**, not a green light
you have to second-guess. Scenario runs produce evidence bundles — a per-step `manifest.json`,
screenshots, state snapshots — and the numbers they feed are guarded the whole way down: seeded
headless batches whose determinism and isolation are **verified, not assumed**; a parity check
proving the cheap tier plays the same game as the browser; a coverage report that tells "no
findings" apart from "never looked"; and a validator whose hard errors exist because each one
once let a run pass while silently testing nothing. Built for unattended loops — CI, nightly
sweeps, AI agents playing from `legal_moves` — not just one-off E2E clicking.

It drives the running game from the outside through a **debug-build-only bridge**: over
`JavaScriptBridge` for a web export in a headless browser, or over local TCP for a `--headless`
desktop debug build ([`BRIDGE_CONTRACT.md` §8](BRIDGE_CONTRACT.md#8-desktop-transport)). Extracted
from a production Godot game, where it was built and proven, and since validated against several more
games of deliberately different shapes.

Not sure it fits? **[`docs/FIT.md`](docs/FIT.md)** is the decision page, and
[Compared to other tools](#compared-to-other-tools) below is the honest landscape — including when
you want [godot-mcp](https://github.com/satelliteoflove/godot-mcp) instead (editor inner loop) or
both ([`CHOOSING_YOUR_TOOLING.md`](CHOOSING_YOUR_TOOLING.md)). Godot 3.x is not supported; 4.x only.

## Quickstart

From nothing to a first green run in about ten minutes. Every command runs identically in
PowerShell and any POSIX shell. Node 20+ and a Godot 4.x editor binary required.

**1. Install the harness — once, for every game on the machine:**

```bash
npm install -g godot-playtest-harness
npx playwright install chromium     # once, for the browser tier
```

([On npm](https://www.npmjs.com/package/godot-playtest-harness), MIT. To work on the harness
itself instead, clone this repo, `npm install`, and `npm link` — the same `godot-playtest`
command then runs your checkout.)

**2. Scaffold your game repo:**

```bash
cd path/to/my-game
godot-playtest init
```

`init` detects the Godot version, writes `playtest.config.json`, adds a debug web export preset
with `thread_support` off (or audits an existing one and warns loudly if it is on), installs and
enables the generic bridge addon ([`addons/playtest_bridge/`](addons/playtest_bridge/README.md) —
baseline drivability with **zero game code**), generates an empty starter catalog (the generic
actions are runner built-ins — re-declaring one in the catalog would shadow it) and
`scenarios/smoke.json`, and covers `runs/` in `.gitignore`. `--dry-run` prints the plan without
touching a file; `--force` overwrites. No bridge to write — and no scenario to write — before the
first run.

**3. Export and run:**

```bash
godot-playtest export                        # drives godot --headless --export-debug
godot-playtest validate scenarios/*.json     # static check — no browser, no build needed
godot-playtest run scenarios/smoke.json      # first green run: bundle + screenshots in runs/
```

A minimal first scenario, if you'd rather write one than use init's generated `smoke.json` — `dump_state`
and `screenshot_after` work on any game, including one running only the generic addon:

```jsonc
{ "name": "smoke",
  "steps": [ { "action": "dump_state", "label": "boot", "screenshot_after": true } ] }
```

To watch a run in a headed browser, set `HEADED=1` — an environment variable, so the one place the
two shells differ:

```bash
HEADED=1 godot-playtest run scenarios/smoke.json            # POSIX
```

```powershell
$env:HEADED = "1"; godot-playtest run scenarios/smoke.json  # PowerShell
```

`godot-playtest --help` lists the subcommands (`validate`, `run`, `play`, `batch`, `coverage`,
`prune`, `sweep`, `export`, `init`). Each is a thin dispatch onto a script in `src/` — a plain
clone still works without the bin, and `node <clone>/src/run_scenario.mjs ...` (the old
`PLAYTEST_HOME` style) runs the same code with the same flags.

**One install, no `node_modules` per game.** The game repo carries only its config, its action
catalog, and its scenarios. From here, the upgrade path is a hand-written bridge for semantic
actions ([`BRIDGE_CONTRACT.md`](BRIDGE_CONTRACT.md)) and, for games that qualify, the sim tier
([`SIM_TIER.md`](SIM_TIER.md)).

---

## Two tiers

| Tier | What it answers | Cost | Entry point |
| :--- | :--- | :--- | :--- |
| **browser** | What does a player see? Does this screen work? | seconds per run | `run_scenario.mjs`, `play_run.mjs` |
| **sim** | What happens across a thousand runs? | milliseconds per run | `sim_runner.gd`, `batch.mjs` |

Both drive the **same game code through the same adapter**, so a balance number measured on the
cheap tier is a number about the real game. `play_run.mjs --parity` is what proves that claim rather
than assuming it. **[`SIM_TIER.md`](SIM_TIER.md) is the guide to the second tier** — read it before
writing an adapter, and read it before trusting any number a batch produces.

A game can adopt the browser tier alone. The sim tier additionally requires seeded reproducibility,
which is a property of the *game*, not something the harness can supply
([`docs/FIT.md`](docs/FIT.md#you-want-the-sim-tier)).

Three checks decide whether anything the sim tier tells you is true, and they test different
properties — passing one says nothing about the others:

| Check | Question | Catches |
| :--- | :--- | :--- |
| `batch.mjs --verify-determinism` | Same batch twice, same result? | An unseeded RNG stream |
| `batch.mjs --verify-isolation` | Last seed batched == run alone? | `reset()` leaking between runs |
| `play_run.mjs --parity` | Headless == browser, turn by turn? | A tier not playing the real game |

Run all three — a real game has already passed one while failing another
([why this rule exists → design notes](docs/DESIGN_NOTES.md#determinism--a-check-can-pass-for-the-wrong-reason)).

## Compared to other tools

The map as of August 2026, stated up front so you don't have to discover the overlaps yourself.
[`PRIOR_ART.md`](PRIOR_ART.md) has the long version with links and what was borrowed from whom.

| Tool | What it is | Relationship to this harness |
| :--- | :--- | :--- |
| [GUT](https://github.com/bitwes/Gut) / [gdUnit4](https://github.com/godot-gdunit-labs/gdUnit4) | In-engine unit/scene test frameworks | **Complementary, keep using one.** They test functions; this drives a running game. Nothing here replaces them |
| [godot-mcp](https://github.com/satelliteoflove/godot-mcp) | MCP server for the editor inner loop — scene edits, input injection, frame-stepped time | **Complementary** ([`CHOOSING_YOUR_TOOLING.md`](CHOOSING_YOUR_TOOLING.md)). Better inner loop (no export step, real input stack, clock control); editor-bound and single-client, so no headless/parallel/seeded outer loop |
| [godot-stagehand](https://github.com/mrf/godot-stagehand) | JSON scenarios, evidence artifacts, MCP + CLI over token-auth TCP | **The closest overlap** — it independently arrived at scenario files + evidence bundles + loopback-token security. It has no sim tier (no seeded batches, determinism/isolation verification, matrices, or parity), no `legal_moves`-driven play, no coverage/diff/prune, no UI audits, and drives by selector rather than a game-defined action catalog |
| [PlayGodot](https://github.com/Randroids-Dojo/PlayGodot) / [godot-e2e](https://github.com/RandallLiuXin/godot-e2e) | Python/pytest E2E over engine debug protocols | Same goal, different mechanism: generic engine-level driving vs. a semantic bridge with scenario files, evidence retention, and a validator |
| AltTester / Regression Games / modl.ai | Commercial game-test platforms | No Godot-native support (Unity-only, or vision-based engine-agnostic) |

Two honest notes. **MCP/agent support is table stakes, not a differentiator** — at least five Godot
MCP servers exist; this harness has one too ([`docs/MCP.md`](docs/MCP.md)), and it is not the reason
to pick it. The reasons are the parts with no found equivalent for Godot: the sim tier's
verification trio (determinism, isolation, parity), `legal_moves`-driven interactive play,
`coverage`'s never-looked discipline, `diff`/`prune`'s evidence lifecycle, and the UI audits
(occlusion, scroll stability, lint). If you need none of those, godot-stagehand is a reasonable
lighter-weight choice, and this table will say so for as long as that stays true.

## Why a bridge

A Godot web export renders entirely into one `<canvas>`: no DOM, no accessibility tree, so
Playwright selectors and everything like them see **nothing**. The fix is a **debug bridge** — a
debug-build-only autoload exposing named actions, so the harness calls
`window.godotDebugSelectRightDockTab("achievements")` instead of guessing where that tab is on
screen. The generic addon's `godotDebugDumpControls` is the accessibility tree the canvas lacks.
See [`BRIDGE_CONTRACT.md`](BRIDGE_CONTRACT.md) for what a game implements, and
[the design notes](docs/DESIGN_NOTES.md#why-a-bridge-at-all) for the pixel-clicking failures that forced
this design.

## Security — read before exporting anything

The bridge registers its callbacks **only** when `OS.is_debug_build()` is true. A normal
`--export-release` build — what players receive — never carries it. Never point this harness at a
release build, and never ship a debug export to anyone.

If you're unsure whether a build has the bridge: check the browser console for
`window.godotDebugDumpState` being `undefined` (release) or a function (debug). The desktop
transport adds two more layers on top of debug-only — an explicit `--playtest-bridge` opt-in flag
and a loopback-only bind ([`BRIDGE_CONTRACT.md` §8](BRIDGE_CONTRACT.md#8-desktop-transport)).

**Debug-build gating is not an access control.** When no hand-written `dump_state` exists, the
generic addon's fallback serializes every autoload's exported properties — in a real project that
can mean API URLs, keys, or feature-flag config living on some `Config` or `Services` autoload.
`OS.is_debug_build()` only says the *bridge* is present; it says nothing about who can reach it. A
debug web export hosted anywhere with a reachable URL — an itch.io draft page, a staging server, a
tunnel used to show a build to a tester — hands that dump to any page able to call
`window.godotDebugDumpState()`, not just the harness. Treat "debug build reachable over the
network" the same as "these values are public," and if an autoload genuinely must not be dumped,
mark it:

```gdscript
# On the autoload's script — excludes it from the fallback dump entirely.
const PLAYTEST_BRIDGE_HIDDEN := true
```

This only affects the generic fallback in `addons/playtest_bridge/playtest_bridge.gd`; a
hand-written `dump_state` in your own `DebugBridge.gd` already returns exactly the fields you
chose, so this opt-out doesn't apply to it.

---

## What a game provides

Two files at the game repo root, plus scenarios. `godot-playtest init` writes starters for both.

### `playtest.config.json`

```jsonc
{
  "game": "my-game",
  "action_catalog": "playtest.actions.json",
  "build_dir": "build/web-debug",   // debug export — never build/web
  "runs_dir": "runs",               // gitignore this
  "port": 8062,

  // How to get from a cold page load to a playable state. A game that boots
  // straight into play leaves this empty.
  "boot_sequence": [{ "fn": "godotDebugStartGame", "args": [false] }],

  // Only if the game renames the contract functions — see BRIDGE_CONTRACT.md.
  "bridge": { "state_fn": "godotDebugDumpState" }
}
```

`"transport": "desktop"` switches the runner to the TCP transport for desktop-only games.

### `playtest.actions.json`

The action catalog: every bridge action, how to call it, and how to validate it. Format in
[`ACTION_CATALOG.md`](ACTION_CATALOG.md); a worked example of a hand-written catalog in
[`examples/role-playing-game/`](examples/role-playing-game/) (grid movement, dialogue,
turn-based combat).

Six generic actions — `dump_controls`, `click_control`, `press_action`, `send_key`, `set_slider`,
`select_tab` — ship built into the runner with no catalog entry needed, mirroring the generic
addon, so a game running only `addons/playtest_bridge/` is scriptable before its catalog exists.
A catalog that defines one of those names wins
([`ACTION_CATALOG.md`, "Built-in generic actions"](ACTION_CATALOG.md#built-in-generic-actions)).

## Scenarios

```jsonc
{
  "name": "reach_first_repair",
  "stop_on_failure": true,
  "steps": [
    { "action": "close_how_to_play" },
    { "action": "dump_state", "label": "initial" },
    { "action": "repair_system", "args": { "system_id": "lift_spire" }, "screenshot_after": true },
    { "action": "wait", "ms": 2000 },
    { "action": "dump_state", "label": "final" }
  ]
}
```

Each run writes `runs/<name>_<timestamp>/` containing `manifest.json` — every step's action, args,
result or state snapshot, timestamp and pass/fail — plus `screenshots/`. Opt-in evidence goes
further: `"evidence": {"video": true, "trace": true, "perf": true}` in `playtest.config.json` (or
`PLAYTEST_EVIDENCE_VIDEO=1` and friends, for one run) adds a `video.webm` of the whole session, a
Playwright `trace.zip`, and boot-time/FPS/heap numbers to the bundle. Browser transport only —
a desktop run records the request as skipped — and with none enabled the bundle is byte-identical
to one made before the feature existed.

**`manifest.json` is ground truth.** If a screenshot appears to disagree with the nearest
`dump_state`, trust the state. Screenshots are for layout and rendering problems, not for
re-deriving a number you can read exactly from JSON. Interactive sessions write a manifest too,
rewritten after every mutating call so it survives a crashed run — the incident that forced both
properties is in the
[design notes](docs/DESIGN_NOTES.md#manifests--bookkeeping-for-the-run-that-dies).

### Always validate before running

```bash
godot-playtest validate scenarios/*.json     # the validator expands the * itself, so this works in PowerShell too
```

Runs without a browser, a build, or even a Godot install. It catches unknown actions, missing
required args, and a top-level step key shaped like a misplaced argument — each of which shipped,
passed, and produced a false verdict in a real playtest before it was a hard error. `wait`'s `ms`
is a top-level step key; every other action's parameters go under `args`.
([The eleven sleeping scenarios and the false BLOCKER → design notes](docs/DESIGN_NOTES.md#validation-and-the-cost-of-a-silent-default).)

### Wait on a condition, not a duration

```jsonc
{ "action": "wait_for",
  "args": { "path": "combat.turn", "op": ">=", "value": 3, "timeout_ms": 10000 } }
```

Polls `dump_state` until the predicate holds, then proceeds immediately; fails loudly on timeout,
reporting the last value it saw. Same predicate vocabulary as `assert_state`, so it costs no new
concepts, and a fatal `wait_for` counts as a judgement — a scenario using one isn't "unjudged".

**Prefer this over `wait` whenever you are waiting for something specific.** A blind `wait`
confirms nothing and has already manufactured a critical bug that did not exist
([why → design notes](docs/DESIGN_NOTES.md#why-wait_for-exists)).

### `fatal: false` means one thing

Every checking action (`assert_state`, `wait_for`, the UI audits) takes `fatal` (default `true`:
a failure aborts the scenario). Writing **`fatal: false`** is an explicit waiver with one meaning
everywhere: *record the failure, keep going, and don't fail the run for it*. Soft check failures
land in the manifest's `soft_failures`; UI findings from a waived step are marked `waived: true`
in `ui_findings`. Only a **written** `fatal: false` waives the run verdict — a defaulted one never
does, so a `ui_sweep` that merely defaults to not-aborting still fails the run on what it finds.

### Cross-run state continuity

Set the **same** `SESSION=<name>` on every round of a multi-round trial:

```bash
SESSION=my_trial godot-playtest run scenarios/round1.json        # POSIX
SESSION=my_trial godot-playtest run scenarios/round2.json
```

```powershell
$env:SESSION = "my_trial"                                        # PowerShell
godot-playtest run scenarios/round1.json
godot-playtest run scenarios/round2.json
```

Without it each round boots a completely fresh game — which has silently voided a whole multi-round
trial once already
([design notes](docs/DESIGN_NOTES.md#cross-run-state-and-the-trial-that-secretly-restarted)).
Requires the game to implement save export/import
([`BRIDGE_CONTRACT.md` §4](BRIDGE_CONTRACT.md#4-the-required-functions)).

## Evidence retention

After writing a report:

```bash
godot-playtest prune runs/critique_20260809 --dry-run
godot-playtest prune runs/critique_20260809
godot-playtest sweep runs --dry-run     # per milestone, not per run
```

**The report is the retention manifest.** Screenshots cited in it are promoted to `evidence/`,
renamed by the finding ID that cites them, and kept. Everything else is deleted, with its filename
recorded in `MANIFEST.md` so a later reader can tell "never captured" from "captured and pruned" —
and recapture exactly, since runs are seeded.

An agent therefore cannot delete what it cited, and cannot hoard without writing a finding.
`prune_run` refuses to run without a report, refuses any path outside a `runs/` tree, and
`--dry-run` changes nothing. The 194 MB incident that produced this design is in the
[design notes](docs/DESIGN_NOTES.md#retention--why-the-report-is-the-manifest).

---

## Proven against third-party games

Two complete worked setups, both produced by following `skills/SETUP_SKILL.md` against unfamiliar
[official Godot demos](https://github.com/godotengine/godot-demo-projects) and both verified against
real Godot 4.7 web exports:

| Example | Shape | Result |
| :--- | :--- | :--- |
| `examples/dodge-the-creeps/` | One scene, 151 lines | 13/13 steps, 0 console errors |
| `examples/role-playing-game/` | Grid movement, dialogue, turn-based combat, 14 scripts | 45/45 steps across 3 scenarios, 0 console errors |

The **sim tier** has since been proven on two more, deliberately opposite in shape:

| Game | Shape | What it proved |
| :--- | :--- | :--- |
| `statico/godot-roguelike-example` | Turn-based, procedural, 118 scripts | Seeding (three RNG streams), batch, policies, and the parity check — which found a real cross-tier divergence |
| A production idle game | Tick-based idle game | The tier is not turn-based-only: "advance time" is just another action, no runner change. Also produced `--verify-isolation` and `sim_metrics` |

The RPG setup was done end to end by a **Sonnet** agent given nothing but these docs and the two
repos — ~20 tool rounds, no questions asked, no dead ends. If your goal is cheap unattended
playtesting, the setup step (the hardest thing these docs ask of anyone) is within reach of a
mid-tier model.

Both exercises exist to find defects in *this repo*, and they did —
[the list of what they caught](docs/DESIGN_NOTES.md#the-proving-ground--defects-the-third-party-setups-found-in-this-repo).

A **demo-shape validation sweep** then drove four more official Godot 4.7 demos, chosen for shapes
nothing above had exercised yet, each against a live Godot 4.7.1:

| Example | Shape | What it proved |
| :--- | :--- | :--- |
| `examples/platformer-3d/` | UI-less 3D (`CharacterBody3D`, no Control nodes) | First live `press_action`/`send_key`; also where the generic floor stops — not a scored playtest, see its README |
| `examples/gd-paint/` | `content_scale_mode = "viewport"` | The click-transform risk spot: letterbox offset composed correctly through `get_final_transform()` |
| `examples/control-gallery/` | Dense GUI, 66 controls | First live `set_slider`/`select_tab`; found a real bug — `send_key` set `keycode` but never `unicode`, so typed input silently landed nowhere (fixed in `917f2d8`) |
| `examples/2-5d/` | `godot-playtest init` against a real pre-enabled plugin | Byte-exact single-line merge into `project.godot`'s `enabled` array; idempotent under `--force` |

Each example's README states the actual run numbers, cites the manifest that backs them, and
explains how to reproduce it against the demos repo. Sweep summary and follow-ups:
[ROADMAP.md § "Demo-shape validation sweep"](ROADMAP.md).

## Calibrating the roles that use it

[`CALIBRATION.md`](CALIBRATION.md) records planted-bug runs against a third-party game: known
defects, blind agents, scored against ground truth. It answers the question a role roster cannot
answer about itself — when a role reports nothing, is the build clean or is the role blind? The
two results that justify the click are in the
[design notes](docs/DESIGN_NOTES.md#calibration--what-a-role-roster-cannot-know-about-itself).

## Testing the harness itself

```bash
npm test
```

No browser or Godot needed. The suite guards, above all, the three silent failures in the
validator — each shipped, passed, and produced a false conclusion in a real playtest, so if any
stops being a hard error, every result the harness produces afterwards is worthless. **Run this
before changing `run_scenario.mjs`, and again after.**
([How the suite earned its place on its first run → design notes](docs/DESIGN_NOTES.md#the-test-suite-earned-its-place-on-its-first-run).)

## For an agent setting this up on a new game

`godot-playtest init` covers the deterministic part. For everything else — or a game that needs a
hand-written bridge — **read `skills/SETUP_SKILL.md`**: a complete runbook, written to be followed
without asking the user anything that can be determined by reading the repo or running a command.
`godot/DebugBridge.template.gd` is the starting point for the game side.

Then hand the running game to one of the two testing protocols. They are different jobs and must not
be run by the same agent in the same session:

| Skill | Job | Sees |
| :--- | :--- | :--- |
| `skills/PLAYTEST_SKILL.md` | Mechanics against the spec | Design docs, state snapshots as ground truth |
| `skills/CRITIQUE_SKILL.md` | A stranger's experience | Screenshots only — **no docs**, and that blindness is the point |

## Learn more

| Doc | Read it when |
| :--- | :--- |
| [`docs/FIT.md`](docs/FIT.md) | Deciding whether this fits your game at all |
| [`CHOOSING_YOUR_TOOLING.md`](CHOOSING_YOUR_TOOLING.md) | Choosing between this, godot-mcp, or both |
| [`BRIDGE_CONTRACT.md`](BRIDGE_CONTRACT.md) | Writing the game side — the bridge, both transports, the security gates |
| [`addons/playtest_bridge/README.md`](addons/playtest_bridge/README.md) | Installing the generic addon — drivability with zero game code |
| [`ACTION_CATALOG.md`](ACTION_CATALOG.md) | Writing or generating `playtest.actions.json` |
| [`SIM_TIER.md`](SIM_TIER.md) | Adopting the sim tier — the adapter, batches, parity |
| [`docs/MCP.md`](docs/MCP.md) | Driving the harness from any MCP client, unprimed |
| [`docs/DESIGN_NOTES.md`](docs/DESIGN_NOTES.md) | Wondering why any rule here is so insistent |
| [`CALIBRATION.md`](CALIBRATION.md) | Trusting (or not) what the testing roles report |
| [`PRIOR_ART.md`](PRIOR_ART.md) | Checking what else exists and what was rejected |
| [`ROADMAP.md`](ROADMAP.md) | Seeing where this is headed and what's out of scope |

## Status

Where this is headed — and what is deliberately out of scope — is tracked in
[`ROADMAP.md`](ROADMAP.md).

**Working:**

| Tool | Tier | Purpose |
| :--- | :--- | :--- |
| `src/run_scenario.mjs` | browser | Scenario runner and validator. Verified game-agnostic against 274 real scenarios. Built-in generic actions for the addon; opt-in evidence recording (video, trace, perf) that leaves the bundle byte-identical when off |
| `src/play_run.mjs` | browser | Turn-by-turn play from `legal_moves`, plus `--parity` against the sim tier |
| `src/batch.mjs` | sim | N seeded runs, aggregate report, `--verify-determinism`, `--verify-isolation`, declared `sim_metrics` (quartiles, array elements, categorical share tables), `--game-arg=` passthrough in every mode, policy ratios, `--matrix` (policy × variant cells, per-cell targets/verdicts/determinism, disjoint seed windows) |
| `godot/sim_runner.template.gd` | sim | Headless driver — no browser, no screenshots |
| `src/coverage.mjs` | — | What a pass of bundles never touched — unexercised catalog actions and game-declared facets, per bundle and per pass. Tells "no findings" apart from "never looked" |
| `src/diff_run.mjs` | — | `diff` — semantic diff between two bundles' captured states (or session snapshots): added/removed/changed/type-changed, paths pasteable into `assert_state`; exit codes follow `diff(1)` so CI can assert no drift |
| `src/prune_run.mjs` | — | Evidence retention — cited screenshots (and `video.webm`/`trace.zip`) kept, the rest deleted with a tombstone |
| `src/sweep_runs.mjs` | — | Age and budget sweep over `runs/` |
| `src/export_build.mjs` | — | Auto-export — drives `godot --headless --export-debug` so "have a web export" isn't a manual prerequisite |
| `src/init.mjs` | — | The `init` scaffold — addon copied in and enabled (a surgical `project.godot` edit), config, generic catalog, Web preset with `thread_support` off, `runs/` gitignored, starter smoke scenario |
| `bin/godot-playtest.mjs` | — | The `npx` entry point — one subcommand per tool above, same flags, both shells |
| `src/mcp_server.mjs` | — | The harness verbs as an MCP server over stdio — an MCP client drives the same scripts through `tools/call`, no SDK, no new dependency (see `docs/MCP.md`) |
| `src/transport/` | — | The runner's transport seam — `browser.mjs` (the original Playwright path, unchanged) and `desktop.mjs` (a `--headless` desktop debug build over local TCP) |
| `godot/DebugBridge.template.gd` | — | The game side, ready to copy in |
| `godot/tcp_bridge.template.gd` | — | The desktop game side — same fn/var names over TCP, gated by debug build + `--playtest-bridge` + loopback bind |
| `addons/playtest_bridge/` | — | The generic bridge addon — baseline drivability with zero game code; a hand-written bridge coexists and wins on overlap |
| `skills/` | — | Setup runbook plus the two testing protocols |

**Known gaps**, stated plainly because they decide whether this fits your game:

- **The sim tier needs a fixed-step tick entry point**, though it does *not* need turns — that gap
  is now closed, validated against a real idle game (see below). What it cannot drive is a game
  whose logic sits inline in `_process` bodies using the frame's own delta: that advances by
  wall-clock time, so two runs of one seed differ by machine speed. Check for it before promising
  a game this tier.
- **The adapter is hand-written per game.** No scaffold generates it. It is the main cost of
  onboarding a new title, and it is where all the game knowledge lives.
- **One open cross-tier divergence**, documented in `SIM_TIER.md`. Not reproduced on any other game.

Two former entries on this list are closed: `batch.mjs` and `play_run.mjs` now have unit tests
(arg parsing, seed windowing, aggregate math, config precedence, the outcome and parity verdicts —
and both are import-safe, so loading them runs nothing), and `prune_run.mjs` recognises `play_run`
bundles: retention works on them under the same report-first rule, and the bundle's `manifest.json`
is rewritten so kept turn records point at `evidence/` and pruned ones say `screenshot_pruned`
instead of dangling.

`batch.mjs --matrix <config.json>` sweeps policy × variant (a variant is a labelled set of
game-side flags — a difficulty profile, an act cap) in one invocation: each cell takes its own
disjoint `runs`-wide seed slice (stated per cell and as a full span, ledger-ready), is judged
against declared target bands (`"targets": {"optimiser/base": {"win_rate_pct": [10, 70]}}`,
`"*"` as family fallback — a target naming a metric the summary stopped reporting FAILS rather
than passing vacuously), and optionally re-runs for per-cell determinism. One consolidated JSON
report; exit 0 only if every cell passes. Validated against a real game: 2 cells, per-cell
determinism OK, verdicts against real bands.

Metric aggregation carries per-stratum certification rows, not only whole-run scalars — the gap
that made a real per-tier certification bypass matrix mode entirely. A
declared numeric path reports mean/median/**p25/p75**/min/max plus `n` and `present_pct`; a dotted
numeric segment addresses one array element (`run.air_at_boss_by_act.2` is the act-3 entry), and
runs whose array is too short drop out of that element's sample — so `present_pct` **is** the
"share of runs that reached boss 3" and the stats are conditioned on reaching it. A string or
boolean path aggregates to a share table over the present runs (`run.death_key` →
`shares: {"s2-boss": 62.5, ...}`), which is how "share of losses landing on the boss" becomes a
target. Target expressions address all of it — `"metrics.run.air_at_boss_by_act.2.p75": [40, 60]`
— resolved longest-declared-path-first, because metrics are stored under their full dotted path as
one key; a share the table does not list compares as 0 (measured absence), while a metric the
summary stopped reporting still FAILS as missing. `--game-arg=--tier=hard` (repeatable, `=`-form
so the value may itself be a flag) rides along in plain, `--compare`, both `--verify-*` modes, and
prepends to every matrix cell's variant args — the CLI flag is the hold-this-fixed axis, the
variant the varied one.

`screenshot_tabs.mjs`, `live_hover_check.mjs` and `firstrun_screenshots.mjs` are **deliberately not
extracted** — each is written around one game's specific tabs and hover targets, and belongs in the
game repo rather than here.
