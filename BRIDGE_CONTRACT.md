# The Bridge Contract

**Contract version: 1.0**

What a Godot game must implement to be drivable by this harness. Everything here is the *game's*
side; the harness supplies the rest.

## Stability promise

The npm package adopts this promise at its `1.0.0` release; while the package is still `0.x`
(pre-release), the contract below is what `1.0.0` will freeze, and 0.x minors may still adjust it
with a changelog note. From `1.0.0` on, a game integrated against contract 1.0 keeps working
across all harness `1.x` releases:

- **Stable within 1.x** — the fn/var naming scheme (`godotDebug*`), the `dump_state` schema's
  existing fields, the TCP wire protocol (framing, ops, token handshake), the scenario file format,
  `playtest.config.json` keys, and the action-catalog format. New *optional* fields and actions may
  be added in minors; nothing existing changes meaning or disappears.
- **Not covered** — the `.template.gd` files' internals (they are starting points you copy and own,
  not an API; diffs land in minors), CLI output text, and manifest fields not documented in
  README.md. Pin exact versions if you parse any of those.
- A `2.0` is the only release allowed to break the stable list, and it will ship a migration note
  per breaking change.

---

## 1. The security gate — first, and non-negotiable

```gdscript
func _ready() -> void:
	if not OS.is_debug_build():
		return                      # release builds carry NOTHING
	if not OS.has_feature("web"):
		return
	_register_callbacks()
```

- `build/web/` — **release**. What players and testers receive. Never has the bridge.
- `build/web-debug/` — **debug**. Harness only. Never shipped to anyone.

**Any change to this gating deserves the same scrutiny as a real security fix.** Build both exports
in CI or in your gate script and assert the release one doesn't contain the bridge symbol.

## 2. Registering actions

Each action is a `JavaScriptBridge` callback assigned onto `window`:

```gdscript
_place_module_cb = JavaScriptBridge.create_callback(_on_place_module)
window.godotDebugPlaceModule = _place_module_cb
```

**Keep a reference to every callback** (a member variable, not a local). A `JavaScriptObject` that
goes out of scope is freed and the function silently stops working.

## 3. Reporting results — the rule that has already bitten once

**Every action must call `_report_action_result` before returning**, including on failure:

```gdscript
func _on_place_module(args: Array) -> void:
	if args.size() < 3:
		_report_action_result({"action": "place_module", "success": false, "reason": "bad args"})
		return
	var ok := _grid.place(args[0], int(args[1]), int(args[2]))
	_report_action_result({"action": "place_module", "success": ok})
```

`_report_action_result` writes a JSON string to `window.<result_var>`, which the runner reads after
each step.

**This is the contract's sharpest edge.** In the original implementation two early actions were
written before this pattern existed and were never retrofitted — so the runner read the *previous*
step's result for them, and every scenario using those actions silently reported the wrong outcome
while appearing to pass. An agent found it, not a test.

**Add a test asserting every registered action reports its own result.** Do it when you write the
second action, not the twentieth.

## 4. The required functions

| Config key | Default name | Must do |
| :--- | :--- | :--- |
| `state_fn` | `godotDebugDumpState` | Serialise full game state to `window.<state_var>` as JSON |
| `state_var` | `godotDebugLastState` | Where `state_fn` writes |
| `result_var` | `godotDebugLastActionResult` | Where every action writes its result |
| `cell_pos_fn` | `godotDebugGetCellScreenPos` | *Grid games only.* Cell → screen pixels |
| `save_export_fn` | `godotDebugExportSave` | *Optional.* Return the save as a JSON string |
| `save_import_fn` | `godotDebugImportSave` | *Optional.* Load a save from a JSON string |

`save_export_fn` / `save_import_fn` are what make `SESSION` continuity work across separate runner
invocations. A game without them can still be driven; it just can't resume between rounds.

The runner waits for `state_fn` to become a function before running any step — that's how it knows
the export has finished booting.

## 5. `dump_state` — the schema

Return everything a scenario might assert on. Two rules:

**Carry a `version` integer from the very first write.** Not "once it stabilises" — the original
deferred this and needed a retrofit. A scenario reading an unexpected version must be able to stop
rather than silently misread keys that changed meaning.

**Include a human-readable `log` array.** An append-only list of what happened, in words. Reviewing
a failed run by diffing two state snapshots is the slowest part of any investigation; a narrative
makes it immediate.

```jsonc
{
  "version": 3,
  "run": { "state": "IN_PROGRESS", "seed": 12345 },
  "log": ["played pry_bar -> silt_crab for 6", "..."]
}
```

## 6. `legal_moves` — optional, but it unlocks interactive mode

