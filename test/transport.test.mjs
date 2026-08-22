// Transport-seam tests. Run via `npm test` (harness.test.mjs imports this
// file, so node --test picks these up without touching package.json, which is
// owned elsewhere this wave).
//
// No browser, no Godot: the desktop transport is driven against a FAKE game
// server — a node net.createServer speaking the newline-delimited JSON
// protocol from BRIDGE_CONTRACT.md's "Desktop transport" section. What these
// guard:
//
//   * waitReady retries until the bridge ANSWERS a ping — a server that comes
//     up late must still be reached, and a port that never answers must be a
//     loud timeout, not a hang.
//   * call/read round-trip carries results and var values faithfully.
//   * a protocol-level {"ok": false} rejects the call (error propagation).
//   * responses match requests by id even when they arrive OUT OF ORDER —
//     an interleaving bug here would attach one step's result to another
//     step, which is precisely the stale-result class the bridge contract
//     exists to prevent.
//   * run_scenario's transport selection defaults to "browser" and hard-fails
//     an unknown value — a typo silently falling back to the default would
//     point a run at the wrong build entirely.

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

import { createDesktopTransport, DEFAULT_DESKTOP_PORT } from "../src/transport/desktop.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = path.join(ROOT, "src", "run_scenario.mjs");

// ---------------------------------------------------------------------------
// Fixtures: a free port, and a fake game server speaking the wire protocol
// ---------------------------------------------------------------------------

function getFreePort() {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
	});
}

// onRequest(req) -> response object (or a promise of one; null to stay silent).
// Ping is answered automatically unless the handler overrides it.
//
// `opts.token`, when set, makes the fake server behave like tcp_bridge does
// with a --playtest-token=: any request whose "token" field does not match is
// answered once and the peer is DROPPED. `opts.seen` collects every request, so
// a test can assert what actually went over the wire.
function startFakeServer(port, onRequest = null, opts = {}) {
	const sockets = new Set();
	const server = net.createServer((sock) => {
		sockets.add(sock);
		sock.setEncoding("utf8");
		let buf = "";
		sock.on("data", (chunk) => {
			buf += chunk;
			let idx;
			while ((idx = buf.indexOf("\n")) !== -1) {
				const line = buf.slice(0, idx).trim();
				buf = buf.slice(idx + 1);
				if (!line) continue;
				const req = JSON.parse(line);
				opts.seen?.push(req);
				if (opts.token !== undefined && req.token !== opts.token) {
					sock.write(JSON.stringify({ id: req.id, ok: false, error: "bad or missing token" }) + "\n");
					sock.destroy();
					return;
				}
				const fallback = req.op === "ping" ? { id: req.id, ok: true, result: "pong" } : { id: req.id, ok: false, error: `fake server has no handler for op "${req.op}"` };
				Promise.resolve(onRequest ? onRequest(req) : null).then((resp) => {
					sock.write(JSON.stringify(resp ?? fallback) + "\n");
				});
			}
		});
		sock.on("close", () => sockets.delete(sock));
		sock.on("error", () => {});
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => resolve({
			server,
			close: () => new Promise((r) => {
				for (const s of sockets) s.destroy();
				server.close(() => r());
			}),
		}));
	});
}

// A transport attached (no binary spawned) to the given port.
async function attachTransport(port, extra = {}) {
	const t = createDesktopTransport();
	await t.start({ desktop: { port, ...extra } });
	return t;
}

// ---------------------------------------------------------------------------
// waitReady
// ---------------------------------------------------------------------------

test("desktop waitReady retries until a late server answers the ping", async () => {
	const port = await getFreePort();
	const t = await attachTransport(port, { ready_timeout_ms: 8000 });
	let fake = null;
	try {
		// The server comes up 600ms AFTER waitReady starts probing — the retry
		// loop must survive several refused connects and then succeed.
		const bringUp = (async () => {
			await sleep(600);
			fake = await startFakeServer(port);
		})();
		await t.waitReady();
		await bringUp;
	} finally {
		await t.stop();
		if (fake) await fake.close();
	}
});

