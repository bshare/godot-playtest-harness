extends Node
## TcpBridge — the DESKTOP counterpart of DebugBridge.template.gd. Exposes the
## same named actions the JS bridge puts on `window`, but over a localhost TCP
## socket, so the harness's desktop transport (src/transport/desktop.mjs) can
## drive a `--headless` desktop debug build. Wire protocol, port, and security
## posture are specified in BRIDGE_CONTRACT.md's "Desktop transport" section —
## this file is a TEMPLATE mirroring that contract.
##
## TEMPLATE. Copy to scripts/debug/TcpBridge.gd in your game, register it as an
## autoload, and replace the EXAMPLE section with your game's actions — the
## SAME action names and handler shapes as your DebugBridge.gd, so one action
## catalog serves both transports. Read BRIDGE_CONTRACT.md before editing.
##
## SECURITY: this opens NO port unless BOTH hold:
##   1. OS.is_debug_build() — a --export-release build carries nothing, and
##   2. the process was launched with the `--playtest-bridge` USER arg (after
##      Godot's `--` separator, read via OS.get_cmdline_user_args()).
## The feature gate here is deliberately NOT "web" — this bridge exists for
## desktop builds — but debug alone is not enough either: a developer casually
## running their debug build must not silently have a port open. The opt-in
## flag is what closes that gap, and the listener binds 127.0.0.1 ONLY, never
## 0.0.0.0. Any change to _ready()'s gating deserves the same scrutiny as a
## real security fix.
##
## A FOURTH LAYER: the shared token. Binding loopback keeps the LAN out; it does
## NOT keep out anything already running on this machine, and "anything" now
## includes a WEB PAGE. A page cannot open a raw socket, but it can POST to
## http://127.0.0.1:8973 as a CORS *simple request* — no preflight, no
## permission needed, and the browser sends it whether or not the page is
## allowed to read the reply. The HTTP request body lands on this socket as a
## line, and if that line happens to be valid JSON this bridge would have
## dispatched it. Every response would go into a void the page cannot read, but
## every side effect would be real.
##
## So the harness generates a random token per run, passes it as
## `--playtest-token=<t>` beside --playtest-port, and every request must carry a
## matching "token" field. A peer that gets it wrong is dropped, not just
## refused, so the port cannot be used as a guessing oracle.
##
## What the token DOES protect: a web page (which cannot read the token) and any
## local process that cannot see this game's command line.
## What it does NOT protect: anything that CAN see this game's command line —
## on most systems that is every process running as the same user, via /proc or
## the process list. This is a debug-build developer tool, and that is the
## honest edge of it. It is not an authentication system.
##
## PROTOCOL (newline-delimited JSON, one object per line, both directions):
##   request  {"id": 1, "token": "<t>", "op": "ping"}
##            {"id": 2, "token": "<t>", "op": "call", "fn": "godotDebugDumpState", "args": []}
##            {"id": 3, "token": "<t>", "op": "read", "var": "godotDebugLastState"}
##   response {"id": n, "ok": true, "result": ...}
##            {"id": n, "ok": false, "error": "..."}
## "call" dispatches by the SAME fn name the JS bridge would register on
## `window`; "read" returns the SAME var the JS bridge would write there.

## Bump on ANY breaking change to dump_state's shape — same rule, same reason
## as DebugBridge.template.gd: a scenario reading an unexpected version must
## stop rather than silently misread keys whose meaning changed.
const STATE_SCHEMA_VERSION: int = 1

## Must match src/transport/desktop.mjs's DEFAULT_DESKTOP_PORT. The transport
## passes `--playtest-port=<port>` as a user arg when the config overrides it.
const DEFAULT_PORT: int = 8973

const BRIDGE_FLAG: String = "--playtest-bridge"
const PORT_FLAG_PREFIX: String = "--playtest-port="
const TOKEN_FLAG_PREFIX: String = "--playtest-token="

