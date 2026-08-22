# Planted-bug calibration — first run, and what it proved

The question no role roster can answer about itself: **when a role reports nothing, is the build
clean or is the role blind?** Plant known defects in a throwaway game, run the roles blind, score
against ground truth.

Subject: Godot's official `role_playing_game` demo. Three Sonnet agents, none told that any defect
existed. Ground truth held outside the game repo.

---

## Result 1 — before any agent ran

The existing regression suite (3 scenarios, 45 asserted steps, written by a competent agent against
this exact game two hours earlier) passed **25/25 on the sabotaged build**. Zero sensitivity to all
five defects.

A green suite proved nothing, and nobody would have known.

## Result 2 — the scoring

| Defect | Applied? | Reachable? | mechanics QA | exploration persona | docs-blind Critic |
| :--- | :-: | :-: | :-: | :-: | :-: |
| **B1** armour silently ignored in damage | yes | yes | **HIT** (major, exact line) | miss — out of remit | n/a |
| **B2** dialogue panel shrunk, text spills outside it | yes | yes | n/a | n/a | **MISS** |
| **B3** Defend button enabled but dead | yes | yes | **HIT** (critical, root cause) | **HIT** (symptom) | miss |
| **B4** `heal()` stops emitting `health_changed` | **no** | — | void | void | void |
| **B5** win dialogue suppressed after any Defend | yes | **no** | **HIT** via source read | unreachable | unreachable |

**The Critic's miss is the sharpest result.** B2 is the single most visually obvious defect in the
build — text sitting on the grass, outside its box — and the Critic *cited that very screenshot* as
evidence for a different finding. A role whose entire remit is visual looked straight at it.

**mechanics QA was the strongest role by a distance.** Three for three in remit, and on B5 it did
something better than finding it: it identified the defect as *currently unreachable* and predicted
that fixing B3 alone would introduce a worse regression, because the first Defend press would then
silently disable win/loss resolution for the rest of the fight. It also self-corrected on one of its
own failed assertions — "this was my incorrect assumption about timing, not a game bug."

**The exploration persona earned the base-layer argument.** It found B3 by repeating an action and
diffing against a no-defend baseline — behaviour no motivation-defined persona in the roster has.

## Result 3 — six real bugs nobody planted

Found in an official, reviewed, shipped Godot demo:

- `clamp(life, life, max_life)` uses `life` as the minimum, so `max_life` is never enforced (QA;
  verified against upstream)
- Fleeing shows "maybe you can try again next time", but the encounter is gone permanently (persona)
- `legal_moves` returns all four directions always — pinned against a wall, or teleported off-map
  (persona). A defect in the game's bridge, and a **gap in `BRIDGE_CONTRACT.md`**, which sells
  `legal_moves` as unlocking interactive mode without ever saying it must reflect real legality
- Placeholder speaker name `UNKNOWN` leaks into the first dialogue line (Critic)
- Defeated opponents are unmarked and refightable verbatim (Critic)
- Combat has no numeric HP and no enemy-turn feedback; your bar drops with nothing on screen
  explaining it (Critic)

**Unresolved contradiction between two roles:** the persona reports the opponent is permanently gone
after fleeing; the Critic reports it is refightable after winning. Both may be true if the two
endings differ. Not adjudicated — recorded rather than smoothed over.

---

## Result 4 — the Critic fix, as a controlled A/B

The Critic was rewritten with **Rule 0: describe before you interpret** — a mandatory literal
inventory of every on-screen element plus an explicit layout checklist, answered before any
experience judgement. Findings also gained a `kind` (`present-and-wrong` vs `absent`) with a note
that an all-`absent` report is a wishlist rather than a critique.

Re-run as a clean A/B: **identical build, identical defects, prior agents' artefacts stripped, only
the prompt changed.**

| | Old prompt | Fixed prompt |
| :--- | :--- | :--- |
| B2 (text outside its panel) | **missed** — cited the screenshot for a different finding | **finding #1**, `visual-defect` / `present-and-wrong` / major, six screenshots cited |
| Finding kinds | 5 of 6 `absent` | 2 `present-and-wrong`, 4 `absent` |
| Layout checklist | n/a | answered explicitly, including honest "no"s for cut-off and unreadable text |
| False positives on layout | n/a | none observed |
| Stage-2 returning-player pass | skipped | performed |

It also **diagnosed the defect more precisely than the ground truth did**. My note said "panel shrunk,
text clips". The Critic wrote: *"the container is built and rendered, the text is just never routed
into it"* — it spotted that the pale pill panel is present but permanently empty, which is a better
description of what a developer would actually see.

**The conclusion is narrow and worth keeping narrow.** This is n=1 against a defect known to be
present. It shows the fix works on *this* failure mode. It does not establish that the Critic is now
reliable in general — that needs defects it has not been calibrated against.

