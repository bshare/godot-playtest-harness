# Choosing your tooling — this harness, godot-mcp, or both

Most Godot projects can export both a desktop build and a web build. That means this is **not an
either/or decision**, and treating it as one costs you the strengths of whichever you didn't pick.

The short version: **[godot-mcp](https://github.com/satelliteoflove/godot-mcp) is the better inner
loop. This harness is the better outer loop.** Many projects want both.

---

## The one difference that decides most of it

**godot-mcp is editor-bound and serves a single client at a time.** Extra clients queue. There is no
headless mode and no multi-instance execution.

So anything that needs **N runs** — balance sweeps, seeded regression, statistical claims, an
unattended build loop — cannot go through it. That isn't a limitation to tune around; it's
architectural. A web export, by contrast, is just a page: run twenty headless browsers at once if
your machine allows.

Equally: anything that wants **frame-accurate control and the real input stack** is far better served
by godot-mcp than by a bridge action that calls a method directly.

---

## Side by side

| | **godot-mcp** | **this harness** |
| :--- | :--- | :--- |
| Runs against | Editor + desktop build | Web export in a browser |
| Editor must be running | **Yes** | No |
| Parallel runs | **No** — single client, queued | **Yes** — N headless browsers |
| Headless / CI | No | Yes |
| Time control | **Freeze, step Nms, step-until-condition** | `wait ms` (see `PRIOR_ART.md` §1) |
| Input | **Real input stack** — actions, joypad, keys, mouse-look | Bridge calls; real clicks only by pixel |
| Per-game setup | Install addon, enable plugin | Write a bridge + action catalog |
| Scenario files | No | Yes, with a validator |
| Seeded reproducibility | Not a feature | Core |
| Tests the shipped artifact | Only if you ship desktop | Yes, if you ship web |
| Godot version | 4.5+ | Any with `JavaScriptBridge` |

---

## Use godot-mcp when

- **You're building a feature and want to check it works now.** Fastest possible loop: no export
  step, no server, no browser. This is its strongest case by a distance.
- **The thing under test is timing-sensitive.** Freeze the clock, step 500ms, assert. Nothing here
  competes with that.
- **You need input to travel the real path** — an `InputMap` action, a held key, mouse-look. A bridge
  action that calls `place_module()` directly proves the method works, not that the input reaches it.
- **You're testing something you'd otherwise have to expose a bridge action for**, and it isn't worth
  the API surface.
- **You're early.** It works before you've written any bridge code at all.

## Use this harness when

- **You need many runs.** Balance sweeps, 200 seeded runs, per-card win-rate deltas. Not possible
  under a single-client editor session.
- **You need reproducibility.** Same seed plus same action list must reach the same state, and a
  recorded run must replay exactly.
- **You're running unattended.** No editor to keep open, no GUI, survives a container.
- **You ship a web build.** Then this tests the *actual artifact players receive*, including
  export-only behaviour — canvas sizing, browser audio policy, load time — that a desktop run
  cannot show you.
- **You want a docs-blind critique pass.** Screenshots from a real browser at real resolution.
- **You want a scenario committed to git** as a regression test with a validator in front of it.

## Use both when — and this is the common case

A realistic split for a project that ships web but develops on desktop:

| Phase | Tool |
| :--- | :--- |
| Writing a feature | godot-mcp — instant, no export |
| Verifying it does what you meant | godot-mcp — step, inspect, iterate |
| Locking it in as a regression | this harness — a scenario in git |
| Balance and pacing | this harness — seeded batch |
| First-impressions critique | this harness — browser screenshots |
| Pre-release check | this harness — it *is* the shipped build |

---

## The risk of running both, and how to remove it

Two ways to drive the same game is two chances for them to disagree — and a game that behaves
differently under each is a game with a bug you'd rather find now.

**Make both read the same `dump_state`.** Your bridge already exposes it
(`BRIDGE_CONTRACT.md` §5); have any MCP-side inspection read the same function rather than a parallel
set of getters. One state schema, one `version` field, both paths agreeing.

**Then assert it.** If your game is seeded, run the same seed and action list through both and compare
`state_hash`. A divergence means one path is mutating state the other isn't — usually the UI layer
doing work that belongs in the model. That check is worth more than either tool alone, and it's the
same test a real game runs between its sim and browser tiers.

---

## Installing godot-mcp alongside this

Independent of each other; nothing conflicts.

```bash
# 1. Addon into the game project
npx @satelliteoflove/godot-mcp --install-addon /path/to/your/godot/project
# then: Project > Project Settings > Plugins > enable "Godot MCP"

# 2. Register the MCP server with your agent client
#    (.mcp.json in the project, or your client's config)
{
  "mcpServers": {
    "godot-mcp": { "command": "npx", "args": ["-y", "@satelliteoflove/godot-mcp"] }
  }
}

# 3. Open the project in Godot, restart the client
```

Requires **Godot 4.5+** and **Node 20+**. The Node server talks to the editor addon over a local
WebSocket on `:6550`.

**Two things to know before an agent tries to use both at once.** The editor serves one client at a
time, so a background loop holding the MCP session will block your interactive one — give the
unattended work the web path and keep MCP for the session you're sitting in front of. And godot-mcp's
addon lives in the game project while this harness lives outside it, so only the addon needs
gitignoring consideration.
