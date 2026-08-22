# Prior Art

What already exists in this space, why this harness exists anyway, and — the useful part — what
should be borrowed from the alternatives.

Written after the fact, which was the wrong order. Recorded so the next tool starts here.

---

## 1. [godot-mcp](https://github.com/satelliteoflove/godot-mcp) — the closest thing

An MCP server letting an agent edit scenes, inject input, and verify its own work by running the
game. Active, well-documented, 21 tools / 86 actions.

**Overlaps us on intent almost exactly.** Differs on architecture:

| | godot-mcp | this harness |
| :--- | :--- | :--- |
| Target | Editor + desktop build | **Web export in a browser** |
| Transport | MCP → WebSocket → Godot debugger protocol | `JavaScriptBridge` → `window.*` |
| Requires the editor running | **Yes**, one client at a time | No |
| Scenario files | No | Yes, with a validator |
| Seeded batch runs | No | Yes (planned `batch.mjs`) |
| Time control | **Freeze / step / step-until** | `wait ms` only |

**Honest verdict: they are complementary, not alternatives** — see
[`CHOOSING_YOUR_TOOLING.md`](CHOOSING_YOUR_TOOLING.md). godot-mcp is the better inner loop: no export
step, the real input stack, frame-accurate time control, and it works before you have written any
bridge code. This harness is the better outer loop: headless, parallel, seeded, unattended, and
testing the artifact players actually receive.

The deciding constraint is that **godot-mcp is editor-bound and serves a single client at a time**,
with extra clients queued and no headless mode. Balance sweeps, seeded regression, and an unattended
build loop all need many runs, and that is architecturally unavailable there. Equally, a bridge call
that invokes a method directly proves the method works — not that a real input reaches it, which is
what godot-mcp gives you almost for free.

Most projects that ship a web build but develop on desktop should run both.

### What to borrow — deterministic time control

This is godot-mcp's best idea and our biggest weakness. It offers:

- boot with the clock **frozen at frame 0**
- `godot_game_time step 500ms` — advance an exact slice
- `godot_game_time step_until "<condition>"` — advance until game state satisfies a predicate

The stated rationale is that inputs land inside the stepped window, so **observation never races the
game**. That is precisely the failure mode our `wait ms` step has: sleeping a guessed duration and
hoping the game got there. Eleven checked-in scenarios once slept 1000ms instead of the intended
duration and nobody noticed until a playtest reported a bug that did not exist.

**Built — see the README.** A `wait_for` runner action: Poll `dump_state` on an interval, evaluate a dotted-path
predicate against it, proceed the moment it holds, fail loudly on timeout:

```jsonc
{ "action": "wait_for",
  "args": { "path": "combat.turn", "op": ">=", "value": 3, "timeout_ms": 10000 } }
```

Same predicate vocabulary the `assert_state` step already uses, so it costs no new concepts. This
does **not** need engine-side clock control — it converts "sleep and hope" into "wait for the thing
you actually mean", which is most of the value at a fraction of the cost.

**Full clock freezing is the deeper fix** and needs game-side support (a `set_time_scale(0)` plus a
frame-stepping action). Worth doing for a real-time game. The game this was built on is turn-based,
so `wait_for` is likely sufficient there.

## 2. [godot-stagehand](https://github.com/mrf/godot-stagehand) — the closest surface overlap

Found in the 2026-08 pre-release landscape sweep, after most of this harness was built —
independent convergence, which is evidence the design is a natural one. It has: declarative JSON
scenario files (launch/action/wait/assert), evidence artifacts (report.json, screenshots, diffs,
RPC traces, logs, JUnit XML), an MCP server and CLI over the same core, token-authenticated
loopback TCP, and even the same "dev control plane, not a hardened endpoint" security framing.
Beta, pre-1.0, small adoption at the time of the sweep.