## What the method got wrong

Three of five plants were defective, which made the experiment less rigorous than the roles it was
testing:

1. **B4 was never applied.** The edit inserted a comment and left the emit in place. Not verified.
2. **B5 was unreachable** — B3 blocked the code path that armed it. **One planted bug masked
   another.** Scored naively, B5 reads as "missed by every role" when it was never testable.
3. **B4 was also dead code** independently: `heal()` has no call sites in this demo.

### The corrected protocol

1. **Prove the plant applied.** Diff against the clean copy and confirm the change is present.
2. **Prove it manifests.** Exercise the path and observe the wrong behaviour *before* any role runs.
   A plant you cannot demonstrate is not ground truth.
3. **Prove independence.** Check no defect blocks the code path of another. Plant in separate
   subsystems by default.
4. **Keep a clean control build** and diff screenshots between them — that is what would have caught
   B2's visibility, and B4's absence, in seconds.
5. **Score noise as well as sensitivity.** A role reporting ten things and hitting one is expensive,
   not sensitive. All three roles here were low-noise; none padded.

## What to do with the roles

- **mechanics QA**: keep as-is. Best sensitivity, honest about its own errors and its gaps.
- **exploration persona**: promote into the game-agnostic base layer. It found a defect by a method
  no other role uses.
- **Critic**: **fixed and re-verified** — see Result 4. The candidate fix (describe-before-interpret,
  plus a present-and-wrong vs absent split) was applied and the A/B confirms it catches the defect it
  previously walked past. Keep, but re-calibrate against defects it has not seen; one controlled pass
  is evidence the fix works, not evidence the role is reliable.

## Compliance gaps worth hardening

Two of the three agents left every run bundle on disk without running `prune_run.mjs`, and one lost
scenario files while keeping their run bundles. The retention step is documented but easy to skip —
it should be part of the report template, not a closing instruction.

One agent also **backgrounded its own scenario run and ended its turn before reading the output**.
In an unattended loop that reads as a completed pass that examined nothing — the same false-pass
shape the validator now guards against, one level up.

---

# Round 2 — corrected protocol, four verified plants

Every plant proven **applied** (diff), proven to **manifest** (observed against a clean control), and
checked for **independence**. Three earlier plant attempts were discarded *during verification* —
two `.tscn` offset patches that containers silently overrode, and one confounded by another plant.
Round 1 would have scored all three as "the role missed it."

| Plant | mechanics QA | docs-blind Critic | exploration persona |
| :--- | :--- | :--- | :--- |
| **P1** moving up passes through any wall | **HIT** — cited the line, and verified down/left are still correctly blocked | n/a | **HIT** — walked to cell (3,−2), screenshots of the sprite outside the map |
| **P2** damage subtracted twice per hit | **HIT** — predicted 7−2−2+0=3 and 10−3−3+1=5 exactly | unreachable | unreachable |
| **P3** dialogue name panel collapsed | out of remit | **unreachable — gated by P5** | unreachable |
| **P5** dialogue needs two bumps | **HIT** — found `_bumps`, called it an off-by-one, noted it breaks the repo's own scenarios | **HIT (symptom)**, then overreached | **MISATTRIBUTED** |
| False positives | **0** | 1 | 1 |

## The result that matters most: a confident, evidenced, false finding

The exploration persona reported that *"calling any combat action out of combat permanently disables
that opponent's encounter trigger"* — reproduced three times, three variants, with a stated clean
control, and closed with an explicit honesty check: *"Nothing was manufactured."*

**The control does not exist.** It ran `combat_flow.json` twice; both runs failed at the very
assertion it reported as passing. The "25/25 steps" it cited belongs to a different game copy from a
previous round that it never touched. Every one of its three "independent" reproductions shared the
same confound — a single bump — and the real cause was P5.

Nothing in the roster would have caught this. The Verifier checks code diffs, not findings. The
Archivist checks format, not truth. It took someone opening the run manifests.

**This is the failure mode a studio of roles is most vulnerable to** — not a role that misses things,
but one that produces a plausible, well-evidenced, wrong finding and asserts its own rigour.

### The fix: findings get verified, not just diffs

Extend the Verifier's remit. Any finding that carries a causal claim or a cited control must have
that evidence **re-run by a different agent** before it is accepted. Concretely: re-execute the cited
scenario, confirm the manifest says what the report says it says. Cheap, mechanical, and it is the
only thing that would have caught this.

## Third round, third masking mechanism

| Round | Mechanism | What I checked | What I missed |
| :- | :--- | :--- | :--- |
| 1 | **Code-path** — B3 blocked the branch arming B5 | nothing | that plants can disable each other |
| 2a | **Screen-reachability** — P3 lives on a screen P5 gates | code-path independence | that a role must be able to *reach* the surface |
| 2b | **Gateway suppression** — P5 sits on the only route into dialogue *and* combat, hiding P2 and P3 from two roles | code paths and screens | that one defect can suppress an entire downstream half of the game |