Return the actions that are legal right now, with their args. Without it, a driving agent must
guess and handle rejections; with it, the agent picks from a list and every choice is valid.

This is what turns "write a scenario blind, commit to it, run it" into a real request/response
playtest — the single biggest quality difference in how an agent can use this harness.

### 6.1 It is a SUBSET, and the contract has to say so out loud

**`legal_moves` guarantees one direction only: everything it offers will be accepted. It does not
guarantee that everything acceptable is offered.**

Write that sentence into your game's own docs too, because an agent that has not been told it will
work the guarantee backwards, and the conclusion it reaches is that the game is broken.

That is not hypothetical. A boundary-testing agent on a real turn-based game found `start_run` accepted
from every screen and phase while `legal_moves` never once listed it, and filed a `critical`: from
where it stood, the game was accepting an action it had declared illegal. The bridge was correct. The
agent was reasoning correctly from what it had been given. **The defect was that the one-directional
guarantee was written down nowhere it could find.**

So the failure mode `legal_moves` is designed to catch is **offered-then-refused**. Its mirror —
accepted-but-not-offered — is out of scope by construction, and silence about that is what costs you
a spurious `critical` and an agent-session's budget.

### 6.2 Declare the state-independent actions

Some actions are legal at all times and belong in no move list: `start_run`, `reset`, `quit`, a
screenshot, a state dump. Listing them every turn is noise; omitting them silently is §6.1's trap.

Declare them once, in `playtest.actions.json`. The declaration is read by *agents* (the catalog is
the first file a driving agent is given), not acted on by the runner — it exists so the agent knows
*why* an action is absent from `legal_moves` instead of inferring a bug:

```jsonc
{
  "state_independent": ["start_run", "reset", "screenshot", "dump_state"]
}
```

The test to apply is not "is it currently sensible" but **"can its legality change with state?"** If
it cannot, it is state-independent and does not belong in a move list. If it can, it belongs there
whenever it is legal, with no exceptions — an action that is *sometimes* listed and sometimes not,
for reasons the agent cannot see, is worse than one that is never listed at all.

## 7. `state_hash` — optional, for deterministic games

A stable hash over the state that must be reproducible: seed, position, and every RNG stream's
current offset. With it, you can assert that replaying a recorded action list reaches an identical
state — which is what makes recorded runs into regression tests.

## 8. Desktop transport

Everything above assumes a **web** export driven through `JavaScriptBridge`. A game that doesn't
ship web can implement the same contract over a local TCP socket instead, driven by a `--headless`
**desktop debug build**. The harness side is `src/transport/desktop.mjs`
(`"transport": "desktop"` in `playtest.config.json`); the game side is
`godot/tcp_bridge.template.gd`, this contract's TCP mirror.

**fn/var names are identical across transports.** `"call"` dispatches by the exact name the JS
bridge would register on `window` (`godotDebugDumpState`, ...); `"read"` returns the exact var the
JS bridge would write there (`godotDebugLastState`, `godotDebugLastActionResult`, ...). One action
catalog, one set of scenarios, both transports — nothing per-transport leaks into scenario files.

### The wire protocol

Newline-delimited JSON over TCP on `127.0.0.1:8973` (`config.desktop.port` overrides; the bridge
learns it from a `--playtest-port=<port>` user arg). One JSON object per line, both directions:

```jsonc
// requests (id is caller-chosen, echoed back; responses may arrive out of order)
// `token` is the session token from --playtest-token= — see Security posture
{"id": 1, "token": "a3f1…", "op": "ping"}
{"id": 2, "token": "a3f1…", "op": "call", "fn": "godotDebugDumpState", "args": []}
{"id": 3, "token": "a3f1…", "op": "read", "var": "godotDebugLastState"}

// responses
{"id": 1, "ok": true,  "result": "pong"}
{"id": 2, "ok": true,  "result": null}
{"id": 3, "ok": true,  "result": { "version": 1, "...": "..." }}
{"id": 4, "ok": false, "error": "unknown fn \"godotDebugTypo\""}
{"id": 5, "ok": false, "error": "bad or missing token"}   // …and the peer is disconnected
```

- A `"call"` response's `result` is whatever the action passed to `_report_action_result` —
  the desktop analogue of reading the result var after each step. The reference template clears
  the result var before each dispatch, so an action that forgets to report yields `null` (visibly
  wrong) rather than the previous action's result (silently wrong — §3's incident).
- `"read"` of an unset var is `{"ok": true, "result": null}`, matching an unset window var. It is
  **not** an error.