## A line without a newline cannot be dispatched, so it is held. Held forever,
## an unbounded buffer is a memory bomb any local process can set off with one
## socket and a stream of bytes — no protocol knowledge required. 1 MiB is far
## more than any real request (the largest is an import_save blob, and a save
## that big has other problems) and far less than a problem.
const MAX_LINE_BYTES: int = 1048576

## Concurrent-connection ceiling. Each peer's receive buffer may legitimately
## hold up to MAX_LINE_BYTES, so peers × cap bounds the bridge's worst-case
## buffer memory. The harness opens one connection.
const MAX_PEERS: int = 8

var _server: TCPServer
var _peers: Array[StreamPeerTCP] = []
## Per-peer receive buffer, keyed by peer index-identity (the peer object).
var _rx: Dictionary = {}
## The shared secret from --playtest-token=. Empty is only reachable through
## the explicit --playtest-no-token opt-out (see _ready — without either flag
## the bridge refuses to listen at all); in that hand-driven netcat mode the
## token check in _handle_line is skipped entirely. The harness always passes
## a token.
var _token: String = ""

## The variables the JS bridge would write onto `window` — the "read" op serves
## them from here. Same names, same contract: every action MUST write its
## result into _vars via _report_action_result before returning, including on
## failure, or the runner reads the PREVIOUS action's result (the contract's
## sharpest edge — see BRIDGE_CONTRACT.md §3).
var _vars: Dictionary = {}

## Dispatch table: fn name (identical to the window name the JS bridge uses)
## -> Callable taking one Array of args. Mirrors _register_callbacks() in
## DebugBridge.template.gd.
var _actions: Dictionary = {}

## Append-only, human-readable — same rationale as DebugBridge.template.gd.
var _log: Array[String] = []
const MAX_LOG_ENTRIES: int = 500


func _ready() -> void:
	# THE security gate. Debug build AND the explicit opt-in flag, in this order.
	if not OS.is_debug_build():
		return
	var user_args := OS.get_cmdline_user_args()
	if not user_args.has(BRIDGE_FLAG):
		return

	var port := DEFAULT_PORT
	for arg in user_args:
		if arg.begins_with(PORT_FLAG_PREFIX):
			port = int(arg.trim_prefix(PORT_FLAG_PREFIX))
		elif arg.begins_with(TOKEN_FLAG_PREFIX):
			_token = arg.trim_prefix(TOKEN_FLAG_PREFIX)

	# FAIL CLOSED. The harness ALWAYS passes --playtest-token=, so a missing
	# token means a regression or a hand-launched build someone forgot about —
	# and the un-tokened bridge is drivable by every local process, including
	# (via CORS simple-request POSTs) any web page the developer has open. The
	# only signal used to be a push_warning nobody watches headless; now the
	# bridge refuses to listen. A developer who really wants to drive it by hand
	# with netcat states that intent explicitly with --playtest-no-token.
	if _token.is_empty() and not user_args.has("--playtest-no-token"):
		push_warning("[TcpBridge] refusing to listen: no --playtest-token= was passed. "
			+ "The harness always passes one; to drive the bridge by hand without a token, "
			+ "add --playtest-no-token (every local process and any open web page can then reach it).")
		return

	_register_actions()

	_server = TCPServer.new()
	# 127.0.0.1 ONLY. Binding any wider address would expose debug actions to
	# the local network, which is never what a playtest harness needs.
	var err := _server.listen(port, "127.0.0.1")
	if err != OK:
		push_warning("[TcpBridge] failed to listen on 127.0.0.1:%d (err %d); bridge not available" % [port, err])
		_server = null
		return
	print("[TcpBridge] listening on 127.0.0.1:%d — DEBUG BUILD ONLY" % port)


func _register_actions() -> void:
	# Same names the JS bridge registers on `window`, so one action catalog
	# serves both transports unchanged.
	_actions["godotDebugDumpState"] = _on_dump_state
	_actions["godotDebugLegalMoves"] = _on_legal_moves
	_actions["godotDebugStateHash"] = _on_state_hash
	_actions["godotDebugExportSave"] = _on_export_save
	_actions["godotDebugImportSave"] = _on_import_save

	# --- EXAMPLE: replace with your game's actions -------------------------
	_actions["godotDebugExampleAction"] = _on_example_action


