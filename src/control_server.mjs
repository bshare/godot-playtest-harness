// Interactive control server: one persistent Playwright session behind small HTTP
// endpoints, so a series of separate CLI calls can drive one continuous run.
//
// THIS IS THE ONLY ROUTE TO REAL PLAYER ACTIONS. `run_scenario.mjs` commits to a
// scenario up front; this lets an agent look, decide, act, and look again — which
// is what a playtest is. Every interactive session in a real game's playtest
// board ran through here.
//
// Endpoints (GET, query-string args). EVERY one also needs &token=<the token
// printed at startup> — see the SECURITY note below:
//   /reset?seed=123     -> the configured reset action
//   /state              -> concise dump_state
//   /legal              -> full legal_moves array
//   /act?action=X&...   -> any action in the game's catalog; args come from the
//                          query string and are marshalled per the catalog
//   /key?key=Escape     -> a raw key press, for UI-only affordances (a help
//                          overlay, a deck view) that have no bridge action
//                          because they change no game state. Recorded as a step
//                          with a `changed_state` flag, so one that DOES move the
//                          game cannot do it quietly
//   /shot?name=foo      -> screenshot into the evidence dir
//   /raw                -> full dump_state JSON
//   /errors             -> console errors collected so far
//   /quit               -> close browser, exit
//
// EVERY SESSION WRITES manifest.json INTO THE EVIDENCE DIR. A real incident: an
// interactive persona pass produced 33 screenshots and a four-line log with no
// seed, no action sequence and no state — so every finding filed from it was
// unreproducible, and its register rows read "seed unrecoverable" beside rows
// from `capture_tour.mjs` carrying a seed and a frame number. The difference was
// never capability. This file already knew the seed; it drove the reset with it.
// It simply never wrote it down.
//
// The manifest is rewritten after EVERY mutating call rather than at /quit,
// because a session that is killed, hangs or crashes is precisely the session
// whose record you most want, and /quit is the one call such a session never
// makes. It also carries `complete`, for the same reason capture_tour.mjs carries
// `truncated`: a bundle that cannot say whether it stopped or was stopped will be
// read as whichever is more alarming.
//
// ---------------------------------------------------------------------------
// KNOWN LIMITS OF THIS FILE — read before trusting it on a new game
// ---------------------------------------------------------------------------
//
// 1. `/state` (and the `state` field on every /reset, /act and /key response) is
//    the game's PROJECTION of dump_state. By default it is the identity — the
//    full raw state, same as /raw — because which fields matter is game-specific
//    and this server cannot know them. A game that wants a curated /state (to
//    keep a text agent's context small, or to surface a flag that raw output
//    buries) exports `concise(state)` from its config's game_module; see
//    src/concise.mjs. There is no longer a built-in game-shaped filter to come
//    back empty on a game it was not written for.
//
// 2. Security posture: this server is LOOPBACK-ONLY and TOKEN-GATED (see
//    SESSION_TOKEN below). It is a debugging tool for one developer's machine,
//    not a service. It is not hardened against a hostile local user who can
//    read this process's stdout.
//
// SECURITY: every request must carry ?token=<the token printed at startup>, and
// any request bearing an `Origin` header is refused outright. Both exist for one
// attack: a web page the developer happens to have open can issue cross-origin
// GETs at 127.0.0.1 — `<img src="http://127.0.0.1:8790/act?action=...">` needs
// no CORS permission at all, because the browser sends the request regardless of
// whether the page is allowed to read the reply. Every endpoint here is a GET
// that MUTATES, so "cannot read the response" is no protection. The token is
// the real gate (the page cannot guess it); the Origin check is a cheap second
// wall, sound because a CLI client (curl, fetch from a node script) sends no
// Origin and a browser page always does.
import { chromium } from "playwright";
import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { pickConcise } from "./concise.mjs";
import { staticServerArgs, clearBridgeVar, settleBridgeVar } from "./transport/browser.mjs";

