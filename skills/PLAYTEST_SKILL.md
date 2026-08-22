# Playtest Skill — mechanics against the spec

> **Are you sure this is your doc?** There are two protocols here and they are not interchangeable.
> **This one** validates mechanics against spec: state snapshots are ground truth, screenshots are
> spot-checks, and reading the design docs is *encouraged* because "matches the spec" is the standard.
> **`CRITIQUE_SKILL.md`** does the opposite job — a docs-blind, screenshot-primary design critique
> asking what a stranger's experience is.
>
> It exists because a run of *this* protocol structurally cannot surface "I don't know what I'm
> looking at": on the origin project every mechanics playtest passed clean on a build where one
> hands-on session found seven significant experience problems in a single sitting.
>
> If your goal is worded in terms of feel, clarity, first impressions, or "is this good" — stop and
> read `CRITIQUE_SKILL.md` instead. Both should run before a build is called ready.

**Read `README.md` first** for the action catalog format, scenario format, and the known gotchas.
This document assumes you have.

---

## Your ground truth

**State snapshots, not screenshots.** If a screenshot appears to disagree with the nearest
`dump_state`, trust the state. Screenshots are for things state cannot show — layout, overlap,
cut-off text, a panel that renders wrong — never for re-deriving a number you can read exactly from
JSON.

`manifest.json`'s top-level `console_errors` array is the exception to every judgement call: any
entry there is a bug by definition.

---

## Workflow

1. **Take a bounded goal.** If you weren't given one, ask for one rather than picking an open-ended
   "explore everything" scope — that is how a trial run becomes an unbounded one.
2. **Read the spec sections that goal touches.** You cannot check a spec you haven't read.
3. **Validate before running, always:** `run_scenario.mjs --validate scenarios/*.json`.
4. **Prefer short scenario-run-inspect cycles over one long script.** A scenario is committed to
   before it runs, so if a step fails partway through, every later step was planned blind to that
   failure. Write 2–4 real decisions, run it, read the manifest, then write the next.
5. **Prefer real actions over `force_*`** when the goal is about the economy or progression.
   `force_*` is for skipping setup that isn't what you're testing — and when you use it, say so
   plainly in your report. That's expected, not a shortcut to hide.
6. **Multi-round trials: set the same `SESSION=<name>` on every round.** Without it each round boots
   a completely fresh game. A real trial once wrote round after round of short scenarios, inspecting
   each result to plan the next — while every round secretly restarted from blank, so all that
   inspection was of state that no longer existed.

---

## What to check, in priority order

1. **Contradictions with the spec.** A number, rule, or ordering that differs from the design docs.
   These are `bug`, and they are the most valuable thing you produce.
2. **The rules that are easy to get subtly wrong.** Anything with ordering (does this expire before
   or after the opponent acts?), anything with a floor or cap, anything consumed on use.
3. **Pacing against the documented targets** — session length, progression rate, difficulty curve.
   **Use the sim tier for these, not scenarios.** Twenty browser runs is slower and less conclusive
   than a thousand headless ones, and a pacing claim from a handful of runs is an anecdote. See
   below.
4. **Console errors.** Not a judgement call.

---

## Balance and pacing questions belong on the sim tier

If your goal is a number — win rate, run length, how hard the boss is, whether an upgrade is worth
taking — do not answer it with scenarios. `SIM_TIER.md` is the guide; the short version:

```bash
node $PLAYTEST_HOME/src/batch.mjs --game . --runs 20 --verify-determinism   # ALWAYS first
node $PLAYTEST_HOME/src/batch.mjs --game . --runs 200 --compare greedy,optimiser
node $PLAYTEST_HOME/src/play_run.mjs --game . --seed 901 --policy optimiser --parity
```

Three rules about the numbers that come back:

- **Run `--verify-determinism` before quoting anything.** One unseeded RNG stream makes every
  aggregate noise, and the failure is invisible — the numbers still look plausible.
- **Agent win rate does not transfer to human difficulty.** Residual HP does (r=0.871, Xiao et al.
  arXiv:2410.02829), and a **ratio between two policies** carries meaning where neither absolute
  number does. "The optimiser beats greedy by 1.8×" is a claim about the game's decisions.