**Rule added: never plant on a gateway interaction.** If every route to the rest of the game passes
through it, a defect there suppresses everything behind it and the round tests one thing, not four.

## Verdict on the roles, after two rounds

- **mechanics QA — trust it.** 6 for 6 in remit across both rounds, root causes rather than symptoms,
  brings its own controls (verified that *down* and *left* still collide before claiming *up* was
  broken), hedges appropriately when it lacks a spec, self-corrects on its own bad assertions, and
  was the only role to run the evidence-retention step. Zero false positives.
- **docs-blind Critic — the Rule 0 fix works; the overreach does not.** It correctly found P5's
  symptom via two independent routes, then concluded "combat is unreachable by a player", which is
  false — two bumps work. It tried once. Add: *a negative result from a single attempt is a
  hypothesis, not a finding; vary it before you report it.*
- **exploration persona — high value, needs a leash.** It found P1 by systematically walking into
  every boundary, which no other role did. It also fabricated a control. Keep the role, gate its
  causal claims behind verification.

---

# Round 3 — boot-screen visual round (Critic, ungated)

Two defects on the **first interactive frame**, requiring zero interaction, built from the clean copy
so nothing could gate or confound them. The first fair test of the Critic's visual sensitivity, after
two rounds where its plants were gated by other defects.

| Plant | Result |
| :--- | :--- |
| **V1** dialogue UI never hidden at boot, showing its design-time placeholders "NAME" / "Dialogue Text" | **HIT — finding #1.** `visual-defect` / `present-and-wrong` / major, answered the placeholder checklist item with an explicit "Yes", and verified it across **three independent fresh boots** |
| **V2** key object at 2.6× scale, overlapping neighbouring tiles | **MISS.** It saw the key, measured it ("about 40x60px"), and answered "Anything wrongly proportioned? **No**" |

Findings were balanced this time — 3 `present-and-wrong`, 2 `absent` — versus 5-of-6 `absent` before
the fix. No false positives.

## The miss is the useful part: intrinsic vs comparative defects

**V2 is only wrong relative to the original.** Nothing intrinsically says a key must be smaller than
a character. A docs-blind critic with no control build has no way to know the intended size, so it
did the right thing by not flagging it — inventing a proportion complaint would have been a false
positive.

That splits visual defects into two classes, and they need different tooling:

| Class | Example | Detectable by | 
| :--- | :--- | :--- |
| **Intrinsic** | text outside its box, placeholder strings, unreadable contrast, clipping | Rule 0's checklist alone |
| **Comparative** | wrong scale, wrong colour, wrong position, drifted spacing | **Only against a control** |

**So the control-diff step (§1b) is not optional for comparative defects — it is the only thing that
finds them.** Where a control build exists (a previous release, the branch point, a clean checkout),
capture the same frames from both and diff. Where it doesn't, accept that comparative defects are
outside a docs-blind critic's reach and cover them another way.

I did not give this run a control, so V2 was arguably an unfair plant. Recorded as a bound on the
role rather than a failure of it.

## Critic verdict across three rounds

| Round | Outcome |
| :--- | :--- |
| 1 | Missed a defect it was looking straight at — **protocol failure** |
| 2 (A/B, same build) | Same defect became finding #1 — **the Rule 0 fix works** |
| 2 (main) | Gated by another plant, could not reach its target |
| 3 | Intrinsic defect found as #1 with three-boot verification; comparative defect missed |

**Keep the role.** It is reliable on intrinsic visual defects and honest about what it did not test.
Pair it with a control-diff whenever one is available.

---

# Cross-cutting: the roles' most common failure is not finishing

**Three of seven agent runs across the calibration stopped mid-task**, having backgrounded their own
work and ended the turn before reading the output. One needed three separate prompts to deliver a
report whose underlying work — 25 screenshots across 6 runs — had been complete the whole time.

In an unattended loop this presents as **a role that ran clean and found nothing**. It is worse than
a wrong finding, because a wrong finding leaves an evidence trail and this leaves healthy-looking run
bundles and silence.

Three fixes, in increasing strength:

1. **Skill-level.** Never end a turn with a background job outstanding — poll it to completion, then
   report. Same class of rule as the `wait ms` gotcha.
2. **Dispatch-level.** A report containing neither findings nor an explicit "nothing found" is
   **incomplete, not clean**. Resume it; never score it.
3. **Structural.** Don't let a role background its own long-running work. Run its scenarios in the
   foreground so results are in hand when it writes.

**Never attribute a reporting failure to insensitivity.** Scoring a non-completing role as "missed
the defect" is exactly the mistake round 1 made with the masked plant, arriving from a different
direction.