**What it does not have** (per its README at the time): any sim tier — no seeded batch runs, no
determinism/isolation verification, no policy×variant matrices, no parity checking; no
`legal_moves`-driven interactive play; no coverage/diff/prune verbs; no UI audits; and it drives
games through generic selectors rather than a game-author-defined semantic action catalog with a
validator.

**Honest verdict:** anyone evaluating this harness should know stagehand exists — the README's
comparison table says so. The scenario-file + evidence-bundle surface is shared ground; the
verification and analysis layers are not. Its low adoption despite functional overlap is worth
watching: it may mean the audience for this whole category is small, or that nobody has marketed
it yet. Either way there is no entrenched incumbent.

## 3. [PlayGodot](https://saltares.com/run-automated-tests-for-your-godot-game-on-ci/) — evaluated, rejected

"Playwright for Godot games", driving the native RemoteDebugger protocol. Rejected on the origin
project because it requires a **forked engine binary** rather than the stock official one, with no
proven web-export story. Staying on the stock engine was worth more than the features. That call
still looks right, but re-check it if they ship stock-engine support.

Re-checked in the 2026-08 sweep: still driven through engine debug protocols, still no stock-engine
web-export story found; the call stands. The sweep also surfaced
[godot-e2e](https://github.com/RandallLiuXin/godot-e2e) in the same family — Python/pytest over
TCP with live state assertions and screenshot-on-failure, no scenario files or manifest. Same goal,
generic-protocol mechanism.

## 4. GUT and [gdUnit4](https://kuma-gee.medium.com/writing-tests-in-godot-a9a5ed279b2c) — complementary, not competing

In-engine unit test frameworks, both headless-capable. **Nothing here duplicates them**, and games
using this harness should still use one for pure logic. They test functions; this drives a running
game.

## 5. The research literature — mostly ahead of us

- **[Xiao et al., "LLMs May Not Be Human-Level Players, But They Can Be Testers"](https://arxiv.org/abs/2410.02829)**
  — the most directly useful result. LLM agents underperform average humans in absolute terms, but
  their **residual HP** correlates with human difficulty at **r = 0.871** on Slay the Spire. Take the
  relative signal, never the absolute win rate. This corrected a real error in one game's pacing
  targets, where an agent win rate was being used as a human proxy.
- **[PersonaTester](https://arxiv.org/pdf/2603.24160)** — persona-driven testing decomposed along
  *testing mindset*, *exploration strategy*, and *interaction habit*. More principled than an ad-hoc
  persona list, and a better basis for designing new ones.
- **[Leveraging LLM Agents for Automated Video Game Testing](https://arxiv.org/html/2509.22170v1)** —
  survey of the field.

## 6. What is genuinely ours

Revised after the 2026-08 landscape sweep, in both directions. **No longer uniquely ours:** the
scenario-file + evidence-artifact surface (godot-stagehand converged on it independently), and
MCP/agent integration (at least five Godot MCP servers existed by mid-2026 — table stakes, not a
differentiator). **Confirmed without a found equivalent for Godot:**

1. **The sim tier's verification discipline** — seeded batch runs whose determinism and isolation
   are checked rather than assumed, policy×variant matrices with target bands, and browser/sim
   parity. Nothing found does any of this for Godot; determinism results in the wild are all about
   physics-engine determinism, not about verifying a test harness's own claims.
2. **`legal_moves`-driven interactive play** — the agent picks from declared-valid actions instead
   of guessing and interpreting refusals.
3. **coverage / diff / prune** — "what did this pass never touch" (never-looked vs. clean),
   semantic state diffs between runs, and report-as-retention-manifest with tombstones.
4. **UI audits** (occlusion, scroll stability, lint, consistency rules) — Godot UI testing
   searches turn up forum threads saying "build it yourself".
5. **The semantic bridge contract** — a game-author-defined verb layer with a validator, versus
   everyone else's generic selectors, plus the specific hard errors (`args.ms` on `wait`,
   misplaced top-level keys) that each exist because a silent failure produced a false conclusion.

Everything else, someone has done, often better. Check here first next time.