- **Check `rejections_total` and cause-of-death before believing the headline.** Non-zero rejections
  mean the adapter is lying, and a metric that doesn't match how the game actually kills you says
  nothing: one real comparison reported 30/30 losses at *full health* — every death was starvation.

Not every game has this tier; it needs seeded reproducibility. If `batch.mjs` errors, say so and fall
back to scenarios rather than quietly reporting a pacing claim from six runs.

---

## Report format

A flat list, most important first. Per finding:

- **Title** — one line
- **Category** — `bug` · `confusing-ux` · `balance-observation` · `harness-gap` · `positive-note`
- **Evidence** — a step index or state snapshot from the manifest. Always concrete, never asserted
- **Severity** (bugs/UX only) — `critical` (blocks or crashes) · `major` (works but wrong) ·
  `minor` (cosmetic or edge-case)
- **Reproduction** — the seed, if the game is seeded. A finding without one is an opinion

**A causal claim needs a control you actually ran.** "X causes Y" requires a run where X is absent
and Y does not occur — and you must cite that run by path. In a measured calibration a role reported
a confident three-times-reproduced causal finding whose control run had, in its own bundles, failed
at the very assertion it was cited as passing. Re-read the manifest before you cite it; do not quote
a number from memory or from another run.

**A negative result from one attempt is a hypothesis, not a finding.** If something "does nothing",
try it a second and third time, and in a different order, before reporting it. The same calibration
had a role conclude a whole subsystem was unreachable after one attempt; two attempts worked.

**`harness-gap` is a real category and worth reporting** — something *this tooling* couldn't do. It
isn't a game bug, but it's how the harness improves.

**Report `positive-note`s.** A protocol that only ever reports problems gives no signal about what to
preserve, and drifts toward manufacturing findings.

---

## Evidence retention

**Evidence you cite is evidence that survives.** After writing your report, run
`prune_run.mjs <run-dir> --dry-run`, check the plan, then run it for real. Cited screenshots are
promoted to `evidence/` and kept; everything else is deleted and its filename recorded in a manifest.

If a screenshot matters, cite it — that is the only thing that saves it. Don't keep a bundle "just in
case": seeded runs are exactly reproducible, so recapture is cheap.

---

## Finish before you stop

**Never end your turn with a run still going.** If you start a scenario in the background, poll it to
completion and read its output before you write anything. Three of seven agent runs in a measured
calibration stopped here — work fully done, report never written — and one needed three prompts to
deliver a report whose screenshots had been on disk the entire time.

In an unattended loop that reads as "the role ran clean and found nothing", which is worse than a
wrong finding: a wrong finding leaves a trail, this leaves healthy-looking bundles and silence.

**If you genuinely found nothing, say so explicitly.** A report with no findings and no "nothing
found" statement is indistinguishable from a report that was never written.

**Then say what you never looked at.** "Nothing found" is only good news about the surfaces you
actually exercised, and you cannot enumerate what you didn't do from memory. Run the coverage tool
over your own bundles and paste its pass summary into your report:

```bash
node src/coverage.mjs --game DIR <your-bundle-dirs...> --out <run-dir>/coverage.json
```

It reports the catalog actions no bundle of yours attempted and, per game-declared facet
(`coverage_facets` in `playtest.config.json` — content like artifacts, elites, difficulty tiers),
what no run of yours ever met. An unexercised action is not a failure — some are unreachable from
your seeds — but it belongs in the report, because your "no findings" claim stops at that line.

## Boundaries

- **Never modify game code or data.** You test; you don't patch. Found a bug? Report it.
- **Never point anything at the release build.** It has no bridge and never should.
- **Never run an open-ended loop** with no stopping condition. Know in advance what ends your run.
- **Never delete a run bundle by hand.** `prune_run.mjs` and `sweep_runs.mjs` are the only tools that
  remove evidence, and they leave a record behind.
- **If `dump_state`'s `version` isn't what you expect, stop and say so** rather than reading keys
  that may have changed meaning.
