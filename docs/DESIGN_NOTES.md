# Design notes — why the rules exist

Every hard rule in this harness was paid for by a specific failure. This page keeps the receipts.
The [README](../README.md) states each rule; this page records the incident that produced it,
verbatim where the original telling was already right. If a rule ever looks like ceremony, find its
story here before deleting it.

Nothing here is decoration. Several of these incidents produced false verdicts — a non-existent
BLOCKER, a spurious `critical`, a false `major` — and the cost of a false verdict is a full
diagnosis cycle plus every decision made downstream of it.

---

## Validation, and the cost of a silent default

*Referenced from README ["Always validate before running"](../README.md#always-validate-before-running).*

The validator catches unknown actions, missing required args, and — the motivating case — **a
top-level step key shaped like a misplaced argument**.

That last one is not hypothetical. A scenario with `x`/`y` as top-level keys instead of nested under
`args` once ran "14/14 succeeded" while every mouse action silently defaulted to `(0, 0)`, producing
a false BLOCKER verdict that cost a full diagnosis cycle. The same sweep found eleven scenarios with
`{"action": "wait", "args": {"ms": ...}}` — where `ms` is a **top-level** key, so all eleven were
silently sleeping 1000ms instead of what they asked for, and one playtest reported a non-existent
critical bug as a result.

`wait`'s `ms` is a top-level step key. Every other action's parameters go under `args`. The validator
now makes that specific mistake a hard error rather than a silent default.

### Why `wait_for` exists

*Referenced from README ["Wait on a condition, not a duration"](../README.md#wait-on-a-condition-not-a-duration).*

`wait` sleeps a guessed number of milliseconds and hopes the game got there; that is the failure
behind eleven checked-in scenarios silently sleeping 1000ms and one playtest reporting a critical
bug that did not exist. Measured on a real game: `wait_for` returned in 427ms having *confirmed*
the condition, where the equivalent blind `wait` was 600ms and confirmed nothing.

### The test suite earned its place on its first run

*Referenced from README ["Testing the harness itself"](../README.md#testing-the-harness-itself).*

The suite guards the three silent failures in the validator — an unknown action, `args.ms` on a
`wait`, and a top-level key shaped like a misplaced argument. Each of those shipped, passed, and
produced a false conclusion in a real playtest, so if any stops being a hard error, every result
the harness produces afterwards is worthless.

It also flagged, on its first run, that the validator's comment claimed a required arg of `null`
was an error while the code accepted it. Investigating showed the *code* was right —
`{op: "==", value: null}` is how eight real scenarios assert a field was cleared, so treating null
as missing would have refused them outright. The comment was corrected instead.

---

## Manifests — bookkeeping for the run that dies

*Referenced from README ["Scenarios"](../README.md#scenarios).*

**Interactive sessions write a manifest too**, into `runs/interactive_<RUN_TAG>/`, and for a while
they did not. A persona pass on a real game produced 33 screenshots beside a four-line log with **no seed,
no action sequence and no state**, so every finding filed from it was unreproducible — its register
rows read "seed unrecoverable" next to rows from the scenario path carrying a seed and a step index.
The capability was never missing; `control_server.mjs` drove the reset with the seed and simply
never recorded it. An evidence bundle that cannot say what produced it is a pile of pictures.

Two properties of that manifest are deliberate and worth copying:

- **It is rewritten after every mutating call, not at `/quit`.** The session you most want a record
  of is the one that hung, crashed or got killed — and that is exactly the session which never
  reaches its clean shutdown. Bookkeeping that only survives the happy path is bookkeeping for runs
  that did not need it.
- **It carries `complete`.** False until `/quit` sets it, with a note saying the last step is where
  the *capture* stopped rather than where the *run* stopped. A docs-blind reviewer handed a truncated
  bundle has no way to distinguish it from a lost run, and will file the more alarming reading — which
  has already cost one false `major` on the scenario side.

---

## Retention — why the report is the manifest

*Referenced from README ["Evidence retention"](../README.md#evidence-retention).*

Run bundles accumulate fast — the origin project reached **194 MB of committed screenshots** at
1–2 MB a capture. The retention rule (cited screenshots promoted to `evidence/`, everything else
deleted with its filename recorded in `MANIFEST.md`) exists so an agent cannot delete what it cited,
and cannot hoard without writing a finding.

`prune_run.mjs` does not re-encode kept images to WebP (that would need a native image dependency);
it deletes rather than compresses. Deletion is where the saving is anyway — a typical critique bundle
cites four of forty-eight screenshots.

---

## Determinism — a check can pass for the wrong reason

*Referenced from README ["Two tiers"](../README.md#two-tiers).*

The three sim-tier checks (`--verify-determinism`, `--verify-isolation`, `--parity`) test different
properties, and passing one says nothing about the others. Run all three: determinism passed clean
on a game whose six "independent" runs were one continuous run, because both batches leaked
identically. Only the isolation check — last seed batched versus run alone — caught it.

---

## Cross-run state, and the trial that secretly restarted

*Referenced from README ["Cross-run state continuity"](../README.md#cross-run-state-continuity).*

Without a shared `SESSION` name, each round boots a completely fresh game. A real multi-round trial
once wrote round after round of short scenarios, inspecting each result to plan the next — while
every round secretly restarted from blank, so all that inspection was of state that no longer
existed.

---

## The proving ground — defects the third-party setups found in this repo

*Referenced from README ["Proven against third-party games"](../README.md#proven-against-third-party-games).*

Both worked-example exercises exist to find defects in *this repo*, and they did. Fixed so far:
runner actions were wrongly a per-game declaration (a fresh game silently lost `assert_state` and
every mouse action); the documented release-purity check false-positived on every game; the
recommended bridge-`exclude_filter` produced a **broken release build** with six console errors per
boot; no way to use a pre-installed browser; and several omissions a real setup hits immediately
(no `[autoload]` section, no `export_presets.cfg`, `thread_support` hanging the boot silently).

---

## Calibration — what a role roster cannot know about itself

*Referenced from README ["Calibrating the roles that use it"](../README.md#calibrating-the-roles-that-use-it).*

[`CALIBRATION.md`](../CALIBRATION.md) records the full planted-bug runs: known defects, blind agents,
scored against ground truth. It answers the question a role roster cannot answer about itself — when
a role reports nothing, is the build clean or is the role blind?

Two results worth the click: the existing regression suite passed **25/25 on the sabotaged build**,
and the docs-blind visual critic **missed the most visually obvious defect while citing the very
screenshot that showed it**. It also documents three ways the calibration method itself was wrong,
including one planted bug masking another.

---

## Why a bridge at all

*Referenced from README ["Why a bridge"](../README.md#why-a-bridge).*

A Godot web export renders entirely into one `<canvas>`. There is no DOM and no accessibility tree,
so Playwright selectors, Cypress, and anything else that finds elements by role or text see
**nothing**. This was confirmed the hard way: blind pixel-coordinate clicking against a tab bar
failed repeatedly before this tooling existed. The bridge — and the generic addon's control-tree
dump, which is the accessibility tree the canvas doesn't have — is the fix.
