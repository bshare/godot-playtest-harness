# Running a calibration round

**The question this answers:** when a role reports nothing, is the build clean or is the role blind?
Nothing else in a role roster can tell you.

Plant known defects in a throwaway third-party game, run the roles blind, score against ground truth.
Results from three rounds are in [`../CALIBRATION.md`](../CALIBRATION.md) — read that before designing
a new plant set, because the method took three rounds to get right and every correction below was
paid for.

---

## The protocol, in order. Do not skip a step.

Across three rounds, **six of nine plants were defective** in ways that would have been scored as
role failures. Each step here exists because of one of them.

### 1. Get a subject and a control

```bash
git clone --depth 1 https://github.com/godotengine/godot-demo-projects demos
cp -r demos/2d/role_playing_game subject && cp -r demos/2d/role_playing_game control
```

**The control is not optional.** It is how you tell "the plant works" from "the plant did nothing",
and it is the only way to detect comparative visual defects at all.

### 2. Wire the subject up

Follow [`../skills/SETUP_SKILL.md`](../skills/SETUP_SKILL.md). A worked example for this exact game
is in [`../examples/role-playing-game/`](../examples/role-playing-game/) — copy its bridge, config
and catalog rather than starting from scratch.

### 3. Apply the plants

```bash
python3 plants/round2_mechanics.py ./subject
```

The scripts assert on their anchors, so an upstream change to the demo fails loudly instead of
silently applying nothing.

### 4. Prove the plants APPLIED

```bash
diff -rq control subject
```

*Round 1: one plant's edit inserted a comment and left the target line intact. Never verified, scored
as "missed by every role".*

### 5. Prove the plants MANIFEST

Export both, run `scenarios/verify_*.json` against **both**, and diff the state snapshots.

*Round 2: two `.tscn` offset patches were silently overridden by Godot's container layout. Round 1's
`heal()` plant was dead code with no call sites. Neither would have been caught without this step.*

### 6. Prove the plants are INDEPENDENT

Three distinct masking mechanisms have bitten, and each needs its own check:

| Mechanism | Check |
| :--- | :--- |
| **Code-path** — one plant blocks the branch that arms another | Read the paths; confirm both manifest in the *same* run |
| **Screen-reachability** — a plant lives on a screen another plant gates | Walk each defect through the eyes of the role expected to find it |
| **Gateway suppression** — a plant sits on the only route into the rest of the game | Never plant on a gateway interaction |

*Round 2's two-bump plant gated both the combat plant and the visual plant, from two roles at once.*

### 7. Write ground truth OUTSIDE the subject

One row per plant: what, where, how it was verified, and which role is expected to find it. Never
inside the game repo — an agent will read it.

### 8. Run the roles blind

Never tell them a defect exists, or how many. Brief them exactly as you would for real work.

### 9. Score sensitivity AND noise

A role reporting ten things and hitting one is expensive, not sensitive. Count false positives
separately, and **verify every claim against the run manifests yourself** — in round 2 a role
reported a confident causal finding whose cited control run had, in its own bundles, failed at the
very assertion it was cited as passing.

**Never attribute a reporting failure to insensitivity.** Three of seven agent runs stopped mid-task
with the work complete but no report written. Resume them; do not score them.

---

## Choosing plants

- **Spread across independent subsystems.** One per file is a good default.
- **Mix intrinsic and comparative visual defects deliberately.** Intrinsic (placeholder text, overflow,
  clipping) is findable from one frame. Comparative (scale, colour, spacing) needs a control — and
  without one, a docs-blind critic is *right* to decline to guess.
- **Keep one plant per role's remit** so a miss is attributable.
- **Avoid gateway interactions** — see step 6.
