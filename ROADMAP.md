# Roadmap — from a proven harness to a universally helpful Godot playtest tool

Where this is going and in what order, with the reasoning attached. Status lives in the
checkboxes; when an item ships, link the commit or doc that closed it rather than deleting
the row — a roadmap that forgets what it promised can't be audited against what it delivered.

> Commit hashes cited below (`ca25c97`, `93af020`, ...) refer to the private pre-release
> repository. Its history was squashed to a single root for the public release, so they no
> longer resolve here; the rows keep them as a record of the order things landed in.

**The organizing diagnosis:** the runner, the two tiers, retention, and calibration are in
good shape — proven on four games of deliberately different shapes. What stands between
"a tool for this project and agents primed with its skills" and "a tool a stranger adopts"
is almost entirely **onboarding cost, distribution, and audience**, not runner capability.
The hand-written adapter is the wall ([README — Known gaps](README.md#status)): a developer
evaluating this hits it before seeing any value. Every Tier 1 item exists to lower that wall.

> **2026-08-22:** Tiers 1 and 2 were built out in two waves of parallel worktree agents
> (`ca25c97`..`ff01961`), each branch reviewed and merged by a dedicated merge pass, suite
> at 177 tests. The two open sub-items below are the external acts — the npm publish and
> the Asset Library submission — which need account credentials, not code.

---

## Tier 1 — removes the adoption wall

The coherent v0.2: the set that changes the answer to *"can a stranger get value in 15
minutes?"* from no to yes.

### 1. Generic bridge — zero game code to first drive

- [x] **Control-tree dump.** `godotDebugDumpControls`: every visible `Control` — name, path,
  class, text, rect, disabled, focused. The accessibility tree the canvas lacks. Shipped
  `93af020`; runner-side `dump_controls` built-in in `c063fc0`.
- [x] **Generic actions derived from it.** `click_control`, `press_action`, `send_key`,
  `set_slider`, `select_tab` — shipped `93af020` (addon) + `c063fc0` (scenario verbs, with
  validator integration; a game's catalog wins a name collision, `21194f8`).
- [x] **Generic fallback state.** Deferred registration; a hand-written `godotDebugDumpState`
  wins regardless of autoload order. Shipped `93af020`.
- [x] **Shipped as a Godot addon** — `addons/playtest_bridge/`, installed and enabled by
  `init`; contract invariants held by static tests (`dfcc7b5`). The Asset Library
  *submission* is still to do — an external account action, tracked under item 4's publish.

The hand-written catalog did not go away — it is the *upgrade path*, for semantic actions
(`repair_system`) and for the sim tier, and it shadows the generic verbs on name collision.

### 2. Real input injection

- [x] Generic actions synthesize `InputEvent`s via `Input.parse_input_event()` rather than
  calling methods directly (`93af020`; `set_slider`/`select_tab` are documented
  property-set exceptions — ranges and tabs have no single input event).

### 3. `init` scaffold

- [x] `godot-playtest init` (`9c06bef`): detects the Godot project and version, installs and
  enables the addon with byte-surgical `project.godot` edits, writes
  `playtest.config.json` + starter catalog (fn names cross-checked against the addon
  source by test), audits or writes the Web debug preset with `thread_support` off,
  gitignores `runs/`, and generates a `scenarios/smoke.json` that passes `--validate`
  with zero warnings. `--dry-run` / `--force`; refusal-by-default on existing files.
  [skills/SETUP_SKILL.md](skills/SETUP_SKILL.md) now covers only the judgment calls.

### 4. Distribution, licensing, Windows

- [x] **LICENSE file.** MIT (`ca25c97`).
- [x] **Publish to npm.** Live 2026-08-22 as
  [`godot-playtest-harness@0.1.0`](https://www.npmjs.com/package/godot-playtest-harness) —
  `0.x` deliberately: the BRIDGE_CONTRACT stability promise activates at `1.0.0`, once
  external adopters have shaken the surface. `prepublishOnly` gates every publish on the
  full suite; playwright is pinned exactly. The Asset Library submission remains open.
- [x] **Windows-safe docs.** Install/usage commands run in PowerShell and POSIX; env-var
  examples shown in both shells (`ca25c97`, carried through the restructure `29806c3`).
- [x] **Auto-export.** `godot-playtest export` → `src/export_build.mjs`: `GODOT_BIN`/PATH
  discovery, `--dry-run`, loud missing-binary guidance (`ca25c97`).

---

## Tier 2 — widens who it serves

The v0.3: changes *"who is this for"* from web-shipping agent users to Godot developers
generally.

### 5. Desktop-build transport

- [x] Pluggable transport (`5af45df`): `src/transport/browser.mjs` (the Playwright path,
  extracted faithfully) and `src/transport/desktop.mjs` (spawns the `--headless` debug
  build, NDJSON over loopback TCP), selected by `config.transport`. Game side:
  [godot/tcp_bridge.template.gd](godot/tcp_bridge.template.gd), gated on debug build +
  explicit `--playtest-bridge` user arg + 127.0.0.1 bind. Wire protocol and security
  posture in [BRIDGE_CONTRACT.md](BRIDGE_CONTRACT.md) §8; one catalog serves both
  transports.

### 6. MCP server wrapper

- [x] `src/mcp_server.mjs` (`3283325`): hand-rolled stdio JSON-RPC — no SDK, no new
  dependency — exposing validate/run/play/batch/coverage/prune/sweep with per-call
  timeouts. Registration and the v1 session-tools exclusion in [docs/MCP.md](docs/MCP.md).
  Persistent interactive sessions (wrapping `control_server.mjs`) are the known v2.

### 7. Richer evidence per run

- [x] Opt-in Playwright video and tracing, always-on `pageerror` capture (tagged
  `source: "pageerror"` — the wave's only unconditional manifest change), all behind
  `evidence.*` config / `PLAYTEST_EVIDENCE_*` env; browser-path manifests otherwise
  unchanged (`c063fc0`).
- [x] Load-time (`bridge_ready_ms`), JS-heap and rAF FPS sampling under `evidence.perf`;
  `video.webm`/`trace.zip` are retention subjects under `prune_run`'s report-first rule
  (`c063fc0`).

### 8. Docs restructure

- [x] Quickstart-first README: install → init → export → first green run, one screen, both
  shells (`29806c3`, reconciled against shipped reality in `ff01961`).
- [x] "Does this fit my game?" decision page: [docs/FIT.md](docs/FIT.md).
- [x] War stories moved to [docs/DESIGN_NOTES.md](docs/DESIGN_NOTES.md) — verbatim, themed,
  linked both directions. Kept: they are the trust signal.

---

## Tier 3 — the mature product

- [ ] **HTML report viewer** for run bundles and matrix reports — screenshots, per-step state
  diffs, target-band verdicts. Makes findings shareable with a non-agent human: the actual
  game developer.
- [ ] **CI templates.** A GitHub Action: export, serve, validate, run the scenario suite,
  upload the pruned bundle as an artifact.
- [ ] **Record mode.** Play in a HEADED browser while the bridge logs actions; replay as a
  scenario. Turns manual QA into committed regressions — the friendliest scenario-authoring
  path there is.
- [ ] **Sim-tier conformance checker.** A full adapter generator is impossible — seeded
  reproducibility is a property of the game — but "here's why your game can't be simmed:
  `_process` uses frame delta at these 3 sites" converts the current doc-warning into a
  diagnostic.
- [x] **Godot 3.x: decided and documented** — not supported, 4.x only, stated with the
  reasoning in [docs/FIT.md](docs/FIT.md).

---

## Demo-shape validation sweep — 2026-08-22

Four official Godot 4.7 demos, chosen for shapes nothing had exercised, each driven by an
agent with a live Godot 4.7.1. Results: **four passes, one real bug** (`917f2d8`:
`send_key` set `keycode` but never `unicode`, so it silently typed nothing into focused
text controls while reporting success — found on control_gallery's LineEdit, fixed with
ASCII derivation plus an explicit `unicode` arg).

| Demo | Shape proven | Notable |
| :--- | :--- | :--- |
| `3d/platformer` | UI-less 3D — first live `press_action`/`send_key` | Empty controls dump is *correct* there; gap analysis below |
| `gui/gd_paint` | `viewport` stretch — the click-transform risk spot | Letterbox offset composed correctly by `get_final_transform()` |
| `gui/control_gallery` | Dense GUI — first live `set_slider`/`select_tab`, 66-control dump | Found the `send_key` bug; hidden-tab click fails loudly (no click-through) |
| `misc/2.5d` | `init` vs. a real pre-enabled plugin | Byte-exact single-line merge; idempotent under `--force` |

Follow-ups the sweep earned:

- [x] **Promote the four demos to `examples/`** — done: `examples/platformer-3d/`,
  `examples/gd-paint/`, `examples/control-gallery/`, `examples/2-5d/`; 3d/platformer's README
  leads with "where the generic floor stops", not a scored playtest.
- [x] **Controls dump lacks live values** — closed additively (`1109349`): `value`/
  `min_value`/`max_value` on Ranges, `button_pressed` on toggles, `selected`/
  `selected_text` on OptionButtons, `tab` on tab containers; live-verified on
  control_gallery (slider 50→77, tab 0→2, checkbox false→true visible in the dump).
- [x] **Combined scale+offset stretch untested** — closed: `PLAYTEST_VIEWPORT=WxH` /
  config `viewport` override the browser window (recorded in the manifest); gd_paint at
  2400×1400 forced `integer` stretch to 2×+(48,52) letterbox, and every click landed at
  exactly canvas×2+offset with observable effect, 13/13.
- [x] **Document the UI-less assertability gap in docs/FIT.md** — on a game whose state
  lives on scene nodes (not autoload exports), the generic floor gives input synthesis,
  console errors, and qualitative screenshots; `assert_state`/`wait_for` on gameplay
  values and the sim tier require a hand-written bridge.

---

## Explicitly out of scope

Stated here so they don't have to be re-litigated per request:

- **Visual-diff / screenshot-comparison testing.** Flaky across GPUs; a different product.
- **Release-build testing.** The security gate ([BRIDGE_CONTRACT.md §1](BRIDGE_CONTRACT.md))
  is a feature, not a gap. The harness never points at what players receive.
- **Replacing godot-mcp's editor loop.** The both-tools stance in
  [CHOOSING_YOUR_TOOLING.md](CHOOSING_YOUR_TOOLING.md) is correct — complement, don't
  compete.

## Housekeeping

- [x] Remove or formalise the untracked root scratch (`act.mjs`, `persistent_server.mjs`,
  `persistent_server2.mjs`) — deleted in the pre-publish cleanup; their demand signal —
  persistent per-action sessions — is recorded as the MCP wrapper's v2 in
  [docs/MCP.md](docs/MCP.md). The one-time `tools/port*.py` extraction scripts went with
  them (git history keeps both).