- `"ok": false` means the **bridge itself** refused (unknown fn/op, malformed request). A game
  action that *refuses* still responds `"ok": true` with `{"success": false, "reason": ...}` as its
  result — the same two-layer distinction the web transport has.
- Readiness is a `ping` answered `{"ok": true}` — a mere TCP accept is not readiness, because
  something else could own the port.
- **A request line has a size cap** (1 MiB of undelimited bytes, both directions). Bytes with no
  newline cannot be dispatched and so are held; held without a bound, one socket and a stream of
  bytes is a memory bomb requiring no protocol knowledge at all. Over the cap: an error, then a
  disconnect.

### Security posture

The socket version of §1's gate, and just as non-negotiable:

```gdscript
func _ready() -> void:
	if not OS.is_debug_build():
		return                      # release builds open NOTHING
	if not OS.get_cmdline_user_args().has("--playtest-bridge"):
		return                      # a casually-run debug build opens NO port
	_server.listen(port, "127.0.0.1")   # localhost ONLY, never 0.0.0.0
```

The feature gate is deliberately **not** `"web"` here — this bridge exists for desktop builds —
but debug-only is not enough either: without the explicit `--playtest-bridge` opt-in (a *user* arg,
after Godot's `--` separator), every developer casually running a debug build would be listening on
a port. Three layers: debug build, explicit flag, loopback bind.

**And a fourth: the session token.** Loopback keeps the LAN out and does nothing about this
machine — and "this machine" now includes any **web page** the developer happens to have open. A
page cannot open a raw socket, but it can `fetch()` `http://127.0.0.1:8973` as a CORS *simple
request*: no preflight, and the browser sends it whether or not the page is permitted to read the
reply. The HTTP body arrives on this socket as a line, and a line that parses as JSON is a request.
Every response would vanish into a void the page cannot read; every side effect would be real.

So the harness generates a random token per run and spawns the game with
`-- --playtest-bridge --playtest-port=<port> --playtest-token=<token>`. Every request must carry a
matching `"token"` field. The bridge checks it **before it looks at `op`**, answers a failure with
one flat `"bad or missing token"` — no length hint, no per-op variation — and then **disconnects
the peer**, so the port cannot be used as a guessing oracle.

Be clear about what this buys, because a security control described optimistically is worse than
none:

- **It does stop** a web page (which cannot read the token) and any local process that cannot see
  the game's command line.
- **It does not stop** anything that *can* see the game's command line. On most systems that is
  every process running as the same user, via `/proc` or the process list. The token is not an
  authentication system; it is the difference between "any code that can reach a port" and "code
  that can already inspect your processes", and it is what closes the web-page hole specifically.
- It is **not** a reason to relax any of the other three layers.

A bridge launched **without** `--playtest-token=` **refuses to listen** — the harness always
passes one, so a missing token means a regression or a forgotten hand-launched build, and the
un-tokened port would be drivable by every local process. Driving the bridge by hand (netcat, a
one-off script) is still possible, but only by stating the intent explicitly with
`--playtest-no-token`; in that mode the check is skipped entirely — an absent token means
*unchecked*, never *accept anything*.

### Why the web tier has no token

The TCP tier got a token; the `JavaScriptBridge` tier deliberately did not, and the asymmetry is
reasoned, not overlooked:

- The web bridge's only callers are JavaScript running **on the game's own page**. There is no
  cross-origin path in: another tab or site cannot reach `window.godotDebugDumpState` on this page
  (same-origin policy), and unlike a socket there is nothing for a CORS simple request to hit.
- The page's JS **is** the harness — Playwright drives the page that the harness itself served from
  loopback. A token would be handed to that page by the same server an attacker would already have
  to control, so it authenticates nothing; it would be ceremony, not a layer.
- The residual risk is therefore **hosting**: put a debug build on any URL a stranger can reach (an
  itch draft page, a staging box, a tunnel) and every visitor's own browser can drive the bridge
  and read the state dump. No token design fixes that — the visitor's page would legitimately hold
  it. The control is operational and absolute: **debug builds never leave the machine** (§1), and
  the generic dump additionally redacts credential-shaped property names by default
  (`PLAYTEST_BRIDGE_UNREDACTED` to opt out per autoload, `PLAYTEST_BRIDGE_HIDDEN` to hide one
  entirely).

If a future transport ever exposes the web bridge beyond the page itself (a WebSocket relay, a
remote-debugging hop), that transport must bring the token analysis above with it.

### What the desktop transport cannot do

No canvas, no pointer, no pixels. `screenshot` steps are recorded as
`screenshot_skipped: "desktop transport"` in the manifest (skipped, not failed — the tombstone
tells a later reader "never capturable" apart from "captured and pruned"), and the runner's real
mouse actions (`mouse_move`, `mouse_click_cell`, ...) fail loudly rather than pretending. Drive a
desktop game through bridge actions; that is the entire point of the bridge.

## 9. Player affordance parity

**A bridge action is not a substitute for the player-facing control it stands in for.**

On the original project two features shipped fully implemented, fully tested through the bridge, and
completely unreachable by a player, because nobody wrote down which screen they lived on. Twice.

Keep a map from each player-facing action to the UI element that performs it, and test that the
element exists. An action with no affordance is a finding, not a feature.

### 9.1 Iterate the SPEC, not the implementation

**A parity test inherits its coverage from whichever side it walks. Walk the implemented side and it
is structurally blind to the one thing it exists to catch.**

The obvious test is a loop over the declared actions asserting each has a control. That closes
*action exists, control missing*. It cannot close *control specified, never built* — because a
control nobody implemented has no action, no map entry, and no loop iteration. It is absent from the
collection being checked, so the check passes by having nothing to say.

On one real game the UI spec had called for two buttons on the run-end screen since it was
written. One was ever built. **Seven review roles across five milestones missed it, and so did every
gate run**, because the parity test iterated the implemented side. It was found by an agent whose
whole method was revisiting screens and asking whether they said the same thing twice — and finding
it invalidated a `closed` verdict on the single gap that project existed to close.

So run it in both directions, and the second direction has to start from a machine-readable spec:

- **implementation → spec**: every declared action has a control. Catches dead actions.
- **spec → implementation**: every control the spec names exists. Catches omissions.

If the spec is prose, the second direction cannot be automated and you should say so plainly in the
verdict rather than reporting the gap as closed. **"Closed in one direction" is an honest result.
"Closed" is not**, and the difference is invisible in a green gate.

## 10. The generic bridge — a baseline you don't have to write

`addons/playtest_bridge/` satisfies a baseline version of this contract with **zero game code**:
enable the plugin, export a debug web build, and the game is drivable. It provides:

- `godotDebugDumpControls` — every visible `Control` with name, path, class, text, rect, disabled
  and focused state, written to `window.godotDebugLastControls`. The accessibility tree the canvas
  lacks, and what "click the button labeled Start" resolves against. Live-state fields are added
  truthfully, only where they apply (same rule as `text`): `value`/`min_value`/`max_value` on a
  `Range` (sliders, spinboxes, scrollbars, progress bars); `button_pressed` on a `BaseButton` with
  `toggle_mode` on (plain push buttons are unchanged); `selected` and `selected_text` on an
  `OptionButton`; `tab` on a `TabContainer` or `TabBar`. These are additive to the `version: 1`
  schema — no existing key changed shape or meaning, so the version did not bump; a scenario
  written against the old dump keeps working unmodified.
- `godotDebugClickControl` / `godotDebugPressAction` / `godotDebugSendKey` — synthesized
  `InputEvent`s through `Input.parse_input_event()`, so a click proves the control is *hittable*,
  not merely that a method works.
- `godotDebugSetSlider` / `godotDebugSelectTab` — direct property sets, because ranges and tabs
  have no single equivalent input event; each reports the value that actually took effect.
- A fallback `godotDebugDumpState` — current scene plus every autoload's exported properties,
  tagged `"generic_bridge": true` so a scenario can tell which bridge answered.

It obeys §1 (same gate, registers nothing outside a debug web build), §2 (every callback in a
member variable) and §3 (every action reports, including failures) — and
`test/addon_contract.test.mjs` statically asserts all three on every `npm test`.

The runner carries matching **built-in scenario actions** — `dump_controls`, `click_control`,
`press_action`, `send_key`, `set_slider`, `select_tab` — so a scenario can drive the generic
bridge with no catalog entries at all. See `ACTION_CATALOG.md` "Built-in generic actions" for the
arg shapes and the precedence rule (a game's own catalog wins on a name collision).

**What it cannot know:** anything that is knowledge about the *game* rather than about Godot.
Semantic actions, a real state schema with `version`/`log`/`seed`, `legal_moves`, `state_hash`,
save export/import, and everything the sim tier requires stay hand-written. The generic bridge is
the floor, not the ceiling.

**The coexistence rule:** the two run side by side and the hand-written bridge **wins**. Generic
action names collide with nothing, so they always add; the fallback `dump_state` checks
`typeof window.godotDebugDumpState` (deferred, after every autoload's `_ready`) and stands down if
any hand-written bridge already claimed it, regardless of autoload order. Adopting the addon first
and writing the real bridge later is the intended path, and nothing breaks at the handover.