// --- configuration, and it FAILS rather than guesses -------------------------
//
// Every one of these used to default silently, and two of the defaults were
// absolute paths into one particular game repo. That is how this file drove the
// wrong build and wrote evidence into the wrong directory while reporting
// success once on a real game: a control server whose defaults are plausible is
// worse than one that has none, because the run completes and the bundle looks
// right. Ports still default — a wrong port fails loudly on connect — but
// anything that decides WHICH GAME or WHERE THE EVIDENCE GOES must be stated.
function required(name, hint) {
	const v = process.env[name];
	if (v === undefined || v === "") {
		console.error(`ERROR: ${name} is not set. ${hint}`);
		process.exit(2);
	}
	return v;
}

function loadJson(p, what) {
	if (!existsSync(p)) {
		console.error(`ERROR: ${what} not found at ${p}`);
		process.exit(2);
	}
	try {
		return JSON.parse(readFileSync(p, "utf8"));
	} catch (e) {
		console.error(`ERROR: ${what} at ${p} is not valid JSON: ${e.message}`);
		process.exit(2);
	}
}

const GAME_ROOT = path.resolve(required(
	"PLAYTEST_GAME_ROOT",
	"Set it to the game repo root — the directory holding playtest.config.json.",
));
const CONFIG = loadJson(
	process.env.PLAYTEST_CONFIG
		? path.resolve(process.env.PLAYTEST_CONFIG)
		: path.join(GAME_ROOT, "playtest.config.json"),
	"playtest.config.json",
);
const CATALOG = loadJson(
	path.resolve(GAME_ROOT, CONFIG.action_catalog ?? "playtest.actions.json"),
	"action catalog",
);
const ACTION_DEFS = CATALOG.actions ?? {};

// The game's OPTIONAL /state projection. run_scenario already loads this module
// for `consistencyRules`; here we take its `concise` export if it has one, so
// the two entry points agree on how a game curates its state. Without a
// game_module — or without the export — /state returns the full raw state (see
// src/concise.mjs), never a game-shaped filter guessing at fields this game may
// not have. A broken game_module path fails loudly at startup, in keeping with
// this file's "FAILS rather than guesses" stance, rather than silently leaving
// /state unprojected.
let GAME_MODULE = null;
if (CONFIG.game_module) {
	const modPath = path.resolve(GAME_ROOT, CONFIG.game_module);
	try {
		GAME_MODULE = await import(pathToFileURL(modPath).href);
	} catch (e) {
		console.error(`ERROR: could not load game_module at ${modPath}: ${e.message}`);
		process.exit(2);
	}
}
const project = pickConcise(GAME_MODULE);

// The bridge names, defaults-plus-overrides, exactly as run_scenario.mjs builds
// its BRIDGE object. These used to be four string literals inline, so a game
// that renamed its dump_state (which BRIDGE_CONTRACT.md explicitly permits, and
// playtest.config.json's `bridge` block exists to declare) could be driven by
// run_scenario and not by this file — and the failure was a 60s
// waitForFunction timeout naming a function the game never claimed to have.
const BRIDGE = {
	state_fn: "godotDebugDumpState",
	state_var: "godotDebugLastState",
	result_var: "godotDebugLastActionResult",
	...(CONFIG.bridge ?? {}),
};

// --- the session token -------------------------------------------------------
//
// Printed ONCE, at startup, and required on every request thereafter. See the
// SECURITY note in this file's header for the attack it closes. PLAYTEST_TOKEN
// lets a wrapper script fix the value it will use rather than scrape stdout;
// anything else gets 32 hex bytes from the CSPRNG.
const SESSION_TOKEN = process.env.PLAYTEST_TOKEN || randomBytes(16).toString("hex");

