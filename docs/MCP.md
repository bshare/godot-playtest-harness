# MCP server — the harness verbs for any agent client

`src/mcp_server.mjs` exposes the harness CLIs as an [MCP](https://modelcontextprotocol.io)
server over stdio, so any MCP-capable client — Claude Code, Claude Desktop, or anything else
speaking the protocol — can drive scenarios, batches, coverage and retention **without being
primed with this repo's skills**. The tool descriptions carry enough for an agent arriving
cold: what each tool answers, and when to prefer it over the others.

Positioning, same as [CHOOSING_YOUR_TOOLING.md](../CHOOSING_YOUR_TOOLING.md):
[godot-mcp](https://github.com/satelliteoflove/godot-mcp) is the editor **inner** loop; this
is the artifact **outer** loop — headless, parallel, seeded, against the export players
actually receive. Same protocol, complementary jobs, and a client can register both.

## Registering it

Add to your project's `.mcp.json` (or the equivalent client config), pointing at your clone:

```json
{
  "mcpServers": {
    "godot-playtest": {
      "command": "node",
      "args": ["/home/you/Develop/godot-playtest-harness/src/mcp_server.mjs"]
    }
  }
}
```

No arguments, no environment: which game a call targets is per-call, not per-registration
(see `project_dir` below). The transport is MCP's stdio transport — newline-delimited
JSON-RPC 2.0, protocol version `2025-06-18` — implemented in the file itself with no
dependencies beyond Node, so registration needs nothing but the clone and `node`.

The tools that reach a browser (`run_scenario`, `play_run`) additionally need the harness's
one real dependency installed in the clone: `npm install && npx playwright install chromium`.
`validate_scenarios` works without either — that cheapness is its point.

## The `project_dir` convention

**Every tool requires `project_dir`:** the absolute path to the game repo root, the directory
containing `playtest.config.json`. The server sets the child process's cwd to it, which is
exactly how the CLIs already resolve the config, the action catalog, the build and `runs/`.

There is deliberately no default and no server-level setting. An MCP server's own cwd is
wherever the host launched it, and a wrapper that guesses which game you meant is how
`control_server.mjs` once drove the wrong build and reported success (the comment
block in that file tells the story). Stating the game on every call is the fix.

Paths in other arguments (`scenario_path`, `run_dir`, `runs_dir`, and paths inside
`passthrough`) are relative to `project_dir`.

## Tools

| Tool | Wraps | What it answers |
| :--- | :--- | :--- |
| `validate_scenarios` | `run_scenario.mjs --validate` | Is this scenario well-formed against the game's catalog? Milliseconds, no browser, no build. Run before every live run. |
| `run_scenario` | `run_scenario.mjs` | Does this flow work in a real browser, and what does the player see? Writes a run bundle (`manifest.json` + screenshots). `headed` and `session` map to the `HEADED`/`SESSION` env vars. |
| `play_run` | `play_run.mjs` | Play a whole run turn by turn from `legal_moves`; also `--parity`, the sim-vs-browser check. Args pass through verbatim. |
| `batch` | `batch.mjs` | What happens across N seeded headless runs — balance numbers, `--verify-determinism`, `--verify-isolation`. Args pass through verbatim. |
| `coverage` | `coverage.mjs` | What did a pass of run bundles *never* touch? Distinguishes "no findings" from "never looked". Args pass through verbatim. |
| `prune_run` | `prune_run.mjs` | Retention for one finished bundle: cited screenshots kept, the rest tombstoned. Refuses any bundle outside its own runs tree. `dry_run` supported. |
| `sweep_runs` | `sweep_runs.mjs` | Age and budget sweep over a whole `runs/` directory. Refuses to sweep anything but the project's own runs tree. `dry_run` supported. |

The passthrough tools (`play_run`, `batch`, `coverage`) take their CLI flags verbatim as an
array of strings, because those CLIs have rich, evolving flag surfaces and mirroring each
flag into a JSON schema would guarantee drift. The schemas carry worked examples.

Every tool accepts `timeout_ms` (default 300000). On expiry the WHOLE process tree is killed
— not just the immediate child, but anything it spawned (a `godot --headless` grandchild
included) — and the call returns a timeout error carrying whatever output arrived. The
protocol never hangs on a stuck run, nothing keeps running unmonitored past its timeout, and
a partially-written run bundle survives for inspection. Raise it for long batches.

Results come back as text content: the exit code, stdout, and stderr of the underlying
script. `isError` mirrors the exit code, so a failed validation or a failed scenario step is
a tool error carrying the script's own diagnostics, and — coverage being the documented
exception that always exits 0 — success means what the CLI means by it.

## Worked example

A full session, one JSON-RPC message per line (`->` client to server, `<-` back):

```
-> {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"my-agent","version":"1.0"}}}
<- {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"godot-playtest-harness","version":"0.1.0"}}}
-> {"jsonrpc":"2.0","method":"notifications/initialized"}
-> {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"validate_scenarios","arguments":{"project_dir":"/home/you/my-game","patterns":["scenarios/*.json"]}}}
<- {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"exit code: 0\n--- stdout ---\nscenarios/first_repair.json: OK\n..."}],"isError":false}}
```

An MCP client does the framing for you; the wire form is shown so the transport is
inspectable — you can drive the server from a terminal with nothing but `node` and a pipe.

## Out of scope for v1: interactive sessions

`control_server.mjs` — the persistent look/decide/act loop (`/reset`, `/act`, `/state`
against one continuous browser session) — is **not** wrapped, deliberately. Those verbs only
make sense against a session that outlives a single `tools/call`: something must own the
browser between calls, tie its lifetime to the MCP session, and guarantee it dies when the
client does. This stateless spawn-per-call wrapper has no such lifecycle — wrapping the
interactive loop in it would leak a headless Chromium on every client crash, and an
orphaned-browser leak is strictly worse than a missing feature. When session lifecycle
lands (start_session/act/end_session tools holding one `control_server.mjs` child, killed on
stdin close), the interactive loop is the first thing it carries. Until then, interactive
play uses `control_server.mjs` directly, per its own header comment.