test("desktop waitReady fails loudly when nothing ever answers", async () => {
	const port = await getFreePort(); // nothing listening on it
	const t = await attachTransport(port, { ready_timeout_ms: 900 });
	try {
		await assert.rejects(
			() => t.waitReady(),
			(err) => {
				assert.match(String(err), /never answered/i, "the timeout must say what never happened");
				assert.match(String(err), new RegExp(String(port)), "and on which port");
				assert.match(String(err), /--playtest-bridge/, "and point at the likely cause: the opt-in flag");
				return true;
			});
	} finally {
		await t.stop();
	}
});

// ---------------------------------------------------------------------------
// call / read round-trips
// ---------------------------------------------------------------------------

test("desktop call and read round-trip results and var values", async () => {
	const port = await getFreePort();
	const fake = await startFakeServer(port, (req) => {
		if (req.op === "call" && req.fn === "godotDebugDoThing") {
			return { id: req.id, ok: true, result: { success: true, echo: req.args } };
		}
		if (req.op === "read" && req.var === "godotDebugLastState") {
			return { id: req.id, ok: true, result: { version: 1, run: { state: "IN_PROGRESS" } } };
		}
		if (req.op === "read" && req.var === "neverWritten") {
			// An unset var is null, NOT an error — matches an unset window var.
			return { id: req.id, ok: true, result: null };
		}
		return null; // fall back (ping, etc.)
	});
	const t = await attachTransport(port);
	try {
		await t.waitReady();
		const result = await t.call("godotDebugDoThing", ["widget", 3]);
		assert.deepEqual(result, { success: true, echo: ["widget", 3] });

		const state = await t.readVar("godotDebugLastState");
		assert.deepEqual(state, { version: 1, run: { state: "IN_PROGRESS" } });

		const unset = await t.readVar("neverWritten");
		assert.equal(unset, null, "an unset var must read as null, not throw");
	} finally {
		await t.stop();
		await fake.close();
	}
});

test("desktop screenshot() returns null — the runner's skip signal, never a throw", async () => {
	const t = createDesktopTransport();
	assert.equal(await t.screenshot("anywhere.png"), null);
	assert.equal(t.page, null, "no Playwright page on the desktop transport");
	await t.stop();
});

// ---------------------------------------------------------------------------
// Error propagation
// ---------------------------------------------------------------------------

test("a protocol-level ok:false rejects the call with the bridge's error", async () => {
	const port = await getFreePort();
	const fake = await startFakeServer(port, (req) => {
		if (req.op === "call") {
			return { id: req.id, ok: false, error: `unknown fn "${req.fn}"` };
		}
		return null;
	});
	const t = await attachTransport(port);
	try {
		await t.waitReady();
		await assert.rejects(
			() => t.call("godotDebugTypo", []),
			/unknown fn "godotDebugTypo"/,
			"the bridge's own error text must survive into the rejection");
	} finally {
		await t.stop();
		await fake.close();
	}
});

// ---------------------------------------------------------------------------
// Id matching under interleaving
// ---------------------------------------------------------------------------

test("responses match requests by id even when they arrive out of order", async () => {
	const port = await getFreePort();
	const fake = await startFakeServer(port, async (req) => {
		if (req.op === "call" && req.fn === "slow") {
			await sleep(250); // answered SECOND despite being asked FIRST
			return { id: req.id, ok: true, result: { who: "slow" } };
		}
		if (req.op === "call" && req.fn === "fast") {
			return { id: req.id, ok: true, result: { who: "fast" } };
		}
		return null;
	});
	const t = await attachTransport(port);
	try {
		await t.waitReady();
		const slowPromise = t.call("slow", []);
		const fastPromise = t.call("fast", []);
		const fast = await fastPromise;
		const slow = await slowPromise;
		// If ids were matched positionally instead of by value, each call would
		// have received the OTHER's result — one step's outcome attached to
		// another step, silently.
		assert.deepEqual(fast, { who: "fast" });
		assert.deepEqual(slow, { who: "slow" });
	} finally {
		await t.stop();
		await fake.close();
	}
});

