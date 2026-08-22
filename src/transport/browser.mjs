// Browser transport — the original Playwright path of run_scenario.mjs, moved
// behind the transport interface so a desktop --headless build can implement
// the same surface over a TCP socket (see desktop.mjs and BRIDGE_CONTRACT.md's
// "Desktop transport" section).
//
// The interface every transport implements:
//
//   start(config)        boot everything up to (not including) bridge-ready
//   waitReady()          block until the game's bridge is answering
//   call(fnName, args)   invoke a bridge action and return its parsed result
//   invoke(fnName, args) invoke a bridge function WITHOUT reading a result
//                        (boot-sequence calls and dump_state's write half)
//   readVar(varName)     read a bridge variable, parsed
//   invokeAndRead(fn, args, varName)
//                        invoke, wait for THAT invocation's write to land, and
//                        read it back — the write-then-read pair (dump_state)
//                        as one operation, so the settle rule lives in exactly
//                        one place per transport instead of at every call site
//   screenshot(path)     capture to `path` and return it, or return null if
//                        this transport cannot capture (the runner records
//                        screenshot_skipped rather than failing the step)
//   consoleErrors()      the LIVE array of {text, timestamp} error entries —
//                        the runner aliases it into the manifest once, and it
//                        keeps accumulating for the rest of the run
//   stop()               tear everything down; must be idempotent and safe to
//                        call after a partial start()
//   artifacts()          {video?, trace?} — absolute paths of the evidence
//                        files finalized by stop(); empty when none were
//                        requested (or on a transport that cannot record)
//   page                 the Playwright Page, or null on transports without
//                        one — the runner's mouse/canvas actions require it
//                        and fail loudly (never silently) when it is null
//
// EVERYTHING in this file is a straight extraction from run_scenario.mjs —
// same messages, same sleeps, same ordering. The repo's test suite exists
// because silent runner changes have already produced false playtest verdicts
// (README.md "Testing the harness itself"); a behavior change here is a
// regression even if it looks like an improvement.

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { renameSync } from "node:fs";
import http from "node:http";
import path from "node:path";

// The argv for the throwaway static file server, in ONE place so that the
// `--bind 127.0.0.1` below cannot be lost by editing one caller and not the
// other (control_server.mjs imports this too).
//
// --bind IS A SECURITY CONTROL, not a tidiness flag. `python -m http.server`
// defaults to 0.0.0.0, and what it serves here is the DEBUG web export — the
// build that carries the debug bridge, i.e. a remote-control surface for the
// game. Without --bind, every machine on the developer's LAN (a coffee-shop
// wifi, a conference network) could load that build and drive it. Nothing in
// the harness ever needs an off-machine listener.
export function staticServerArgs(port, dir) {
	return ["-m", "http.server", String(port), "--bind", "127.0.0.1", "--directory", dir];
}

// --- the settle problem, and its ONE answer ---------------------------------
//
// A JS-bridge call returns as soon as the GDScript callback is entered; the
// result lands on `window` a beat later. Three places used to guess how long
// that beat is — this file's call() slept 250ms, run_scenario's dumpState 150ms,
// control_server 70ms and 120ms and 150ms — and every one of those guesses has
// the same failure: if the write is slower than the guess, the read returns the
// PREVIOUS action's result and the step reports the wrong outcome while looking
// like a pass. That is BRIDGE_CONTRACT.md §3's sharpest edge, arrived at from
// the runner side.
//
// The fix is to stop guessing. Clear the var, make the call, then POLL until
// the var is written again — so the happy path costs one poll interval instead
// of a fixed sleep, and a slow bridge is waited for rather than misread. The
// old sleep survives as the BOUND: after BRIDGE_SETTLE_MS with nothing written,
// the read returns null.
//
// null is the honest answer there and it is a deliberate behavior change: it
// says "this action did not report", which is exactly what happened, instead of
// handing back a stale result from some earlier step. The desktop bridge has
// always worked this way (tcp_bridge.template.gd clears the result var before
// dispatch); this brings the browser side to the same contract without needing
// a chokepoint inside the game.
export const BRIDGE_SETTLE_MS = 250;
export const BRIDGE_POLL_MS = 20;

// Unset a bridge var so a subsequent read cannot see a stale value.
export async function clearBridgeVar(page, varName) {
	await page.evaluate((n) => { window[n] = undefined; }, varName);
}

// Poll `window[varName]` until it is set, or the bound passes. Returns the raw
// (still-unparsed) value, or null if nothing was ever written.
export async function settleBridgeVar(page, varName, { timeoutMs = BRIDGE_SETTLE_MS, pollMs = BRIDGE_POLL_MS } = {}) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const v = await page.evaluate((n) => window[n], varName);
		if (v !== undefined && v !== null) return v;
		if (Date.now() >= deadline) return null;
		await sleep(pollMs);
	}
}