func _process(_delta: float) -> void:
	if _server == null:
		return

	while _server.is_connection_available():
		var peer := _server.take_connection()
		if peer != null:
			# Cap concurrent peers: each buffered peer may hold up to
			# MAX_LINE_BYTES, so unbounded accepts let one local process turn
			# open sockets into memory pressure. The harness uses one
			# connection; eight leaves room for a human poking alongside it.
			if _peers.size() >= MAX_PEERS:
				push_warning("[TcpBridge] refusing connection: %d peers already connected" % _peers.size())
				peer.disconnect_from_host()
				continue
			peer.set_no_delay(true)
			_peers.append(peer)
			_rx[peer] = PackedByteArray()

	# Poll every peer: drain bytes, split on newlines, dispatch each line.
	for i in range(_peers.size() - 1, -1, -1):
		var peer := _peers[i]
		peer.poll()
		var status := peer.get_status()
		if status != StreamPeerTCP.STATUS_CONNECTED:
			if status != StreamPeerTCP.STATUS_CONNECTING:
				_rx.erase(peer)
				_peers.remove_at(i)
			continue
		var available := peer.get_available_bytes()
		if available > 0:
			# BYTES, not text. get_utf8_string(available) decoded exactly the
			# bytes arrived so far as UTF-8, so a multibyte character split
			# across two TCP segments became U+FFFD replacement chars —
			# permanently corrupting the buffered request (non-ASCII save blobs
			# were the reproducer). Buffer raw bytes, split on the newline BYTE,
			# decode only complete lines.
			var recv: Array = peer.get_partial_data(available)
			var buf: PackedByteArray = _rx.get(peer, PackedByteArray())
			if recv[0] == OK:
				buf.append_array(recv[1])
			var dropped := false
			while true:
				var nl := buf.find(10) # "\n"
				if nl < 0:
					break
				var line := buf.slice(0, nl).get_string_from_utf8().strip_edges()
				buf = buf.slice(nl + 1)
				if line.length() > 0:
					# false means "this peer failed the token check" — stop
					# reading it mid-buffer rather than processing the rest of
					# what an unauthenticated sender pipelined.
					if not _handle_line(peer, line):
						_drop_peer(i, "bad token")
						dropped = true
						break
			if dropped:
				continue
			# CAP THE LEFTOVER. What remains here is a partial line — bytes with
			# no newline yet — and it is held until one arrives. Unbounded, that
			# is a memory bomb: one socket, no protocol knowledge, just bytes.
			# Checked AFTER draining, so a legitimate burst of complete requests
			# in one chunk is never punished for its total size; only the
			# undelimited remainder counts.
			if buf.size() > MAX_LINE_BYTES:
				_send(peer, {
					"id": null,
					"ok": false,
					"error": "request line exceeded %d bytes with no newline; disconnecting" % MAX_LINE_BYTES,
				})
				_drop_peer(i, "oversized request line")
				continue
			_rx[peer] = buf


## Removes a peer by index and closes its socket. Safe inside the descending
## _process loop: removing index i cannot shift any index still to be visited.
func _drop_peer(i: int, why: String) -> void:
	var peer := _peers[i]
	push_warning("[TcpBridge] dropping peer: %s" % why)
	_rx.erase(peer)
	_peers.remove_at(i)
	peer.disconnect_from_host()