// ---------------------------------------------------------------------------
// run_scenario's transport selection
// ---------------------------------------------------------------------------

const CATALOG = {
	catalog_version: 1,
	game: "fixture",
	actions: {
		do_thing: {
			fn: "godotDebugDoThing",
			positional: [{ name: "thing_id" }],
			required: ["thing_id"],
			optional: [],
		},
	},
};

// Same shape as harness.test.mjs's validate(): a throwaway game repo, one
// scenario, run through --validate (which exercises config loading — including
// transport selection — without any browser or game).
function validateWithConfig(configExtra) {
	const dir = mkdtempSync(path.join(tmpdir(), "transport-test-"));
	try {
		writeFileSync(path.join(dir, "playtest.actions.json"), JSON.stringify(CATALOG));
		writeFileSync(path.join(dir, "playtest.config.json"), JSON.stringify({
			game: "fixture",
			action_catalog: "playtest.actions.json",
			build_dir: "build/web-debug",
			...configExtra,
		}));
		const scenarioPath = path.join(dir, "s.json");
		writeFileSync(scenarioPath, JSON.stringify({
			name: "s",
			steps: [{ action: "do_thing", args: { thing_id: "w" }, expect: "success" }],
		}));
		try {
			const out = execFileSync("node", [RUNNER, "--validate", scenarioPath], {
				cwd: dir,
				env: { ...process.env, PLAYTEST_GAME_ROOT: dir },
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			});
			return { ok: true, out };
		} catch (e) {
			return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("transport selection defaults to browser — a config without the key still works", () => {
	const r = validateWithConfig({});
	assert.equal(r.ok, true, r.out);
});

test("transport 'browser' and 'desktop' are both accepted", () => {
	for (const transport of ["browser", "desktop"]) {
		const r = validateWithConfig({ transport });
		assert.equal(r.ok, true, `transport "${transport}" must be accepted: ${r.out}`);
	}
});

test("an unknown transport is a hard error, not a silent browser fallback", () => {
	const r = validateWithConfig({ transport: "webscoket" }); // a plausible typo
	assert.equal(r.ok, false, "a typo'd transport silently running the browser path would point the run at the wrong build");
	assert.match(r.out, /transport/i);
	assert.match(r.out, /webscoket/);
});

// ---------------------------------------------------------------------------
// Bridge token and buffer cap (finding G)
// ---------------------------------------------------------------------------

const BRIDGE_GD = readFileSync(path.join(ROOT, "godot", "tcp_bridge.template.gd"), "utf8");
const DESKTOP_SRC = readFileSync(path.join(ROOT, "src", "transport", "desktop.mjs"), "utf8");

test("a spawned game is handed a random --playtest-token= alongside --playtest-port=", () => {
	// STATIC: spawning a Godot binary is not something this suite can do. What
	// is pinned is the argv assembly, which is the whole mechanism — a token
	// that never reaches the game protects nothing.
	assert.match(DESKTOP_SRC, /randomBytes\(\d+\)\.toString\("hex"\)/);
	assert.match(DESKTOP_SRC, /--playtest-token=\$\{token\}/);
	assert.match(DESKTOP_SRC, /"--playtest-bridge", `--playtest-port=\$\{port\}`, `--playtest-token=/,
		"the token must be appended in the same user-arg group as the opt-in flag and the port");
	// And it must not be printed. A runner log goes into bug reports.
	assert.match(DESKTOP_SRC, /--playtest-token=<redacted>/,
		"the spawn line must redact the token");
});

test("every request carries the token when one was issued, and none when it was not", async () => {
	const port = await getFreePort();
	const seen = [];
	const fake = await startFakeServer(port, null, { seen });
	// Attaching (no binary) issues NO token — the transport cannot know what
	// token a bridge it did not spawn was given.
	const t = await attachTransport(port);
	try {
		await t.waitReady();
		await t.readVar("godotDebugLastState").catch(() => {});
		assert.ok(seen.length >= 2, "expected a ping and a read");
		for (const req of seen) {
			assert.equal("token" in req, false,
				"an attached transport must not invent a token — a bogus one would be REFUSED where none is merely unauthenticated");
		}
	} finally {
		await t.stop();
		await fake.close();
	}
});

test("a bridge that requires a token refuses a client that has none", async () => {
	// The attack this closes, from the bridge's side: something that reached
	// the port without being able to read the game's command line.
	const port = await getFreePort();
	const fake = await startFakeServer(port, null, { token: "the-real-token" });
	const t = await attachTransport(port, { ready_timeout_ms: 900 });
	try {
		await assert.rejects(() => t.waitReady(), /never answered/i,
			"an unauthenticated client must never reach readiness");
	} finally {
		await t.stop();
		await fake.close();
	}
});

test("the tcp_bridge template checks the token before it looks at the op", () => {
	// STATIC, with the same limits addon_contract.test.mjs names for GDScript.
	// Order matters: a check that runs per-op is a check some op can skip.
	assert.match(BRIDGE_GD, /const TOKEN_FLAG_PREFIX: String = "--playtest-token="/);
	assert.match(BRIDGE_GD, /_token = arg\.trim_prefix\(TOKEN_FLAG_PREFIX\)/);
	const tokenAt = BRIDGE_GD.indexOf('str(req.get("token", "")) != _token');
	const matchAt = BRIDGE_GD.indexOf("\tmatch op:");
	assert.ok(tokenAt !== -1, "the bridge must compare the request's token to its own");
	assert.ok(tokenAt < matchAt, "the token check must precede the op dispatch entirely");
	// A failed token DROPS the peer rather than answering again, so the port
	// cannot be used as a guessing oracle.
	assert.match(BRIDGE_GD, /"bad or missing token"\}\)\n\t\treturn false/);
	assert.match(BRIDGE_GD, /_drop_peer\(i, "bad token"\)/);
	// One flat message: no length hint, no per-op variation.
	assert.equal((BRIDGE_GD.match(/bad or missing token/g) ?? []).length, 1);
	// The token must never be printed by the game either.
	assert.doesNotMatch(BRIDGE_GD, /print\([^)]*_token/);
});

test("an absent token FAILS CLOSED — the bridge refuses to listen without one", () => {
	// The harness always passes --playtest-token=, so a missing token is a
	// regression or a forgotten hand-launched build, and the un-tokened bridge
	// is drivable by every local process (and, via CORS simple-request POSTs,
	// any open web page). The hand-driven netcat mode still exists, but only
	// as a stated intent: --playtest-no-token.
	assert.match(BRIDGE_GD, /if _token\.is_empty\(\) and not user_args\.has\("--playtest-no-token"\):/,
		"no token and no explicit opt-out must refuse to serve");
	assert.match(BRIDGE_GD, /refusing to listen: no --playtest-token=/,
		"and the refusal must say why and name the opt-out");
	assert.match(BRIDGE_GD, /if not _token\.is_empty\(\) and /,
		"with the opt-out taken, an empty token skips the check rather than accepting anything");
});

test("BRIDGE_CONTRACT §8 documents the token, including what it does NOT protect", () => {
	// A security control described optimistically is worse than none: a reader
	// who believes the port is authenticated will make decisions on that basis.
	// The contract must carry the limitation, not just the feature.
	const contract = readFileSync(path.join(ROOT, "BRIDGE_CONTRACT.md"), "utf8");
	assert.match(contract, /--playtest-token=/, "the flag must be documented");
	assert.match(contract, /"token"/, "the wire protocol must show the field");
	assert.match(contract, /It does not stop/i,
		"§8 must say what the token does NOT protect against");
	assert.match(contract, /command line/,
		"…which is: anything that can read the game's command line");
	assert.match(contract, /not an\s+authentication system/i);
	// And the cap.
	assert.match(contract, /1 MiB|1048576/, "the request-line cap belongs in the protocol section");
});

test("both sides cap an undelimited request line", () => {
	// One socket and a stream of bytes with no newline is a memory bomb on
	// either end, and it needs no protocol knowledge at all.
	assert.match(BRIDGE_GD, /const MAX_LINE_BYTES: int = 1048576/);
	// buf is a PackedByteArray (bytes, not text — a UTF-8 char split across TCP
	// segments must not be decoded until its line completes), so the cap reads
	// size(), not length().
	assert.match(BRIDGE_GD, /if buf\.size\(\) > MAX_LINE_BYTES:/);
	assert.match(BRIDGE_GD, /_drop_peer\(i, "oversized request line"\)/);
	assert.match(DESKTOP_SRC, /export const MAX_LINE_BYTES = 1048576/);
	assert.match(DESKTOP_SRC, /if \(buffer\.length > MAX_LINE_BYTES\)/);
});

test("the Node side drops a peer that floods it with no newline", async () => {
	const port = await getFreePort();
	const { MAX_LINE_BYTES } = await import("../src/transport/desktop.mjs");
	// A "bridge" that answers the ping and then emits a megabyte of garbage
	// with no delimiter — i.e. something that is not the game at all.
	const sockets = new Set();
	const server = net.createServer((sock) => {
		sockets.add(sock);
		sock.setEncoding("utf8");
		sock.on("error", () => {});
		let buf = "";
		sock.on("data", (chunk) => {
			buf += chunk;
			let idx;
			while ((idx = buf.indexOf("\n")) !== -1) {
				const req = JSON.parse(buf.slice(0, idx));
				buf = buf.slice(idx + 1);
				if (req.op === "ping") { sock.write(JSON.stringify({ id: req.id, ok: true, result: "pong" }) + "\n"); continue; }
				sock.write("x".repeat(MAX_LINE_BYTES + 1024)); // no newline, ever
			}
		});
	});
	await new Promise((r) => server.listen(port, "127.0.0.1", r));
	const t = await attachTransport(port);
	try {
		await t.waitReady();
		await assert.rejects(
			() => t.call("godotDebugAnything", []),
			(err) => {
				assert.match(String(err), /no newline/, "the failure must name what was wrong with the stream");
				assert.match(String(err), new RegExp(String(port)), "and which port it came from");
				return true;
			});
	} finally {
		await t.stop();
		for (const s of sockets) s.destroy();
		await new Promise((r) => server.close(r));
	}
});

// ---------------------------------------------------------------------------
// Call/read timeouts (finding F) and idempotent stop (finding D)
// ---------------------------------------------------------------------------

test("a call the game never answers times out, naming what was in flight", async () => {
	const port = await getFreePort();
	// Answers the ping (so waitReady succeeds — the bridge IS up) and then goes
	// silent on the call. This is what a wedged handler looks like from here,
	// and before the bound existed it hung the whole run with no output.
	const fake = await startFakeServer(port, (req) => {
		if (req.op === "call") return null; // handled below
		return null;
	});
	// startFakeServer's fallback answers non-ping ops with an error, so silence
	// has to be arranged explicitly: a handler returning a never-settling
	// promise writes nothing.
	await fake.close();
	const silent = await startFakeServer(port, (req) =>
		req.op === "ping" ? { id: req.id, ok: true, result: "pong" } : new Promise(() => {}));
	const t = await attachTransport(port, { call_timeout_ms: 300 });
	try {
		await t.waitReady();
		await assert.rejects(
			() => t.call("godotDebugWedged", []),
			(err) => {
				assert.match(String(err), /godotDebugWedged/, "the timeout must name the action in flight");
				assert.match(String(err), /300ms/, "and the bound it exceeded");
				assert.match(String(err), /call_timeout_ms/, "and how to raise it for a legitimately slow action");
				return true;
			});
	} finally {
		await t.stop();
		await silent.close();
	}
});

test("a read the game never answers times out too", async () => {
	const port = await getFreePort();
	const fake = await startFakeServer(port, (req) =>
		req.op === "ping" ? { id: req.id, ok: true, result: "pong" } : new Promise(() => {}));
	const t = await attachTransport(port, { call_timeout_ms: 250 });
	try {
		await t.waitReady();
		await assert.rejects(() => t.readVar("godotDebugLastState"), /godotDebugLastState[\s\S]*250ms/);
	} finally {
		await t.stop();
		await fake.close();
	}
});

test("the call timeout defaults rather than requiring config", async () => {
	// A game that configures nothing must still be bounded — the whole finding
	// is that the DEFAULT was "wait forever".
	const src = readFileSync(path.join(ROOT, "src", "transport", "desktop.mjs"), "utf8");
	assert.match(src, /let callTimeoutMs = 30000/);
	assert.match(src, /d\.call_timeout_ms \?\? 30000/);
	// And every call/read site must pass it — one that forgets is unbounded again.
	const sends = [...src.matchAll(/send\("(call|read)",[^;]*?\);/gs)];
	assert.ok(sends.length >= 5, `expected several call/read sends, found ${sends.length}`);
	for (const m of sends) {
		assert.match(m[0], /callTimeoutMs\)/, `an unbounded send survives: ${m[0].slice(0, 90)}`);
	}
});

test("stop() is idempotent on both transports", async () => {
	// A signal handler and the runner's `finally` can now BOTH reach stop().
	const port = await getFreePort();
	const fake = await startFakeServer(port);
	const desktop = await attachTransport(port);
	await desktop.waitReady();
	await desktop.stop();
	await desktop.stop(); // must not throw, must not re-kill
	await desktop.stop();
	await fake.close();

	// The browser transport's stop() must return the IN-FLIGHT promise rather
	// than a boolean short-circuit: a second caller has to wait for the first
	// teardown, or a signal path that exits when stop() resolves exits while the
	// browser is still closing and the video file is still being flushed.
	const browserSrc = readFileSync(path.join(ROOT, "src", "transport", "browser.mjs"), "utf8");
	assert.match(browserSrc, /stopping = stopping \?\? teardown\(\)/);
	assert.match(browserSrc, /return stopping/);

	// A never-started browser transport must also tolerate stop() — the runner's
	// finally reaches it even when start() threw on the port probe.
	const { createBrowserTransport } = await import("../src/transport/browser.mjs");
	const b = createBrowserTransport();
	await b.stop();
	await b.stop();
});

test("run_scenario installs signal handlers that flush the manifest", () => {
	// STATIC (run_scenario.mjs exits on import when there is no game config).
	// Ctrl+C at step 40 of 60 used to write NO manifest at all — forty steps of
	// screenshots on disk with nothing saying what produced them.
	const src = readFileSync(path.join(ROOT, "src", "run_scenario.mjs"), "utf8");
	assert.match(src, /const signals = \["SIGINT", "SIGTERM"\]/);
	assert.match(src, /manifest\.interrupted = sig/);
	assert.match(src, /manifest\.complete = false/);
	// The write must be the SAME function the finally uses, or the two endings
	// produce differently-shaped bundles and only one of them is readable.
	assert.match(src, /const flushManifest = \(\) =>/);
	assert.equal((src.match(/flushManifest\(\)/g) ?? []).length, 3,
		"flushManifest must be called from exactly three places: the signal path pre-stop (the " +
		"guaranteed one), the signal path post-stop (so finalized video/trace reach the manifest), " +
		"and the finally");
	assert.match(src, /try \{ flushManifest\(\); \} catch/,
		"the signal path must survive a manifest write that fails — a dead disk must not swallow the shutdown");
	// And uninstalled, so a caller running several scenarios in one process does
	// not accumulate a handler per run, each closing over a stale manifest.
	assert.match(src, /process\.off\(sig, fn\)/);
});

// ---------------------------------------------------------------------------
// Settle consolidation (finding E)
// ---------------------------------------------------------------------------

test("desktop invokeAndRead calls then reads, with no settle sleep in between", async () => {
	const port = await getFreePort();
	const seen = [];
	const fake = await startFakeServer(port, (req) => {
		if (req.op === "call") { seen.push(`call:${req.fn}`); return { id: req.id, ok: true, result: null }; }
		if (req.op === "read") { seen.push(`read:${req.var}`); return { id: req.id, ok: true, result: { version: 1 } }; }
		return null;
	});
	const t = await attachTransport(port);
	try {
		await t.waitReady();
		const started = Date.now();
		const state = await t.invokeAndRead("godotDebugDumpState", [], "godotDebugLastState");
		const elapsed = Date.now() - started;
		assert.deepEqual(state, { version: 1 });
		assert.deepEqual(seen, ["call:godotDebugDumpState", "read:godotDebugLastState"],
			"the call must precede the read, and nothing else may happen between them");
		// tcp_bridge writes the var synchronously inside the call round-trip, so
		// any sleep here would be pure tax. This is the pin against someone
		// "helpfully" adding the browser transport's settle to both.
		assert.ok(elapsed < 100, `invokeAndRead took ${elapsed}ms — the desktop path must not sleep`);
	} finally {
		await t.stop();
		await fake.close();
	}
});

test("the shared settle constants exist and are exported from the transport", async () => {
	// The whole point of finding E: ONE place answers "how long after a bridge
	// call does its result land". Four call sites used to answer it separately
	// (250/150/120/70ms), and the ones that guessed short returned the PREVIOUS
	// action's result.
	const mod = await import("../src/transport/browser.mjs");
	assert.equal(typeof mod.BRIDGE_SETTLE_MS, "number");
	assert.equal(typeof mod.BRIDGE_POLL_MS, "number");
	assert.ok(mod.BRIDGE_POLL_MS < mod.BRIDGE_SETTLE_MS, "the poll interval must fit inside the bound");
	assert.equal(typeof mod.clearBridgeVar, "function");
	assert.equal(typeof mod.settleBridgeVar, "function");
	// The old fixed sleep is preserved as the BOUND, not as the happy path.
	assert.equal(mod.BRIDGE_SETTLE_MS, 250, "the bound is the old browser-transport sleep, kept deliberately");
});

test("settleBridgeVar polls and returns as soon as the var is written", async () => {
	const { settleBridgeVar, BRIDGE_SETTLE_MS } = await import("../src/transport/browser.mjs");
	// A stand-in for a Playwright Page: only .evaluate is used, and only to
	// read one window var. No browser needed to prove the polling contract.
	let value;
	setTimeout(() => { value = '{"ok":true}'; }, 60);
	const fakePage = { evaluate: async () => value };
	const started = Date.now();
	const got = await settleBridgeVar(fakePage, "someVar");
	const elapsed = Date.now() - started;
	assert.equal(got, '{"ok":true}');
	assert.ok(elapsed >= 50, "it must actually have waited for the late write");
	assert.ok(elapsed < BRIDGE_SETTLE_MS, `it must return on the write (${elapsed}ms), not sleep out the bound`);
});

test("settleBridgeVar returns null — never a stale value — when nothing is written", async () => {
	const { settleBridgeVar } = await import("../src/transport/browser.mjs");
	const fakePage = { evaluate: async () => undefined };
	const got = await settleBridgeVar(fakePage, "neverWritten", { timeoutMs: 80 });
	assert.equal(got, null,
		"null says 'this action did not report'. Returning whatever was there before is the " +
		"silent-stale-result failure BRIDGE_CONTRACT.md §3 exists to prevent.");
});

// ---------------------------------------------------------------------------
// Odds and ends
// ---------------------------------------------------------------------------

test("the default desktop port is the documented one", () => {
	// BRIDGE_CONTRACT.md and tcp_bridge.template.gd both say 8973; drift here
	// would strand every game that took the docs at their word.
	assert.equal(DEFAULT_DESKTOP_PORT, 8973);
});