// Constant-time, and length-safe: timingSafeEqual THROWS on unequal lengths, so
// comparing the raw buffers would both crash and leak the length through that
// crash. Hashing to a fixed width first is the standard fix, but here the
// cheaper honest version suffices — reject on length mismatch before comparing,
// and accept that an attacker learns the token's length, which is not secret.
function tokenOk(supplied) {
	if (typeof supplied !== "string") return false;
	const a = Buffer.from(supplied, "utf8");
	const b = Buffer.from(SESSION_TOKEN, "utf8");
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

// A caller-supplied screenshot name becomes a FILENAME. `?name=../../../evil`
// used to write outside the evidence directory entirely — path.join happily
// resolves the traversal, and the only thing standing between a query string
// and an arbitrary write was that nobody had tried. basename first (kills the
// separators and any drive-relative prefix), then strip to a conservative
// alphabet (kills what basename leaves: leading dots, colons, wildcards).
function safeShotName(raw) {
	const cleaned = path.basename(String(raw ?? "")).replace(/[^A-Za-z0-9._-]/g, "");
	// Empty after cleaning means the caller supplied only separators or only
	// characters we refuse. Falling back to a generated name would silently
	// write a file the caller cannot find; refusing says what happened.
	return cleaned.length > 0 ? cleaned : null;
}

const PORT = Number(process.env.CTRL_PORT || 8790);
const GAME_PORT = Number(process.env.GAME_PORT || 8172);
if (Math.abs(PORT - GAME_PORT) < 100) {
	// Two servers, two ports, and they have collided before. Cheap to assert.
	console.error(`ERROR: CTRL_PORT (${PORT}) and GAME_PORT (${GAME_PORT}) are too close together.`);
	process.exit(2);
}
const BUILD_DIR = path.resolve(GAME_ROOT, process.env.BUILD_DIR ?? CONFIG.build_dir ?? "build/web-debug");
const RUN_TAG = required("RUN_TAG", "Name this session — it becomes the evidence directory.");
const shotsDir = path.resolve(GAME_ROOT, CONFIG.runs_dir ?? "runs", `interactive_${RUN_TAG}`);
mkdirSync(shotsDir, { recursive: true });
console.log(`game root ${GAME_ROOT}\nbuild     ${BUILD_DIR}\nevidence  ${shotsDir}`);

// Turns a query string into the positional argument list the bridge function
// expects, per the catalog's `positional` array — the SAME marshalling
// `run_scenario.mjs` does, and this file used to do something else entirely.
//
// It sent every action as one JSON string, which is right for the actions that
// take a JSON object and wrong for the ones with a positional signature. Those
// simply refused: the bridge read the whole `{"policy":"greedy","turn":0}` blob
// as the policy NAME and answered `unknown_policy`. It answered LOUDLY, into
// `act_result`, and a caller reading only the state field saw eight no-ops and
// no errors (a real incident). Two arg conventions and one marshaller is a defect
// waiting for whoever does not know which convention they are calling.
function buildArgs(actionName, args) {
	const slots = ACTION_DEFS[actionName]?.positional ?? [];
	return slots.map((slot) => {
		if ("literal" in slot) return slot.literal;
		// `bundle` hands the WHOLE args object over as one JSON string, for bridges
		// with a single generic handler per action. Declared as its own slot form
		// rather than an opaque {name:"args"} so `required`/`optional` keep
		// describing the payload's real contents — see ACTION_CATALOG.md.
		if (slot.bundle) return JSON.stringify(args ?? {});
		let v = args?.[slot.name];
		if (v === undefined || v === null) v = slot.default;
		if (slot.encode === "json") return JSON.stringify(v ?? {});
		return v;
	});
}

const { spawn } = await import("node:child_process");
// staticServerArgs pins `--bind 127.0.0.1` — see its comment in
// transport/browser.mjs. Shared rather than re-spelled so the two spawns of
// this same server cannot drift on the one argument that is a security control.
const staticServer = spawn("python", staticServerArgs(GAME_PORT, BUILD_DIR), { stdio: "ignore" });

async function waitForServer(url, timeoutMs = 15000) {
  const started = Date.now();
  for (;;) {
    try {
      await new Promise((res, rej) => {
        const req = http.get(url, (r) => { r.resume(); res(); });
        req.on("error", rej);
      });
      return;
    } catch {
      if (Date.now() - started > timeoutMs) throw new Error("server never came up");
      await new Promise(r => setTimeout(r, 200));
    }
  }
}

await waitForServer(`http://localhost:${GAME_PORT}`);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(String(e)));
await page.goto(`http://localhost:${GAME_PORT}`);
await page.waitForFunction((f) => typeof window[f] === "function", BRIDGE.state_fn, { timeout: 60000 });

