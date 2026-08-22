# The Action Catalog

`playtest.actions.json` lives in the **game** repo and is the single source of truth for what the
harness can drive: how each action is called, and how a scenario using it is validated.

> **Why one file and not two.** In the original this was two hand-maintained JavaScript tables —
> `ACTION_DEFS` (the call convention) and `ACTION_ARG_SPECS` (validation) — carrying the same
> information in different shapes. Adding an action meant editing both, and nothing checked they
> agreed, so they could drift silently. One declarative catalog removes that whole failure mode, and
> makes the runner game-agnostic as a side effect.

---

## Format

```jsonc
{
  "catalog_version": 1,
  "game": "my-game",
  "state_schema_version": 3,        // optional; the runner warns on a mismatch

  "actions": {
    "place_module": {
      "fn": "godotDebugPlaceModule",          // the window function the bridge registers
      "positional": [                          // args → the function's parameter list, in order
        { "name": "module_id" },
        { "name": "x" },
        { "name": "y" },
        { "name": "rotation_steps", "default": 0 }
      ],
      "required": ["module_id", "x", "y"],     // missing → hard validation error
      "optional": ["rotation_steps"]           // unknown keys → warning
    },

    "force_set_resources": {
      "fn": "godotDebugForceSetResources",
      "positional": [
        { "name": "resources", "encode": "json", "default": {} }
      ],
      "required": ["resources"],
      "optional": []
    }
  },

  "runner_actions": {                          // pseudo-actions the runner handles itself
    "dump_state":  { "required": [], "optional": [] },
    "screenshot":  { "required": [], "optional": [] },
    "mouse_click": { "required": ["x", "y"], "optional": ["steps"] }
  }
}
```

## Positional slots

Each entry in `positional` is one argument to the bridge function, in order:

| Form | Meaning |
| :--- | :--- |
| `{ "name": "x" }` | Pass `args.x` |
| `{ "name": "x", "default": 0 }` | Pass `args.x`, or `0` when absent or null |
| `{ "name": "r", "encode": "json" }` | `JSON.stringify(args.r)` — for functions taking a JSON **string** rather than an object, which is how dictionary-valued args cross `JavaScriptBridge` |
| `{ "bundle": true, "encode": "json" }` | `JSON.stringify(args)` — the **whole** args object as one string. For bridges with a single generic handler per action |
| `{ "literal": true }` | A fixed value that doesn't come from `args` at all |

**`bundle` exists so that a one-payload bridge still gets real validation.** Some bridges register
one handler shape for every action — `godotDebugPlayCard('{"card":"pry_bar","target":0}')` — and the
tempting catalog entry is a single opaque slot. Do not write that: it makes `required` and `optional`
meaningless, because the catalog no longer knows the payload has any structure, and every typo inside
it reaches the game as a silently-ignored key.

With `bundle`, the slot describes the *call* and `required`/`optional` describe the *contents*, so
both stay true:

```jsonc
"play_card": {
  "fn": "godotDebugPlayCard",
  "positional": [{ "bundle": true, "encode": "json" }],
  "required": ["card"],
  "optional": ["target", "hand_index"]
}
```

## `runner_actions`

Pseudo-actions the runner implements without touching the bridge: `dump_state`, `screenshot`,
`mouse_move`, `mouse_click`, and any cell-coordinate variants a grid game needs.

**`wait` is deliberately absent from this table.** Its only parameter, `ms`, is a **top-level step
key**, not an `args` key — and that asymmetry is exactly what makes `{"action": "wait", "args":
{"ms": 5000}}` a natural thing to write by analogy with every other action. It used to silently
sleep the 1000ms default. The runner special-cases `wait` so that mistake is a hard error.

## Built-in generic actions

Six actions ship built into the runner without any catalog entry, mirroring the generic bridge
(`addons/playtest_bridge/`, `BRIDGE_CONTRACT.md` §10) — so a game that enabled the addon is
scriptable before it has written a catalog at all:

| Action | Args | Bridge function |
| :--- | :--- | :--- |
| `dump_controls` | — | `godotDebugDumpControls` (the parsed control tree lands in the step record, like `dump_state`) |
| `click_control` | `path` | `godotDebugClickControl` |
| `press_action` | `action_name`, `pressed` (default `true`) | `godotDebugPressAction` |
| `send_key` | `keycode`, `pressed` (default `true`), `unicode` (default: `keycode` itself when printable ASCII, else 0 — pass explicitly for lowercase/shifted characters a keycode can't express) | `godotDebugSendKey` |
| `set_slider` | `path`, `value` | `godotDebugSetSlider` |
| `select_tab` | `path`, `tab_index` | `godotDebugSelectTab` |

They validate like any catalog action (missing required arg → error; unknown `args` key →
warning), work over **both** transports (they are plain bridge calls), and — because they produce
a real `{"success": ...}` result — accept `expect`/`expect_reason`. Precedence is deliberate: a
catalog (`actions` or `runner_actions`) that defines one of these names **wins**, in validation
and at runtime, so adopting the addon never shadows a hand-written action.

## `state_independent`

A top-level array naming the actions whose legality never depends on state, so `legal_moves` is
correct to omit them and a driving agent is wrong to conclude they are illegal:

```jsonc
{
  "state_independent": ["start_run", "reset", "screenshot", "dump_state"]
}
```

See `BRIDGE_CONTRACT.md` §6.1 for why this is not a nicety. Without it, an agent testing where the
software stops accepting input infers that an accepted-but-unlisted action is a bug, and files one.

## Address by identity, not by position

**If an action names a thing, take the thing's id. Never take its index into a list the action itself
mutates.**

The failing shape: `play_card` takes a `hand_index`, and playing a card removes it from the hand. A
scripted sequence written from one `legal_moves` snapshot is therefore correct only for its first
step — every later index has silently shifted by one. On one turn-based deckbuilder this made roughly a
third of blind multi-card turns land on the wrong card, and the runs still *succeeded*, because every
shifted index was itself a legal move. Nothing errored. The playtest simply did something other than
what it recorded.

Two properties make it hard to catch and worth designing out:

- **A human never meets it.** A person clicks the card in front of them; they re-read the hand for
  free, between every click. The interface is only wrong for something that plans a turn and then
  executes it, which is exactly what an agent does.
- **It fails as a wrong answer, not as an error.** An out-of-range index would be caught in a day.
  An in-range one that means a different card produces a clean run bundle and a false conclusion.

So prefer `{ "name": "card_id" }` over `{ "name": "hand_index" }`, and if the game genuinely needs a
position — two identical cards in hand, and it matters which — take **both**, and have the bridge
reject the call when the id at that index is not the id it was given. That turns a silent misplay
into a loud refusal, which is the trade this whole harness exists to make.

## Validation rules the catalog drives

1. **Unknown action name** → error.
2. **Missing `required` arg** (absent or null) → error.
3. **Unknown key inside `args`** → warning. Probably a typo, but it could be a deliberately-ignored
   extra, so it doesn't block the run.
4. **A top-level step key matching any arg name used by any action** → error, always, regardless of
   which action the step names. The danger is precisely that such a key reads as plausible.
5. **`args.ms` on a `wait` step** → error.

Rules 4 and 5 exist because both mistakes shipped, passed, and produced false conclusions in real
playtests.

## Generating a catalog for an existing game

If you're extracting from a codebase that already has the two-table shape, derive the catalog by
**introspecting the real `buildArgs` functions** rather than transcribing them — 40-odd actions
transcribed by hand is exactly where a wrong arg name slips in.

Call each `buildArgs` twice with a Proxy: once returning a unique marker per key (which reveals
position → argument name), once returning `undefined` (which makes any `?? default` surface as the
returned value). Combining the two passes gives name and default per slot. Watch for args wrapped in
a transform — `JSON.stringify(a.resources ?? {})` leaves the marker embedded in a string rather than
returning it intact, which is what `encode: "json"` exists to represent.