## Returns false when the peer must be DROPPED (a failed token). Returns true
## otherwise, including for ordinary protocol errors — an unknown fn is a
## mistake by a caller who already proved it belongs here, and answering it is
## how the caller learns what it got wrong.
func _handle_line(peer: StreamPeerTCP, line: String) -> bool:
	var parsed: Variant = JSON.parse_string(line)
	if typeof(parsed) != TYPE_DICTIONARY:
		_send(peer, {"id": null, "ok": false, "error": "request is not a JSON object: %s" % line.left(120)})
		return true
	var req: Dictionary = parsed
	var id: Variant = req.get("id")
	var op: Variant = req.get("op")

	# THE TOKEN, checked before `op` is so much as looked at. A wrong token gets
	# one flat message and a disconnect — never a hint about length, never a
	# per-op difference, and never a second guess on the same connection. The
	# port must not be usable as an oracle.
	#
	# An empty _token means the harness passed no --playtest-token=, which is
	# the hand-driven netcat case; the check is then skipped and _ready() has
	# already warned about it. It does NOT mean "accept any token".
	if not _token.is_empty() and str(req.get("token", "")) != _token:
		_send(peer, {"id": id, "ok": false, "error": "bad or missing token"})
		return false

	match op:
		"ping":
			_send(peer, {"id": id, "ok": true, "result": "pong"})
		"call":
			var fn := str(req.get("fn", ""))
			if not _actions.has(fn):
				_send(peer, {"id": id, "ok": false, "error": "unknown fn \"%s\"" % fn})
				return true
			var args: Variant = req.get("args", [])
			if typeof(args) != TYPE_ARRAY:
				_send(peer, {"id": id, "ok": false, "error": "\"args\" must be an array"})
				return true
			# Clear the previous result BEFORE dispatch: an action that forgets
			# to report then yields null — visibly wrong — instead of the
			# PREVIOUS action's result, which is the exact silent-stale-result
			# failure BRIDGE_CONTRACT.md §3 documents as the contract's sharpest
			# edge. The web bridge cannot do this (it has no dispatch chokepoint
			# to clear from); here we can, so we do.
			_vars["godotDebugLastActionResult"] = null
			# Handlers have the SAME signature the JS bridge's callbacks do —
			# one Array of positional args — and report via
			# _report_action_result, so a game can share handler bodies between
			# its DebugBridge.gd and this file.
			(_actions[fn] as Callable).call(args)
			# The response's result is what the action just reported — the
			# desktop analogue of the runner reading the result var after each
			# call. dump_state-style handlers that only write a state var
			# report nothing; result is then null and the runner follows up
			# with a "read".
			_send(peer, {"id": id, "ok": true, "result": _vars.get("godotDebugLastActionResult")})
		"read":
			var var_name := str(req.get("var", ""))
			if var_name.is_empty():
				_send(peer, {"id": id, "ok": false, "error": "\"read\" requires \"var\""})
				return true
			# An unset var reads as null — same as an unset window var in the
			# browser. NOT an error: the runner distinguishes "no result yet"
			# from "bridge broken" by exactly this.
			_send(peer, {"id": id, "ok": true, "result": _vars.get(var_name)})
		_:
			_send(peer, {"id": id, "ok": false, "error": "unknown op %s" % JSON.stringify(op)})
	return true


func _send(peer: StreamPeerTCP, response: Dictionary) -> void:
	peer.put_data((JSON.stringify(_jsonable(response)) + "\n").to_utf8_buffer())


## JSON has no representation for NaN/Infinity — JSON.stringify emits the bare
## tokens `nan`/`inf`, which is not valid JSON and throws a SyntaxError on the
## receiving (JS) side, hard-crashing the step for a value that is a normal
## outcome of game math (e.g. a division that legitimately hits zero). Map
## every non-finite float to null before it reaches JSON.stringify, same
## rationale and same shape as playtest_bridge.gd's _jsonable().
func _jsonable(value: Variant, depth: int = 0) -> Variant:
	if depth > 32:
		# A Dictionary/Array containing itself (legal in GDScript) would recurse
		# forever and stack-overflow the whole bridge mid-dump; depth-cap instead.
		return "<max depth exceeded - possible cycle>"
	match typeof(value):
		TYPE_FLOAT:
			if is_nan(value) or is_inf(value):
				return null
			return value
		TYPE_ARRAY:
			var out_arr: Array = []
			for v in value:
				out_arr.append(_jsonable(v, depth + 1))
			return out_arr
		TYPE_DICTIONARY:
			var out_dict: Dictionary = {}
			for k in value:
				out_dict[str(k)] = _jsonable(value[k], depth + 1)
			return out_dict
		_:
			return value