// clearBridgeVar/settleBridgeVar are the transport's ONE answer to "how long
// after a bridge call does its result land on window" — see the
// BRIDGE_SETTLE_MS comment in transport/browser.mjs. This file used to guess
// 70ms here and 120ms/150ms at three call sites below: four independent guesses
// at one event, any of which could hand back the PREVIOUS action's result.
async function callFn(fnName, args = []) {
  await clearBridgeVar(page, BRIDGE.result_var);
  await page.evaluate(({ fnName, args }) => window[fnName](...args), { fnName, args });
  const json = await settleBridgeVar(page, BRIDGE.result_var);
  return json ? JSON.parse(json) : null;
}

// A DIFFERENT event from the bridge-write settle above, and kept separate on
// purpose: this is time for the GAME to react to the action (animate, advance a
// phase) before its state is sampled, not time for the bridge to write. It was
// spelled 150ms once and 120ms twice; one name, one value, so nobody has to
// wonder whether the difference meant something.
const GAME_REACT_MS = 150;
const gameReact = () => new Promise(r => setTimeout(r, GAME_REACT_MS));

async function dumpState() {
  await clearBridgeVar(page, BRIDGE.state_var);
  await page.evaluate((f) => window[f](), BRIDGE.state_fn);
  const json = await settleBridgeVar(page, BRIDGE.state_var);
  return json ? JSON.parse(json) : null;
}

// project() decides what a text-driven agent can see (the game's own concise
// projection, or the identity default). It lives in its own module so the
// persona-blindness class of defect stays unit-testable. See src/concise.mjs
// for the rule and the incident that put it there.

// --- the session record ------------------------------------------------------
//
// One entry per mutating call, in order, each carrying enough state to say where
// the run was when it happened. Screenshots are recorded against the step index
// they were taken after, which is what turns "run1_cache1.png" from a filename
// into a position in a sequence.
const manifest = {
	kind: "interactive",
	run_tag: RUN_TAG,
	game_root: GAME_ROOT,
	build_dir: BUILD_DIR,
	started_at: new Date().toISOString(),
	seed: null,
	complete: false,
	note: "IN PROGRESS: this session has not called /quit. If it never does, the "
		+ "last step below is where the capture stopped, which is not necessarily "
		+ "where the run stopped.",
	steps: [],
	screenshots: [],
	console_errors: [],
};

function writeManifest() {
	manifest.console_errors = consoleErrors;
	try {
		writeFileSync(path.join(shotsDir, "manifest.json"), JSON.stringify(manifest, null, 2));
	} catch (e) {
		// Never let bookkeeping take down a live playtest session. A warning on
		// stderr is recoverable; a 500 from /act in the middle of a persona run
		// costs the whole session.
		console.error(`WARNING: could not write manifest.json: ${e.message}`);
	}
}

function record(action, args, result, state) {
	// `state` is the game's projected view (project() above): its own `concise`
	// when it has one, the full raw state otherwise. Stored whole per step rather
	// than as a fixed set of columns, because which fields say "where the run
	// was" is game-specific and this file cannot know them — the old columns
	// (phase/air/depth/salvage) were one deckbuilder's names and came back
	// undefined for every other game. Interactive sessions are human-paced, tens
	// of steps, so a per-step snapshot is cheap; prune_run handles retention.
	manifest.steps.push({
		step: manifest.steps.length,
		at: new Date().toISOString(),
		action,
		args,
		refused: result?.refused ?? false,
		reason: result?.reason || undefined,
		state,
	});
	writeManifest();
}

