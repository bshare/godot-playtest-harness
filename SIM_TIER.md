# The sim tier — headless, no browser

The browser tier answers *"what does a player see"*. This tier answers *"what happens across a
thousand runs"*, at roughly 1000× less cost per run. Both drive the **same game code through the
same adapter**, so a number measured here is a number about the real game.

```bash
godot --headless -s res://tools/sim/sim_runner.gd -- --runs=100 --seed=1 --policy=random

node src/batch.mjs --game /path/to/game --runs 200 --compare greedy,optimiser
node src/batch.mjs --game /path/to/game --runs 20 --verify-determinism
```

## It is not only for turn-based games

`dispatch -> resolve -> next` sounds turn-based, and it is not. **"Advance time" is just another
action**: a decision point replaces a turn, and `wait` is the decision to let the economy run.
Verified on a real idle game with no change to the runner at all.

What an idle game must have is a **fixed-step tick entry point** the adapter can call directly —
in one idle game this was built on, `GameManager._process` only accumulates and `_execute_game_tick(delta)`
does the work. A game whose logic sits inline in `_process` bodies using the frame's own delta
cannot be driven this way: it would advance by wall-clock time, and two runs of one seed would
differ by machine speed. **Check for that before promising an idle game a sim tier.**

Two other things that port taught, both about adapters generally:

- **The scene may be required.** If the game registers its managers from a scene rather than
  declaring them as autoloads, the adapter instantiates the main scene headlessly. It renders
  nothing; the tree is just where the game keeps its state.
- **Delegation runs whichever way suits the game.** In one port the bridge delegates to the adapter;
  in the other — a game with an existing mature `DebugBridge` — the adapter calls the *bridge's*
  `dump_state()` and action methods. What matters is not which file owns the logic, only that both
  tiers go through exactly one implementation.

## Declaring what to measure

`hp_fraction` and `death_cause` describe a game you can be killed in — most games, not all. An idle
game has no win rate and no residual HP, and reporting only the built-ins for one produces a table
of zeroes that reads as broken tooling. Games declare their own aggregates:

```jsonc
// playtest.config.json
"sim_metrics": ["resources.lifetime_scrap", "systems.repaired_this_run_count", "altitude.current"]
```

Each is a dotted path into `build_state()`, reported with mean/median/min/max and folded into the
policy ratios. A path that never resolves is reported as an error rather than omitted — a silent
omission reads as "the game didn't do that" instead of "nobody measured it".

## Three files

| File | Where it lives | Who writes it |
| :--- | :--- | :--- |
| `godot/sim_runner.template.gd` | copy to `res://tools/sim/sim_runner.gd` | harness — **never edited per game** |
| `playtest_core.gd` | `res://tools/sim/playtest_core.gd` | **you**, per game |
| `src/batch.mjs` | harness repo | harness |

Everything game-specific is in the adapter, and `DebugBridge` should delegate to the *same* adapter
— otherwise the two tiers are two hand-written approximations of the game and comparing them proves
nothing.

The adapter contract is documented in full at the top of `sim_runner.template.gd`:
`reset(seed)`, `build_state()`, `legal_moves()`, `dispatch(action, args)`, `is_over()`,
`outcome()`, `state_hash()`.

## Playing a whole run in the browser, and the parity check

```bash
node src/play_run.mjs --game DIR --seed 900 --policy optimiser --max-turns 400 --screenshot-every 50
node src/play_run.mjs --game DIR --seed 900 --policy optimiser --max-turns 200 --parity
node src/play_run.mjs --game DIR --seed 900 --policy optimiser --sim-policy first_legal --parity  # control
```

A scenario is committed to before it runs — every step after a failure was planned blind to that
failure. `play_run.mjs` is the other shape: a request/response loop that picks each action from
`legal_moves` against the state the game is actually in. It is also how an interesting seed from a
batch becomes something you can watch.

`--parity` runs the same seed and policy on both tiers and compares the **per-turn state hash**,
stopping at the first divergence (everything after it is measured against a state the tiers no
longer share). This is the assumption every cheap-tier number rests on, and it is only testable
because the bridge and the sim runner drive the *same adapter object* rather than two
implementations of it. If your `DebugBridge` re-implements state instead of delegating, this check
compares your two drivers, not the game.

**Run the negative control.** `--sim-policy` deliberately runs a different policy on the sim side
and must fail at turn 1. A parity check that has never been seen to fail is indistinguishable from
one that compares nothing — and this one passed 40/40 on its first attempt, which is exactly when
you should be suspicious. Verified failing at turn 1 with mismatched policies (exit code 1).

**It found a real divergence on its first serious run, and it is still open.** On
`statico/godot-roguelike-example`, seed 901 under the optimiser: 43 turns identical, then one
monster ends up a single tile apart, the turn after a level transition. Both tiers are individually
deterministic — two browser runs of that seed agree for 60 turns, and `--verify-determinism` passes
— so neither tier alone can see it. Everything measured on the cheap tier assumes this cannot
happen, which is exactly why the check exists.

