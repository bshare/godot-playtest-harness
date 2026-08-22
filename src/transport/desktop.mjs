// Desktop transport — drives a --headless DESKTOP debug build over a local TCP
// socket, so games that don't ship web can still use the harness. The game
// side is godot/tcp_bridge.template.gd; the wire protocol and security posture
// are specified in BRIDGE_CONTRACT.md's "Desktop transport" section.
//
// Same interface as transport/browser.mjs (see the header there). Differences
// a caller must handle:
//
//   * `page` is null — mouse/canvas actions and anything measuring the live
//     canvas cannot work here, and the runner fails those steps loudly.
//   * screenshot() returns null — desktop headless has no capture. The runner
//     records `screenshot_skipped: "desktop transport"` rather than failing.
//   * consoleErrors() collects the game process's stderr lines — Godot writes
//     script errors and push_error output there, which is the closest desktop
//     analogue to browser console errors.
//
// Wire protocol (newline-delimited JSON, one object per line, both ways). Every
// request carries the session token — see the SECURITY note below:
//
//   -> {"id": 1, "token": "<t>", "op": "ping"}
//   <- {"id": 1, "ok": true, "result": "pong"}
//   -> {"id": 2, "token": "<t>", "op": "call", "fn": "godotDebugDumpState", "args": []}
//   <- {"id": 2, "ok": true, "result": {...the action's reported result...}}
//   -> {"id": 3, "token": "<t>", "op": "read", "var": "godotDebugLastState"}
//   <- {"id": 3, "ok": true, "result": {...parsed value, or null if unset...}}
//   <- {"id": 4, "ok": false, "error": "unknown fn \"godotDebugTypo\""}
//
// fn/var names are IDENTICAL to what the JS bridge exposes on `window`, so one
// action catalog serves both transports unchanged.
//
// SECURITY. The bridge binds loopback, which keeps the LAN out and does nothing
// about this machine. What lives on this machine now includes a web page: a
// page cannot open a raw socket, but it can POST to http://127.0.0.1:8973 as a
// CORS simple request — no preflight, sent regardless of whether the page may
// read the reply — and the HTTP body arrives here as a line that may well parse
// as JSON. So this transport generates a random token per run and passes it to
// the game as `--playtest-token=<t>` beside --playtest-port; the bridge drops
// any peer whose request does not carry it. See BRIDGE_CONTRACT.md §8 for what
// that does and does not buy.

import net from "node:net";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

export const DEFAULT_DESKTOP_PORT = 8973;

// The Node side of the same unbounded-buffer problem the bridge has: bytes with
// no newline are held until one arrives, and "held forever" is a memory bomb.
// Whatever is on the other end of this socket is not necessarily the game.
export const MAX_LINE_BYTES = 1048576;