// Written once at startup, so the evidence dir is never a pile of PNGs with no
// index — even if the session dies before its first action.
writeManifest();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const q = Object.fromEntries(url.searchParams.entries());

    // THE GATE. See this file's header SECURITY note. Both checks run before
    // ANY endpoint dispatch, including /state and /errors — a read endpoint on
    // a session that is mid-playtest still discloses the game's whole state to
    // whoever asked, and /quit would let a stray page end the session outright.
    //
    // An Origin header means a browser page sent this, and no legitimate client
    // of this server is a browser page. Checked first because it needs no
    // secret and costs nothing.
    if (req.headers.origin !== undefined) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: "refused: this request carries an Origin header, so it came from a web page. "
          + "This server is a local CLI tool; it is never driven from a browser.",
      }));
      return;
    }
    if (!tokenOk(q.token)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: "refused: missing or wrong ?token=. The session token was printed once when this "
          + "server started; append &token=<it> to every request.",
      }));
      return;
    }
    // `token` is a transport concern, not an action argument — strip it before
    // anything downstream reads the query as an args object. Leaving it in
    // would put the session secret into /act's `payload`, and from there into
    // every manifest step this run writes.
    delete q.token;
    let body;
    if (url.pathname === "/reset") {
      // Through the catalog like everything else, so a game whose reset takes
      // more than a seed (a difficulty, a starting deck) needs no change here.
      const name = CONFIG.reset_action ?? "start_run";
      const def = ACTION_DEFS[name];
      if (!def) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `reset action "${name}" is not in the catalog` }));
        return;
      }
      const seed = Number(q.seed || 1);
      body = await callFn(def.fn, buildArgs(name, { seed }));
      await gameReact();
      body = { act_result: body, state: project(await dumpState()) };
      // THE SEED IS THE WHOLE POINT OF THE MANIFEST, so it is recorded here, at
      // the one moment it is known, rather than reconstructed later from a log.
      // A second /reset starts a new run in the same session -- the M8 Confused
      // pass played three -- so seeds accumulate rather than overwrite.
      if (manifest.seed === null) manifest.seed = seed;
      else if (manifest.seed !== seed) {
        manifest.seeds = manifest.seeds ?? [manifest.seed];
        manifest.seeds.push(seed);
      }
      record(name, { seed }, body, body.state);
    } else if (url.pathname === "/state") {
      body = project(await dumpState());
    } else if (url.pathname === "/raw") {
      body = await dumpState();
    } else if (url.pathname === "/legal") {
      const s = await dumpState();
      body = s?.legal_moves ?? null;
    } else if (url.pathname === "/act") {
      const action = q.action;
      const def = ACTION_DEFS[action];
      if (!def) {
        // A 400 rather than a call into the void. The old code derived the
        // function name from the action name and called whatever that produced,
        // so a typo reached the page as `window.godotDebugPlayCrad(...)` and
        // came back as a Playwright evaluate error 500 pages deep.
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: `unknown action "${action}"`,
          known: Object.keys(ACTION_DEFS).sort(),
        }));
        return;
      }
      const payload = { ...q };
      delete payload.action;
      for (const k of Object.keys(payload)) {
        if (/^-?\d+$/.test(payload[k])) payload[k] = Number(payload[k]);
      }
      // Missing required args are refused here, where the message can name them,
      // rather than by the game — which sees only the values it did receive.
      const missing = (def.required ?? []).filter(
        (n) => payload[n] === undefined || payload[n] === null,
      );
      if (missing.length) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `"${action}" needs: ${missing.join(", ")}` }));
        return;
      }
      const act_result = await callFn(def.fn, buildArgs(action, payload));
      await gameReact();
      // `refused` is DERIVED AND HOISTED, not left for the caller to notice.
      // Every response already carried the bridge's refusal in `act_result` and
      // a caller reading `state` saw a successful-looking reply that had changed
      // nothing (the same incident). A boolean at the top level is the difference
      // between "you must check" and "you cannot miss it".
      const refused = act_result != null && act_result.success === false;
      body = { refused, reason: refused ? (act_result.reason ?? "") : undefined,
               act_result, state: project(await dumpState()) };
      // Refusals are recorded too. An action the game declined is a fact about
      // the run and half of what a boundary-seeking role is there to find.
      record(action, payload, body, body.state);
    } else if (url.pathname === "/shot") {
      // Sanitized, because this query parameter becomes a FILENAME — see
      // safeShotName. `?name=../../../.ssh/authorized_keys` used to resolve
      // straight out of the evidence directory.
      const name = safeShotName(q.name ?? `shot_${Date.now()}`);
      if (name === null) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: `/shot?name= must contain at least one of [A-Za-z0-9._-] after path components are `
            + `stripped (got ${JSON.stringify(q.name)})`,
        }));
        return;
      }
      const file = path.join(shotsDir, `${name}.png`);
      // SETTLE BEFORE CAPTURING, because a screenshot taken the instant an action
      // returns catches whatever was still animating. On a real game this was filed
      // as a "stale screenshot rendering race" and reproduces exactly once per action:
      // the first capture after `end_turn` differs from the next nine, by 136
      // pixels, and the difference is a floating damage number mid-fade. Nothing
      // was stale -- Air, Block, HP and intents matched the settled frame
      // byte-for-byte -- but a reader cannot know that, and "the screenshot
      // disagrees with the state" is the most alarming thing an evidence bundle
      // can appear to say.
      //
      // Capture until two consecutive frames are identical. `?settle=0` opts out
      // for a role deliberately photographing motion.
      //
      // `settled` means ONE thing: two consecutive frames came back identical. It
      // is false when settling was skipped, because the first draft set it true
      // there -- reporting a property it had explicitly not checked, which is the
      // same lie as a manifest that cannot say it was truncated.
      const wantSettle = q.settle !== "0";
      let shot = await page.screenshot();
      let settled = false;
      let frames = 1;
      if (wantSettle) {
        for (let i = 0; i < 8; i++) {
          await new Promise(r => setTimeout(r, 120));
          const next = await page.screenshot();
          frames++;
          const same = next.equals(shot);
          shot = next;
          if (same) { settled = true; break; }
        }
      }
      writeFileSync(file, shot);
      // Anchored to the step it follows. A filename tells you what the author
      // thought they were photographing; the step index tells you what the run
      // was actually doing, and only one of those survives a disagreement.
      // `null`, not -1, when nothing has happened yet. Photographing the title
      // screen before the first action is a normal opening move for a persona
      // pass, and "-1" reads as an off-by-one in someone else's code.
      const afterStep = manifest.steps.length ? manifest.steps.length - 1 : null;
      manifest.screenshots.push({
        name: `${name}.png`,
        after_step: afterStep,
        at: new Date().toISOString(),
        // `settled: false` means the frame was STILL CHANGING when the budget ran
        // out, so this image may show a transitional state. Same rule as
        // `complete` above: an artifact that cannot flag its own limits will be
        // read as if it had none.
        settled,
        settle_requested: wantSettle,
        frames,
      });
      writeManifest();
      body = { screenshot: file, after_step: afterStep, settled, settle_requested: wantSettle, frames };
    } else if (url.pathname === "/key") {
      // RAW KEYS, FOR UI-ONLY AFFORDANCES THE BRIDGE CANNOT EXPRESS.
      //
      // Every other write path here goes through the action catalog on purpose:
      // the sim tier and the browser tier must not be able to disagree, and the
      // way to guarantee that is to have one code path. But a game can have
      // controls that change no game state at all -- a help overlay, a deck view,
      // a confirmation toggle -- and those have no bridge action to route
      // through, because there is nothing for the sim tier to model.
      //
      // Without this endpoint such a control is UNREACHABLE BY EVERY AUTOMATED
      // ROLE. A real game hit this the day it built a help screen its spec had
      // required for eight milestones: a docs-blind critic driving through /act
      // could not open it, so the one screen that exists to explain the game
      // would never appear in a single evidence bundle. That is the shape of the
      // gap the affordance discipline exists to close, one level up -- present
      // for a player, invisible to review.
      //
      // IT IS NOT A BACK DOOR INTO GAME STATE, and the guard is honest rather
      // than clever: the key is recorded as a step like everything else, with
      // the state before and after, so a reviewer can see for themselves whether
      // it moved the game. A key that changes the run WILL show up as a state
      // change in the manifest, next to a step that named no action.
      const key = q.key;
      if (!key) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "/key needs ?key=, e.g. /key?key=Escape" }));
        return;
      }
      const before = project(await dumpState());
      await page.keyboard.press(key);
      await gameReact();
      const after = project(await dumpState());
      // Hoisted, for the same reason `refused` is on /act: a caller who has to
      // compare two nested objects to notice something is a caller who will not.
      const changed_state = JSON.stringify(before) !== JSON.stringify(after);
      body = { key, changed_state, state: after };
      record(`key:${key}`, { key }, body, after);
    } else if (url.pathname === "/errors") {
      body = { console_errors: consoleErrors };
    } else if (url.pathname === "/quit") {
      manifest.complete = true;
      manifest.ended_at = new Date().toISOString();
      manifest.note = "Session ended cleanly via /quit. The step list below is the "
        + "whole session.";
      writeManifest();
      res.writeHead(200); res.end("bye");
      await shutdown();
      process.exit(0);
    } else {
      res.writeHead(404); res.end("not found"); return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body, null, 2));
  } catch (err) {
    // MESSAGE ONLY, never the stack. A stack from this process names absolute
    // paths inside the developer's machine and the harness's internal call
    // chain, and it goes out over an HTTP response — the one place here that
    // reaches anything but the operator's own terminal. The stack still lands
    // on stderr, where the operator can read it and nobody else can.
    console.error(err && err.stack ? err.stack : String(err));
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(err?.message ?? err) }));
  }
});