function waitForServer(url, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolve, reject) => {
		const attempt = () => {
			http.get(url, (res) => { res.resume(); resolve(); })
				.on("error", () => {
					if (Date.now() > deadline) reject(new Error(`Server never came up at ${url}`));
					else setTimeout(attempt, 100);
				});
		};
		attempt();
	});
}

export function createBrowserTransport() {
	let cfg = null;
	let server = null;
	let browser = null;
	let page = null;
	const consoleErrors = [];
	// Opt-in evidence (config.video / config.trace, both default null — with
	// neither set, start() and stop() behave byte-identically to before these
	// existed). `video` holds the Playwright Video handle until stop() can
	// finalize it; `artifacts` reports the finished files' paths afterwards.
	let video = null; // { dir, handle }
	let tracePath = null;
	const artifacts = {};
	// The in-flight teardown promise, or null. See stop() below.
	let stopping = null;

	return {
		kind: "browser",
		get page() { return page; },

		// config: { buildDir, port, baseUrl, headed, browserExecutable,
		//           stateFn, resultVar }
		async start(config) {
			cfg = config;

			// Probe the port BEFORE spawning the server. python -m http.server
			// dying on EADDRINUSE was invisible (stdio ignored), so the runner
			// printed "Serving..." while another process actually answered on that
			// port — if that other process was serving the RELEASE build, the run
			// then died 30s later with a bare "waitForFunction timeout" and no
			// hint that it had been talking to the wrong server the whole time.
			// Found by the producer stress test's port-collision probe against the
			// release server on 8061.
			await new Promise((resolve, reject) => {
				const probe = http.createServer();
				probe.once("error", (err) => {
					if (err.code === "EADDRINUSE") {
						reject(new Error(
							`Port ${cfg.port} is already in use by another process. If that process is a leftover ` +
							`server (or the RELEASE-build preview on 8061), this run would silently load the wrong ` +
							`build and time out waiting for DebugBridge. Pick a free port: PLAYTEST_PORT=<port> ` +
							`node run_scenario.mjs ... (find the holder with: Get-NetTCPConnection -State Listen ` +
							`-LocalPort ${cfg.port}).`));
					} else {
						reject(err);
					}
				});
				probe.once("listening", () => probe.close(resolve));
				// Probe the SAME interface the real server will bind (127.0.0.1),
				// or the probe answers a question nobody asked: a 0.0.0.0 probe
				// collides with listeners on interfaces the static server will
				// never touch.
				probe.listen(cfg.port, "127.0.0.1");
			});

			console.log(`Serving ${cfg.buildDir} on port ${cfg.port}...`);
			server = spawn("python", staticServerArgs(cfg.port, cfg.buildDir), {
				stdio: "ignore",
			});

			// 30s, not the old 5s default: under full-gate load (exports + suites +
			// batch runs back to back) a cold `python -m http.server` spawn can take
			// longer than 5s to answer its first request, and the first scenario in
			// the gate's loop failed twice in a row on 2026-08-12 with "Server never
			// came up" while the identical next scenario bound the same port fine.
			// A slow server is not a dead server; only a silent one is.
			await waitForServer(cfg.baseUrl, 30000);

			// playwright is imported here rather than at module top so that
			// requiring THIS module stays dependency-light — run_scenario.mjs's
			// --validate path (a static, no-browser pre-flight) must keep working
			// in an environment where npm install hasn't run.
			const { chromium } = await import("playwright");
			browser = await chromium.launch({
				headless: !cfg.headed,
				slowMo: cfg.headed ? 300 : 0,
				...(cfg.browserExecutable ? { executablePath: cfg.browserExecutable } : {}),
			});
			// Overridable because stretch behavior depends on it: gd_paint's
			// `viewport`/`integer` stretch resolves to a 1x letterbox at 1280x720
			// but a 2x scale at 2304x1296, and only a non-default size exercises
			// the combined scale+offset input transform.
			const viewport = cfg.viewport ?? { width: 1280, height: 720 };
			const pageOptions = { viewport };
			// evidence.video: Playwright records at the context level, into a
			// directory of its choosing of names — stop() renames the finished
			// file to the bundle's stable "video.webm".
			if (cfg.video) pageOptions.recordVideo = { dir: cfg.video.dir, size: viewport };
			page = await browser.newPage(pageOptions);
			if (cfg.video) video = { dir: cfg.video.dir, handle: page.video() };
			// evidence.trace: started here, stopped (and written) in stop().
			if (cfg.trace) {
				await page.context().tracing.start({ screenshots: true, snapshots: true });
				tracePath = cfg.trace.path;
			}

			page.on("console", (msg) => {
				if (msg.type() === "error") consoleErrors.push({ text: msg.text(), timestamp: new Date().toISOString() });
			});
			// An uncaught page exception lands in the same console_errors stream
			// (it has always been captured here), but TAGGED: a reader triaging a
			// bundle needs "the game threw" to be distinguishable from "the game
			// logged console.error". console entries stay untagged so existing
			// manifests and their readers are byte-identical.
			page.on("pageerror", (err) => consoleErrors.push({ text: String(err), timestamp: new Date().toISOString(), source: "pageerror" }));

			console.log("Loading game...");
			await page.goto(cfg.baseUrl);
		},

		async waitReady() {
			console.log("Waiting for DebugBridge to register...");
			try {
				await page.waitForFunction((f) => typeof window[f] === "function", cfg.stateFn, { timeout: 30000 });
			} catch (err) {
				throw new Error(
					`DebugBridge never registered within 30s. Almost always this means the page loaded a build ` +
					`WITHOUT the bridge: a RELEASE export (build/web/ instead of build/web-debug/), or a stale ` +
					`build/web-debug/ from before DebugBridge existed. Re-export with: ` +
					`"$GODOT" --headless --export-debug "Web" "build/web-debug/index.html" (original: ${err.message})`);
			}
		},

		// Fire a bridge function without reading any result back — the boot
		// sequence's shape, and the write half of dump_state.
		async invoke(fnName, args) {
			await page.evaluate(({ f, a }) => window[f](...a), { f: fnName, a: args ?? [] });
		},

		// A bridge function the game never implemented must say SO, and say WHICH.
		// `window[fnName](...)` on an undefined function raises "TypeError:
		// window[fnName] is not a function" — a message that names neither the
		// function nor the action nor the game, and reads like a bug in the runner
		// rather than a gap in the game. The cost was real and it was silent: a
		// game shipped without `godotDebugGetControlRect`, every
		// `mouse_click_control` step it ever wrote failed with that TypeError, and
		// eleven milestones of automated tours never clicked a single UI button.
		// (The desktop transport gets this for free: its bridge answers an unknown
		// fn with an explicit {"ok": false, "error": "unknown fn ..."}.)
		async call(fnName, args) {
			const present = await page.evaluate((v) => typeof window[v] === "function", fnName);
			if (!present) {
				throw new Error(
					`the game does not implement the bridge function "${fnName}". ` +
					`This one is OPTIONAL in BRIDGE_CONTRACT.md, so a game can be fully ` +
					`conformant without it — but the step you just ran needs it. Add a ` +
					`callback registered as window.${fnName} in the game's DebugBridge, ` +
					`or remove the step.`);
			}
			// Clear-then-poll rather than a fixed sleep — see the BRIDGE_SETTLE_MS
			// comment at the top of this file for why the sleep was a bug.
			await clearBridgeVar(page, cfg.resultVar);
			await page.evaluate(({ fnName, args }) => window[fnName](...args), { fnName, args });
			const json = await settleBridgeVar(page, cfg.resultVar);
			return json ? JSON.parse(json) : null;
		},

		async readVar(varName) {
			const json = await page.evaluate((v) => window[v], varName);
			return json ? JSON.parse(json) : null;
		},

		// invoke(fn) then read(var), with the settle handled INSIDE the
		// transport — the fourth and last of the runner's settle guesses (
		// run_scenario's dumpState slept 150ms here). The browser needs a
		// clear-then-poll; the desktop transport needs nothing at all, because
		// its bridge writes the var synchronously inside the call round-trip.
		// Putting the difference here is what lets the runner stop knowing
		// about it.
		async invokeAndRead(fnName, args, varName) {
			await clearBridgeVar(page, varName);
			await page.evaluate(({ f, a }) => window[f](...a), { f: fnName, a: args ?? [] });
			const json = await settleBridgeVar(page, varName);
			return json ? JSON.parse(json) : null;
		},

		async screenshot(filePath) {
			await page.screenshot({ path: filePath });
			return filePath;
		},

		consoleErrors() {
			return consoleErrors;
		},

		// The finished evidence files, available after stop(). Empty when no
		// evidence was requested (or when a failed boot meant nothing recorded).
		artifacts() {
			return artifacts;
		},

		// IDEMPOTENT, and it now has to be: a signal handler and the runner's
		// finally can both reach it. The guard is the in-flight PROMISE, not a
		// boolean — a second caller must WAIT for the first teardown rather than
		// return immediately, or a signal path that exits when stop() resolves
		// would exit while the browser is still closing and the video file is
		// still being flushed.
		stop() {
			stopping = stopping ?? teardown();
			return stopping;
		},
	};

	async function teardown() {
		if (browser) {
			// Trace must be stopped BEFORE the browser closes or it is lost.
			if (tracePath && page) {
				try {
					await page.context().tracing.stop({ path: tracePath });
					artifacts.trace = tracePath;
				} catch { /* a dead context has no trace to save */ }
				tracePath = null;
			}
			try { await browser.close(); } catch { /* already gone */ }
			// The video file is only flushed once the context has closed;
			// rename Playwright's generated name to the bundle's stable one.
			if (video) {
				try {
					const raw = await video.handle.path();
					const finalPath = path.join(video.dir, "video.webm");
					renameSync(raw, finalPath);
					artifacts.video = finalPath;
				} catch { /* a page that never loaded recorded nothing */ }
				video = null;
			}
			browser = null;
			page = null;
		}
		if (server) {
			server.kill();
			server = null;
		}
	}
}
