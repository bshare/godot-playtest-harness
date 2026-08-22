# Critique Skill — docs-blind design critique

> **Are you sure this is your doc?** `PLAYTEST_SKILL.md` validates mechanics against the spec and
> encourages reading the design docs. **This one does the opposite job**, and mixing them destroys
> the only thing it provides.
>
> **Why it exists:** on the origin project, every automated mechanics playtest passed clean on a
> build where one hands-on human session found seven significant experience problems in a single
> sitting. A spec-driven protocol structurally cannot produce the sentence "I don't know what I'm
> looking at." That sentence is your entire deliverable.

---

## Rule 0 — Describe before you interpret. Do this for every screenshot.

**This rule exists because the previous version of this protocol failed without it.** In a measured
calibration, a critic following this doc looked at a screenshot in which the dialogue text was
sitting on the grass *outside its own panel* — the most visually obvious defect in the build — cited
that exact screenshot as evidence for a different finding about a name tag, and never mentioned the
overflow. It found six real things, and almost all of them were about what was *absent* (no health
numbers, no feedback, no objective) rather than what was present and wrong.

Interpretation crowds out observation. So observation comes first, mechanically, before any
judgement:

**For every screenshot, write a literal inventory before writing a single word about experience.**

1. **List every element you can see** — panels, text, buttons, bars, sprites, icons. Name each one.
2. **For each, state where it is and how big.** Roughly is fine: "blue rounded panel, bottom-left,
   about a third of the screen wide."
3. **Then run the layout checklist**, and answer each one explicitly, including when the answer is no:
   - Does any **text extend beyond the container** it appears to belong to?
   - Do any two elements **overlap** that shouldn't?
   - Is anything **cut off** at a screen edge, or clipped by its own box?
   - Does any element look **wrongly proportioned** — a panel too small for its contents, a bar
     wider than its frame, a button larger than its neighbours for no reason?
   - Is any text **unreadable** — too small, low contrast, or over a busy background?
   - Does anything look like a **placeholder** — "UNKNOWN", "TODO", lorem text, a default icon?

Only after the inventory and the checklist do you move to the naive questions in Rule 3.

**A layout defect is a finding even when the game is perfectly playable.** Text outside its box does
not stop anyone playing; it is still one of the most damaging things a player can see, because it
reads as unfinished.

**"Absence" findings and "present and wrong" findings are different, and you owe both.** It is much
easier to notice that something is missing than to notice that something on screen is broken. If
every finding you report is about something that *isn't there*, you have written a wishlist, not a
critique — go back to the screenshots and look at what is.

**Two classes of visual defect, and only one is yours alone.** *Intrinsic* defects — text outside
its box, placeholder strings, unreadable contrast, clipping — are detectable from a single frame, and
the checklist above is what finds them. *Comparative* defects — wrong scale, wrong colour, drifted
spacing — are only wrong relative to how it used to look. Without a control build you cannot know the
intended size of a thing, and inventing a complaint about it is a false positive. When a control
exists, use §1b; when it doesn't, say plainly that comparative defects were out of reach.

## Rule 1 — Docs-blind first. This is the load-bearing rule.

**Do not read the design documents, the source, the plan, or the card/item/enemy lists before Part 1
of your report is written and saved.**

Not "try not to." Do not. Informed, you are worthless — the project already has a role that reads
everything, and it is not you. Your value is entirely in being a stranger.

If you have already read them in this session, **stop and say so**. A compromised critique that
claims independence is worse than no critique, because it launders familiarity as fresh perspective.

**The independence check:** if your report uses vocabulary you could only have got from
documentation — an internal mechanic name, a term the UI never showed you, a number nobody
displayed — your independence is gone and the run is discarded. Say so rather than shipping it.

## Rule 2 — Screenshot-primary. State is a witness, never the story.

The opposite of the mechanics protocol, deliberately. You are evaluating what a player *sees*. A
state dump tells you the game is behaving correctly; it cannot tell you the screen is unreadable.

Use state only to confirm something you already suspect from looking.

## Rule 3 — The naive-question battery

Ask these of every screen, and write down the answer even when it's embarrassing:

1. **What do you think this is?** Answer before anything else, and say what made you think it.
2. What am I supposed to do right now? What told me?
3. What is the biggest thing on screen? Is that the most important thing?
4. What is this number? Why is it going down?
5. Something is greyed out — can I discover why?
6. What just happened? Did the game tell me, or did I infer it?
7. What did I want to click that I couldn't find?
8. If I lost or failed — do I know what I did wrong?

## Rule 4 — Experience heuristics

- **First 30 seconds.** What does a stranger understand by then? That is most of your retention.
- **The unexplained resource.** If a number does two jobs, did the screen teach that, or did losing?
- **The dead click.** Anything that looks interactive and isn't is a bug in the same sense a crash is.
- **The invisible state change.** Something changed and nothing announced it.
- **The moment of confusion.** Note *exactly* where it happened, not a general impression.

---

## How to run one

### 1. Build and boot

Fresh debug export, first-run state (clear any save). You want a genuine cold boot — the thing a real
first-time player sees, including the title screen and any onboarding.

### 1b. Diff against a control, if one exists

If a known-good build is available — a previous release, a clean checkout, the branch point — capture
the same screens from both and compare them side by side. A defect you cannot name in isolation is
often obvious the instant you see the two frames together.

Most real critiques have no control build. When you don't, Rule 0's checklist is what replaces it.

### 2. The tour

**For a long run, `play_run.mjs` is usually the better tour than a scenario.** It plays turn by turn
from the game's own legal moves, so you see a real playthrough rather than a path you scripted in
advance, and `--screenshot-every N` gives you the ordered sequence this protocol reads as narrative:

```bash
node $PLAYTEST_HOME/src/play_run.mjs --game . --seed 901 --policy greedy \
     --max-turns 400 --screenshot-every 25
```

Use a scenario instead when you are specifically testing whether a *control* is findable — see the
note below. Either way, cite by filename or it gets pruned.


Use a scenario with `capture_boot: true` and screenshots at every beat: cold boot, first interactive
frame, first action, first success, first failure, each major screen. Prefer clicking through real
controls over bridge actions where you're testing whether a control is *findable* — a bridge call
proves the mechanic works while skipping the exact question you're here to answer.

### 3. Stage 2 — the returning-player pass, required

Boot again with the state a returning player would have. Different problems live here: what made
sense in sequence often makes none in isolation, and onboarding that only fires once leaves a
returning player with no explanation at all.

### 4. Write Part 1 — first impressions — and SAVE IT

Docs-blind, complete, saved to disk **before** you read anything. This is the artefact. Everything
after this point can only dilute it.

### 5. Part 2 — intent vs. experience (docs allowed now)

*Only now* read the design docs, and answer one question: **where does the intent and the experience
diverge?** A mechanic that works exactly as designed and reads as broken is the most valuable finding
this protocol produces, and it is invisible from either side alone.

---

## Findings format

- **Title** — one line
- **Category** — `confusing-ux` · `visual-defect` · `bug` · `positive-note`
- **Kind** — `present-and-wrong` (something on screen is broken) or `absent` (something is missing).
  Report both kinds. A report that is entirely `absent` findings has not looked at the screen
- **Severity** — `critical` (blocks or crashes) · `major` (misleading) · `minor` (cosmetic)
- **Evidence** — the screenshot filename. Always
- **What I expected instead** — one sentence

**Cite every screenshot you rely on by filename** — citation is what preserves it. After your report,
run `prune_run.mjs <run-dir>`: cited images are kept, everything else is deleted with its filename
recorded. If an image matters, cite it.

**Report at least one `positive-note`** if anything worked. Only-complaints gives no signal about
what to protect.

---

## Boundaries

- Never modify the game.
- Never read design docs before Part 1 is saved.
- Never point anything at the release build.
- Never delete a run bundle by hand.

## The bar

**"I don't know what I'm looking at" is a finding, not a failure.** It is the most valuable sentence
you can produce and the one no other role in the project is able to produce. If you finish a critique
without having written anything like it, ask honestly whether you were really looking, or just
confirming that the software worked.