export function createDesktopTransport() {
	let proc = null;
	let socket = null;
	let port = DEFAULT_DESKTOP_PORT;
	let readyTimeoutMs = 20000;
	// Every call/read gets a bound. Without one, a game that wedges — an
	// infinite loop in a handler, a modal dialog the headless build cannot
	// dismiss, a deadlocked signal — leaves the runner awaiting a promise that
	// will never settle, with no output and no timeout: the run simply hangs
	// until someone notices, and CI notices after its whole job budget. The ping
	// in waitReady() has always had a timeout; the calls that do the actual work
	// did not. `desktop.call_timeout_ms` overrides it for a game with a
	// legitimately slow action (a long save, a big procedural generation).
	let callTimeoutMs = 30000;
	let stopped = false;
	// The per-run shared secret. Generated here, handed to the game on its
	// command line, and attached to every request. Empty ONLY when attaching to
	// a bridge this transport did not spawn (the tests' fake server, or a game
	// the developer already had running) — in that case we cannot know what
	// token it was given, so we send none and it is up to that bridge whether
	// to require one.
	let token = "";
	let nextId = 1;
	let buffer = "";
	const pending = new Map(); // id -> { resolve, reject, what }
	const consoleErrors = [];
	let procExit = null; // { code, signal } once the game process dies

	function failAllPending(err) {
		for (const [, entry] of pending) entry.reject(err);
		pending.clear();
	}

	function handleData(chunk) {
		buffer += chunk;
		let idx;
		while ((idx = buffer.indexOf("\n")) !== -1) {
			// (cap checked after the drain below — see MAX_LINE_BYTES)
			const line = buffer.slice(0, idx).trim();
			buffer = buffer.slice(idx + 1);
			if (!line) continue;
			let msg;
			try {
				msg = JSON.parse(line);
			} catch {
				// A non-JSON line on the protocol socket is a bridge bug worth
				// surfacing, but it must not desync every in-flight request.
				consoleErrors.push({ text: `[tcp_bridge] unparseable protocol line: ${line.slice(0, 200)}`, timestamp: new Date().toISOString() });
				continue;
			}
			const entry = pending.get(msg.id);
			if (!entry) continue; // unsolicited / already timed out
			pending.delete(msg.id);
			if (msg.ok === true) {
				entry.resolve(msg.result ?? null);
			} else {
				entry.reject(new Error(`tcp_bridge refused ${entry.what}: ${msg.error ?? JSON.stringify(msg)}`));
			}
		}
		// The leftover is a PARTIAL line, held until its newline arrives. Capped
		// after the drain, so a burst of complete responses in one chunk is
		// never punished for its total size — only undelimited bytes count.
		if (buffer.length > MAX_LINE_BYTES) {
			const err = new Error(
				`tcp_bridge sent ${buffer.length} bytes with no newline (cap ${MAX_LINE_BYTES}) — ` +
				`this is not the protocol. Something other than the game may own port ${port}.`);
			buffer = "";
			failAllPending(err);
			if (socket) { socket.destroy(); socket = null; }
		}
	}

	function wireSocket(sock) {
		socket = sock;
		socket.setEncoding("utf8");
		socket.on("data", handleData);
		socket.on("error", (err) => failAllPending(new Error(`desktop transport socket error: ${err.message}`)));
		socket.on("close", () => {
			if (pending.size > 0) failAllPending(new Error("desktop transport socket closed with requests in flight — did the game crash? Check manifest.console_errors for its stderr."));
			socket = null;
		});
	}

	// One connection attempt. Resolves with a connected socket or rejects.
	function connectOnce(timeoutMs) {
		return new Promise((resolve, reject) => {
			const sock = net.createConnection({ host: "127.0.0.1", port });
			const timer = setTimeout(() => {
				sock.destroy();
				reject(new Error("connect attempt timed out"));
			}, timeoutMs);
			sock.once("connect", () => { clearTimeout(timer); resolve(sock); });
			sock.once("error", (err) => { clearTimeout(timer); reject(err); });
		});
	}

	function send(op, fields, what, timeoutMs = null) {
		return new Promise((resolve, reject) => {
			if (!socket) {
				reject(new Error(`desktop transport is not connected (sending ${what}) — did start()/waitReady() succeed?`));
				return;
			}
			const id = nextId++;
			let timer = null;
			if (timeoutMs !== null) {
				timer = setTimeout(() => {
					pending.delete(id);
					// Name what was in flight and what else was waiting behind
					// it. "timed out" alone sends the reader to the game with no
					// idea which action to look at, and a wedge that strands
					// three concurrent requests looks identical to one that
					// strands one.
					const others = [...pending.values()].map((e) => e.what);
					reject(new Error(
						`${what} got no response within ${timeoutMs}ms — the game is not answering its ` +
						`tcp_bridge. Usual causes: the action's handler is blocking (an infinite loop, a ` +
						`modal await), or the process is stopped at a breakpoint.` +
						(others.length ? ` Also in flight: ${others.join(", ")}.` : "") +
						` Raise playtest.config.json "desktop": {"call_timeout_ms": ...} if this action is ` +
						`legitimately slow. Check manifest.console_errors for the game's stderr.`));
				}, timeoutMs);
			}
			pending.set(id, {
				what,
				resolve: (v) => { if (timer) clearTimeout(timer); resolve(v); },
				reject: (e) => { if (timer) clearTimeout(timer); reject(e); },
			});
			// The token rides on every request, not just the first: the bridge
			// checks each line independently, so there is no session state for
			// a hijacked socket to inherit.
			socket.write(JSON.stringify({ id, ...(token ? { token } : {}), op, ...fields }) + "\n");
		});
	}

	return {
		kind: "desktop",
		// No Playwright page. The runner's mouse/canvas actions check for this
		// and fail loudly — never silently — when it is null.
		get page() { return null; },

		// config.desktop: { binary, args, port, ready_timeout_ms, call_timeout_ms }
		//
		// `binary` is the game's DEBUG desktop build. If it is absent the
		// transport ATTACHES to an already-running bridge on the port instead of
		// spawning — that is how the unit tests drive this file against a fake
		// server, and it also covers "the developer already has the game up".
		async start(config) {
			const d = config.desktop ?? {};
			port = Number(d.port ?? DEFAULT_DESKTOP_PORT);
			readyTimeoutMs = Number(d.ready_timeout_ms ?? 20000);
			callTimeoutMs = Number(d.call_timeout_ms ?? 30000);

			if (d.binary) {
				const args = ["--headless", ...(d.args ?? [])];
				// The TCP bridge's security gate requires the opt-in flag as a
				// USER arg (after Godot's `--` separator) — see
				// BRIDGE_CONTRACT.md "Desktop transport". Append it, plus the
				// port and the session token, unless the config already carries
				// the flag itself.
				if (!args.includes("--playtest-bridge")) {
					token = randomBytes(16).toString("hex");
					if (!args.includes("--")) args.push("--");
					args.push("--playtest-bridge", `--playtest-port=${port}`, `--playtest-token=${token}`);
				}
				// The token is REDACTED from this line. It is a secret whose
				// whole job is to be unguessable by anything that cannot read
				// this process's command line, and a runner log is pasted into
				// bug reports, CI artifacts and chat windows routinely.
				console.log(`Spawning ${d.binary} ${args.map((a) =>
					a.startsWith("--playtest-token=") ? "--playtest-token=<redacted>" : a).join(" ")}...`);
				proc = spawn(d.binary, args, { stdio: ["ignore", "ignore", "pipe"] });
				proc.stderr.setEncoding("utf8");
				let errBuf = "";
				proc.stderr.on("data", (chunk) => {
					errBuf += chunk;
					let idx;
					while ((idx = errBuf.indexOf("\n")) !== -1) {
						const line = errBuf.slice(0, idx).trimEnd();
						errBuf = errBuf.slice(idx + 1);
						if (line.trim().length > 0) {
							consoleErrors.push({ text: line, timestamp: new Date().toISOString() });
						}
					}
				});
				proc.on("exit", (code, signal) => { procExit = { code, signal }; });
			} else {
				console.log(`No desktop.binary configured — attaching to an already-running bridge on 127.0.0.1:${port}...`);
			}
		},

		// Retry connect-then-ping until the bridge answers, or the timeout
		// passes, or the game process dies. A connection ALONE is not readiness
		// — something else could own the port — only a ping answered
		// {"ok": true} is.
		async waitReady() {
			const timeoutMs = readyTimeoutMs;
			const deadline = Date.now() + timeoutMs;
			console.log(`Waiting for tcp_bridge to answer on 127.0.0.1:${port}...`);
			let lastErr = null;
			while (Date.now() < deadline) {
				if (procExit !== null) {
					throw new Error(
						`the game process exited (code ${procExit.code}, signal ${procExit.signal}) before the ` +
						`tcp_bridge answered. Usual causes: not a DEBUG build, the tcp_bridge autoload is not ` +
						`registered, or the export crashed on boot — check manifest.console_errors for its stderr.`);
				}
				try {
					const sock = await connectOnce(1000);
					wireSocket(sock);
					await send("ping", {}, "ping", 2000);
					return; // the bridge answered — ready
				} catch (err) {
					lastErr = err;
					if (socket) { socket.destroy(); socket = null; }
					await sleep(250);
				}
			}
			throw new Error(
				`tcp_bridge never answered on 127.0.0.1:${port} within ${timeoutMs}ms (last error: ` +
				`${lastErr?.message ?? "none"}). The bridge only opens its port on a DEBUG build launched ` +
				`with the --playtest-bridge user arg (after Godot's "--" separator) — see BRIDGE_CONTRACT.md ` +
				`"Desktop transport".`);
		},

		async invoke(fnName, args) {
			await send("call", { fn: fnName, args: args ?? [] }, `call ${fnName}`, callTimeoutMs);
		},

		async call(fnName, args) {
			return send("call", { fn: fnName, args: args ?? [] }, `call ${fnName}`, callTimeoutMs);
		},

		async readVar(varName) {
			return send("read", { var: varName }, `read ${varName}`, callTimeoutMs);
		},

		// The desktop twin of the browser transport's invokeAndRead. NO settle
		// is needed or wanted: tcp_bridge dispatches the handler synchronously
		// inside the "call" round-trip, so by the time the response lands the
		// var is already written. A sleep here would be a pure tax.
		async invokeAndRead(fnName, args, varName) {
			await send("call", { fn: fnName, args: args ?? [] }, `call ${fnName}`, callTimeoutMs);
			return send("read", { var: varName }, `read ${varName}`, callTimeoutMs);
		},

		// Desktop headless has no capture. Returning null tells the runner to
		// record `screenshot_skipped: "desktop transport"` on the step instead
		// of failing it.
		async screenshot(_filePath) {
			return null;
		},

		consoleErrors() {
			return consoleErrors;
		},

		// Evidence artifacts (video/trace) are a browser-transport feature; a
		// desktop run never produces any. The runner records the *_skipped
		// tombstones itself when they were asked for.
		artifacts() {
			return {};
		},

		// IDEMPOTENT — a signal handler and the runner's finally can both reach
		// it. Everything here is already null-guarded; the flag exists so a
		// second call does not re-reject pending entries that the first call
		// already settled, and so proc.kill() is not sent twice to a pid that
		// may by then belong to something else.
		async stop() {
			if (stopped) return;
			stopped = true;
			if (socket) {
				socket.destroy();
				socket = null;
			}
			failAllPending(new Error("desktop transport stopped"));
			if (proc) {
				proc.kill();
				proc = null;
			}
		},
	};
}