# =============================================================================
# The result channel — read BRIDGE_CONTRACT.md §3
# =============================================================================

## EVERY action must call this before returning, INCLUDING on the failure path.
## An action that returns without reporting leaves the previous action's result
## in _vars, so the runner reads a stale result and the scenario reports the
## wrong outcome while appearing to pass. This has happened for real on the web
## bridge; the desktop bridge inherits the same contract and the same test
## obligation: assert every registered action reports its own result, starting
## when you add the second action, not the twentieth.
func _report_action_result(result: Dictionary) -> void:
	_vars["godotDebugLastActionResult"] = result


func _note(entry: String) -> void:
	_log.append(entry)
	if _log.size() > MAX_LOG_ENTRIES:
		_log.remove_at(0)


# =============================================================================
# Inspection
# =============================================================================

func _on_dump_state(_args: Array) -> void:
	_vars["godotDebugLastState"] = build_state()


## Return everything a scenario might reasonably assert on — same schema, same
## version discipline as your DebugBridge.gd. Ideally both files call ONE
## shared build_state() so the two transports cannot drift apart.
func build_state() -> Dictionary:
	return {
		"version": STATE_SCHEMA_VERSION,
		# --- EXAMPLE: replace with real game state ---
		"run": {
			"state": "IN_PROGRESS",  # IN_PROGRESS | WON | LOST
			"seed": 0,
		},
		"log": _log,
	}


func _on_legal_moves(_args: Array) -> void:
	var moves: Array = []
	# --- EXAMPLE ---
	# for i in hand.size():
	#     if hand[i].is_playable():
	#         moves.append({"action": "play_card", "args": {"hand_index": i}})
	_report_action_result({"action": "legal_moves", "success": true, "moves": moves})


func _on_state_hash(_args: Array) -> void:
	var h: int = 0
	# h = hash([seed, node, air, streams.map(s => s.offset)])
	_report_action_result({"action": "state_hash", "success": true, "hash": h})


# =============================================================================
# Save export/import — OPTIONAL, enables SESSION continuity across runs
# =============================================================================

func _on_export_save(_args: Array) -> void:
	var save_json: String = ""  # SaveSystem.export_to_json()
	_report_action_result({"action": "export_save", "success": true, "save_json": save_json})


func _on_import_save(args: Array) -> void:
	if args.size() < 1:
		_report_action_result({"action": "import_save", "success": false, "reason": "missing save_json"})
		return
	var ok: bool = true  # SaveSystem.import_from_json(str(args[0]))
	_report_action_result({"action": "import_save", "success": ok})


# =============================================================================
# EXAMPLE ACTION — the shape every game action follows
# =============================================================================

## Identical structure to DebugBridge.template.gd's example, on purpose:
##   1. validate arity, report failure, return
##   2. do the thing
##   3. report the outcome, success or not
##   4. note it in the log
## One difference from the web bridge: Dictionary-valued args arrive here as
## real Dictionaries (JSON travels the socket natively), not as JSON strings —
## the catalog's `encode: "json"` slots still arrive encoded, for parity, so
## parse them the same way your DebugBridge.gd does.
func _on_example_action(args: Array) -> void:
	if args.size() < 1:
		_report_action_result({
			"action": "example_action",
			"success": false,
			"reason": "expected 1 argument, got %d" % args.size(),
		})
		return

	var target_id: String = str(args[0])

	# ... do the thing, and get a real success/failure out of it ...
	var ok: bool = true

	# Report the REAL outcome. An action that reports success unconditionally is
	# worse than one that fails, because a scenario asserting on it passes while
	# testing nothing.
	_report_action_result({"action": "example_action", "success": ok, "target": target_id})
	_note("example_action(%s) -> %s" % [target_id, ok])