Two things that chase taught, both worth copying:

- **A hash tells you *that*, not *what*.** The diverging turn had byte-identical player state, map
  and turn count. Localising it meant adding the monster roster to `build_state` — a field the hash
  already folded in but nobody could read. Put the hash's inputs in state from the start.
- **Verify a fix by its effect on the hash, not by its plausibility.** The obvious culprit was
  cosmetic randomness drawing from the engine-global RNG — the gameplay stream — in the sprite-flip
  and blood-stain code, which only runs when something is being rendered. Compelling, wrong: with it
  patched and confirmed present in the exported build, the browser hash was *byte-identical* to the
  run before. Those draws never happened in that run. (The patch stayed anyway — presentation code
  sharing the gameplay RNG stream is a real hazard in a seeded game, just not this bug.)

One subtlety that will bite: the turn counter must be **successful** turns, not attempts, on both
sides. `random` and any scripted policy seed off it, so counting attempts desynchronises the tiers
on the first rejected action — a parity failure with no cause in the game at all.

## Isolation is a different property from determinism — check both

```bash
node src/batch.mjs --game DIR --runs 20 --verify-determinism   # same batch twice, compare
node src/batch.mjs --game DIR --runs 20 --verify-isolation     # last seed batched vs. alone
```

A batch runs N runs in ONE process, so anything `reset()` fails to clear carries into the next run.
**`--verify-determinism` cannot catch that**: both batches leak identically, so it passes clean.
`--verify-isolation` asks the only question that catches it — does the last seed in a batch reach
the same state when run alone?

Measured on an idle game, where six "independent" runs turned out to be one
continuous run: altitude climbed exactly 150m per run, 150 → 300 → … → 900, while determinism
reported OK throughout. Three separate causes, and only the first is obvious:

1. **Rebuilding the scene is not a reset.** The managers were autoloads; they outlive the scene and
   keep the previous run's numbers. Fixed by mirroring what the game's own System Reset clears.
2. **The check is blind to whatever the hash omits.** `--verify-isolation` also reported OK at first
   — `state_hash()` didn't include altitude. A hash that doesn't cover a value cannot detect that
   value leaking, which is the same lesson as the parity chase from the other direction.
3. **The game's own `_process` was still ticking.** With the sim calling the fixed-step tick
   directly *and* the engine ticking on every real frame, a wall-clock delta leaked in and left
   altitude differing in the third decimal — a machine-speed dependency. **The sim must be the only
   thing advancing game time.** Pause the game's loop in `reset()`.

## Long runs: budget, throughput, memory

A game that triples its run length (one turn-based game's Phase 2 went from one act of 8 nodes to three)
raises three questions this section answers with measurements rather than defaults: does the turn
budget now censor, does one process survive a long batch, and does `reset()` still isolate at the
new length. Measured on that game's 24-node runs, Godot 4.7.1, one engine process throughout.

**The budget that needed raising was not the sim tier's.** Uncensored (`--max-turns 6000`,
30 seeds, both policies): greedy runs end by turn 204; optimiser runs reach 682 at the longest,
and the longest runs are the *winning* ones — median 188, p90 357. `batch.mjs`'s default of 2000
does not censor even the tail (≈3× headroom; 0 TIMEOUTs in 260 measured runs). The default that
DOES censor is **`play_run.mjs`'s 200** — a browser-tier default sized for one-act runs truncates
most winning 24-node runs mid-dive. Pass `--max-turns 800` or more when playing a full long run in
the browser. Both defaults stay as they are: the sim default already clears the game that grew,
and raising the browser default would let an unrelated stuck game burn minutes instead of seconds.

**Throughput:** 200 runs in 8.2 s wall including engine boot — ~24 runs/s effective, ~34 ms
marginal per run once the ~1.4 s boot is amortised. A 2000-run certification arm is ~80 s.

**Memory is flat, which is the number that matters in a shared process:** peak working set
102 MB for a 30-run batch and 102 MB for a 200-run batch; the game's own reported static memory
stays inside 27.8–28.5 MB across all 200 runs with no upward trend, and per-run duration does not
drift (first 50 runs mean 40.7 ms, last 50 mean 38.1 ms). A leak would show in all three.

**Isolation holds at the new length:** `--verify-isolation`, 20 optimiser runs at
`--max-turns 4000` — the 20th seed reaches the same hash batched as alone (OK).

One instrumentation trap, Windows-specific: sample memory on the real engine binary. Launching
`Godot_*_console.exe` and reading that process's working set measures the console *wrapper*
(~6 MB), not the engine it spawns.

## Seeding is the whole game

**Run `--verify-determinism` before you believe a single number from this tier.** An unseeded RNG
stream anywhere turns every aggregate into noise, and the failure is invisible: the numbers still
look plausible.

Ported against `statico/godot-roguelike-example`, seeding took **three** separate streams, and only
the first was obvious:

1. `Dice._rng` — the game's own `RandomNumberGenerator`, with a public `set_seed()`. Found by reading.
2. The **engine-global** RNG. `randi()`, `randf()`, `Array.pick_random()` and `Array.shuffle()` all
   draw from it, and the game used them throughout its AI, its actions, and its starting inventory.
   Needs a bare `seed(v)`.
3. A **function-local** `RandomNumberGenerator.new()` inside the room-placement routine. With 1 and 2
   fixed, the starting inventory reproduced perfectly and every map was still different — which reads
   as a gameplay bug, not a seeding gap.

Two further traps, both real:

- A generator that **retries on validation failure** must draw a *different* stream per attempt, or a
  fixed seed regenerates the same rejected map until the attempt budget runs out and it returns null.
- A **parameter re-pack** silently drops the seed. The seed reached `generate_map`, which built a
  fresh params dict for the room generator and didn't copy it across.

## Gotchas

- **The `-s` script cannot reference autoload singletons by name.** It is compiled before autoloads
  register, so `World.foo` is a compile error in `sim_runner.gd` — while the same line works fine in
  the adapter, which is loaded at runtime. Reach them via `root.get_node("World")` if you must.
- **Autoload `_ready()` has not fired when `_initialize()` runs.** Read state there and you get a
  half-built world full of nulls. `await process_frame` first.
- **The engine still instantiates every autoload under `-s`** — that is what makes this tier the real
  game rather than a decoupled model.
- **Log calls can dominate the runtime.** A game whose logger calls `get_stack()` per message spends
  most of a headless run in it. Gate the log level in `reset()`.
- **Batched runs share one process**, so anything `reset()` fails to clear leaks into the next run.
  `--verify-isolation` is what catches that; `--verify-determinism` does not, and the section above
  explains why.

## Policies

The runner ships two game-agnostic policies, because they only ever see the legal-move list:

- `random` — uniform over legal moves. The floor. If a real policy can't beat it, the game's
  decisions aren't load-bearing.
- `first_legal` — takes the first legal move every turn. Deterministic, useful for isolating the
  policy from the measurement when something looks wrong.

Anything else is delegated to the adapter's `policy(name) -> Callable`, which is where "playing
well" is defined — that judgement is game knowledge and cannot live in the harness. The pair worth
writing first, and the pair the ratio is designed around:

- **greedy** — immediate value only. Fight what's adjacent, take what's underfoot, descend when
  standing on stairs, otherwise close on the nearest visible threat. No resting, no resource
  management, no lookahead. Not a straw man: this is close to how an inexperienced player plays.
- **optimiser** — the same objectives plus the resource management the game rewards. Heal before
  it's urgent, eat before hunger bites, disengage from a fight going badly, don't take the stairs
  down at low HP.

Measured on `statico/godot-roguelike-example`, 30 seeds, turn budget high enough that neither
policy hits the cap (an uncensored budget is the whole point — capped runs make the ratio a
statement about the cap):

| policy | outcome | cause | mean turns survived |
| :--- | :--- | :--- | ---: |
| greedy | 30/30 LOST | 30/30 STARVED | 542 |
| optimiser | 30/30 LOST | 30/30 STARVED | 991 |

**optimiser/greedy = 1.83×.** That is the number worth reporting. Zero rejections on both, and
every seed reproduces across processes.

Two rules both must follow:

- **Never draw from the game's RNG.** Seed the policy from `(run seed, turn)`. A policy that
  consumes a game stream changes the map it is measuring, and replaying the same seed under a
  different policy stops being a comparison.
- **Use only information the player has.** Path toward *visible* monsters and *seen* stairs. A
  policy reading the whole map measures a game nobody is playing.

## Reading the output

`hp_fraction` is the headline difficulty signal, not the win rate. Agent win rate does **not**
transfer to human difficulty; residual HP does (Xiao et al., arXiv:2410.02829, r=0.871). The other
trustworthy shape is a **ratio between two policies** — "the optimiser beats greedy by 2×" says the
game has real decisions in it without either number needing to mean anything alone.

**Pick the headline metric to match how the game actually kills you.** The first comparison run
here reported `30/30 LOST, mean hp_fraction 1.0`, which reads as a broken metric — every death was
starvation at full health, and HP was never going to say so. `death_cause` is an optional adapter
field, reported by `batch.mjs` whenever present; if your game can lose in more than one way, put the
reason in state. It also caught a bug in the optimiser itself: the first version outlived greedy by
48% and was *also* dying starving, because it rested itself to death after the food ran out. Without
cause-of-death that looks like a win.

`rejections_total` is health of the *measurement*, not of the game: non-zero means `legal_moves()`
offered something `dispatch()` refused, so the batch is partly measuring a broken adapter. The
runner aborts a run at 32 rejections for the same reason — without that guard, the roguelike port's
first batch would have looked like a hard seed instead of a legal-move list that offered walking
into closed doors.