// --- lifecycle ---------------------------------------------------------------
//
// Idempotent, because both /quit and a signal can reach it, and because a
// second Ctrl+C on an already-shutting-down process must not double-kill.
let shuttingDown = false;
async function shutdown() {
	if (shuttingDown) return;
	shuttingDown = true;
	try { await browser.close(); } catch { /* already gone */ }
	try { staticServer.kill(); } catch { /* already gone */ }
	try { server.close(); } catch { /* already gone */ }
}

// Ctrl+C used to leave a headless Chromium AND a python http.server running,
// with the manifest still saying `complete: false` and no reason why. Both
// halves of that are fixed here: the manifest gets an honest interruption note
// (it is already written after every mutating call, so nothing is lost — only
// the CAUSE was missing), and the two child processes actually die.
for (const sig of ["SIGINT", "SIGTERM"]) {
	process.on(sig, () => {
		manifest.ended_at = new Date().toISOString();
		manifest.interrupted = sig;
		manifest.note = `INTERRUPTED by ${sig}: this session was killed rather than ended via /quit. `
			+ `The step list below is everything that ran before the signal — the run may have been `
			+ `mid-action, so treat the last step as possibly incomplete.`;
		writeManifest();
		shutdown().finally(() => process.exit(130));
	});
}

// 127.0.0.1, not every interface. The endpoints below drive a live game session
// and write files; there is no version of this that should answer the LAN.
server.listen(PORT, "127.0.0.1", () => {
	console.log(`control server on 127.0.0.1:${PORT}, game on 127.0.0.1:${GAME_PORT}`);
	// Printed ONCE, here, and never again. Every request needs it.
	console.log(`session token: ${SESSION_TOKEN}`);
	console.log(`  e.g. curl "http://127.0.0.1:${PORT}/state?token=${SESSION_TOKEN}"`);
});
