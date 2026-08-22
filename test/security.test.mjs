// Security-posture tests. Run via: npm test
//
// These pin the handful of decisions in this repo that are LOAD-BEARING for
// security rather than for correctness — the kind that keep working perfectly
// after they have been removed, so nothing else notices. Every assertion here
// exists because deleting the thing it guards produces a working harness and a
// worse one.
//
// Two flavors, and the difference matters when you read a green run:
//
//   * BEHAVIORAL — a real function is called and its real output asserted
//     (staticServerArgs, safeShotName's algorithm). These prove the property.
//   * STATIC — the file is read as text and a pattern asserted. Used only where
//     the code cannot be imported without side effects: src/control_server.mjs
//     spawns a python server, launches Chromium and calls process.exit() at
//     module scope, so `import`ing it in a unit test is not an option. Same
//     technique and same honesty caveat as test/addon_contract.test.mjs: a
//     regex cannot follow control flow, so these prove the SHAPE is present,
//     not that it is reached on every path. What they buy is that a future edit
//     cannot quietly delete the gate.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { staticServerArgs } from "../src/transport/browser.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const controlServerSrc = readFileSync(path.join(ROOT, "src", "control_server.mjs"), "utf8");
const browserSrc = readFileSync(path.join(ROOT, "src", "transport", "browser.mjs"), "utf8");

// ---------------------------------------------------------------------------
// A · the static file server binds loopback
// ---------------------------------------------------------------------------

test("the static server argv pins --bind 127.0.0.1", () => {
	const args = staticServerArgs(8062, "/tmp/build/web-debug");
	const i = args.indexOf("--bind");
	assert.notEqual(i, -1,
		"python -m http.server DEFAULTS to 0.0.0.0. What it serves here is the DEBUG web export — " +
		"the build carrying the debug bridge — so without --bind the whole LAN can drive the game.");
	assert.equal(args[i + 1], "127.0.0.1");
	// And the rest of the argv still does its job.
	assert.deepEqual(args, ["-m", "http.server", "8062", "--bind", "127.0.0.1", "--directory", "/tmp/build/web-debug"]);
});

test("both spawns of the static server go through staticServerArgs", () => {
	// The point of the shared helper is that there is no second place to forget
	// --bind. If either file grows its own inline `["-m", "http.server", ...]`
	// again, this fails.
	for (const [name, src] of [["transport/browser.mjs", browserSrc], ["control_server.mjs", controlServerSrc]]) {
		assert.match(src, /staticServerArgs\(/,
			`${name} must build its python-server argv through staticServerArgs`);
		assert.doesNotMatch(src.replace(/^export function staticServerArgs[\s\S]*?\n}/m, ""), /"http\.server"/,
			`${name} still spells out an http.server argv inline — that copy can lose --bind`);
	}
});

test("the control server's own HTTP listener binds 127.0.0.1", () => {
	// STATIC: control_server.mjs cannot be imported (see this file's header).
	assert.match(controlServerSrc, /server\.listen\(PORT,\s*"127\.0\.0\.1"/,
		"server.listen(PORT) alone binds every interface — this server drives a live game and writes files");
});

// ---------------------------------------------------------------------------
// B · control server hardening
// ---------------------------------------------------------------------------

// safeShotName is defined inside control_server.mjs, which cannot be imported.
// Rather than assert a regex about it and call that a test, the algorithm is
// restated here and pinned BEHAVIORALLY, with a static check below that the
// real file still uses the same two operations in the same order. The
// duplication is the honest cost of a module that cannot be loaded.
function safeShotName(raw) {
	const cleaned = path.basename(String(raw ?? "")).replace(/[^A-Za-z0-9._-]/g, "");
	return cleaned.length > 0 ? cleaned : null;
}

test("a screenshot name cannot escape the evidence directory", () => {
	const shotsDir = path.resolve("/evidence/interactive_run1");
	const escapes = [
		"../../evil",
		"../../../.ssh/authorized_keys",
		"..\\..\\windows\\system32\\evil",
		"/etc/passwd",
		"C:/Windows/System32/evil",
		"sub/dir/name",
	];
	for (const raw of escapes) {
		const name = safeShotName(raw);
		if (name === null) continue; // refused outright, which is also fine
		const file = path.join(shotsDir, `${name}.png`);
		assert.equal(path.dirname(path.resolve(file)), shotsDir,
			`"${raw}" resolved to ${file}, outside the evidence dir`);
	}
});

test("a screenshot name with nothing usable in it is refused, not silently renamed", () => {
	// Falling back to a generated name would write a file the caller cannot
	// find, under a name they never chose — a quiet wrong answer.
	assert.equal(safeShotName("../.."), "..", "basename leaves this, and it stays inside the dir");
	assert.equal(safeShotName("/"), null);
	assert.equal(safeShotName("???"), null);
	assert.equal(safeShotName(""), null);
	// Ordinary names survive untouched — the sanitizer must not tax normal use.
	assert.equal(safeShotName("run1_cache1"), "run1_cache1");
	assert.equal(safeShotName("boot.title-screen_2"), "boot.title-screen_2");
});

test("control_server sanitizes /shot?name= with basename + an allowlist alphabet", () => {
	// STATIC: pins that the real file still does both operations. Either one
	// alone is insufficient — basename leaves ":" and leading dots, and the
	// alphabet filter alone leaves "..%2f.." style input intact once decoded.
	assert.match(controlServerSrc, /path\.basename\(String\(raw[\s\S]{0,80}A-Za-z0-9\._-/,
		"safeShotName must basename FIRST and then strip to a conservative alphabet");
	assert.match(controlServerSrc, /const name = safeShotName\(/,
		"the /shot handler must route ?name= through safeShotName");
});

test("every request is token-gated, in constant time, before any dispatch", () => {
	// STATIC. The token is what actually stops a hostile page: every endpoint
	// here is a GET that mutates, and `<img src>` needs no CORS permission.
	assert.match(controlServerSrc, /randomBytes\(\d+\)\.toString\("hex"\)/,
		"the session token must come from the CSPRNG");
	assert.match(controlServerSrc, /timingSafeEqual\(/,
		"token comparison must be constant-time — a === leaks the prefix");
	assert.match(controlServerSrc, /if \(!tokenOk\(q\.token\)\)[\s\S]{0,200}403/,
		"a missing/wrong token must be a 403");
	// And it must be printed, exactly once, or the operator cannot use it.
	assert.match(controlServerSrc, /session token: \$\{SESSION_TOKEN\}/);
	// The gate must sit ABOVE the endpoint if/else, not inside one branch.
	const gateAt = controlServerSrc.indexOf("if (!tokenOk(q.token))");
	const firstEndpointAt = controlServerSrc.indexOf('url.pathname === "/reset"');
	assert.ok(gateAt !== -1 && firstEndpointAt !== -1 && gateAt < firstEndpointAt,
		"the token check must run before endpoint dispatch — /state and /quit need it as much as /act");
});

test("the session token never reaches the manifest", () => {
	// /act copies the whole query string into `payload`, and payload is recorded
	// as the step's args. Without the delete, every step of every run would
	// carry the session secret into a file people paste into bug reports.
	assert.match(controlServerSrc, /delete q\.token;/);
	const deleteAt = controlServerSrc.indexOf("delete q.token;");
	const payloadAt = controlServerSrc.indexOf("const payload = { ...q };");
	assert.ok(deleteAt < payloadAt, "the token must be stripped before /act copies the query into args");
});

test("a request carrying an Origin header is refused", () => {
	// STATIC. A CLI client sends no Origin; a web page always does. This is the
	// cheap second wall behind the token.
	assert.match(controlServerSrc, /req\.headers\.origin !== undefined[\s\S]{0,300}403/,
		"any Origin header at all must be a 403 — not just a mismatched one");
});

test("a 500 returns err.message, never err.stack", () => {
	assert.doesNotMatch(controlServerSrc, /res\.end\(JSON\.stringify\(\{ error: String\(err && err\.stack/,
		"a stack in an HTTP response discloses absolute paths and the internal call chain");
	assert.match(controlServerSrc, /error: String\(err\?\.message \?\? err\)/);
});

test("the dead serveStatic() stub is gone", () => {
	// It was unreachable AND broken: it called require() in an ESM module, so
	// it would have thrown on the first call it never received.
	assert.doesNotMatch(controlServerSrc, /function serveStatic/);
	assert.doesNotMatch(controlServerSrc, /require\("node:child_process"\)/);
});

test("control_server reads bridge fn/var names from CONFIG.bridge", () => {
	// A game is allowed to rename its bridge functions (BRIDGE_CONTRACT.md, and
	// playtest.config.json's `bridge` block exists to declare it). run_scenario
	// honors that; this file used to hardcode four literals, so the same game
	// was drivable by one and not the other.
	assert.match(controlServerSrc, /\.\.\.\(CONFIG\.bridge \?\? \{\}\)/);
	for (const use of ["BRIDGE.state_fn", "BRIDGE.state_var", "BRIDGE.result_var"]) {
		assert.ok(controlServerSrc.includes(use), `${use} must be used rather than a literal`);
	}
	// No stragglers: the literals may appear ONCE each, as the default in the
	// BRIDGE object, and nowhere else.
	for (const literal of ["godotDebugDumpState", "godotDebugLastState", "godotDebugLastActionResult"]) {
		const count = controlServerSrc.split(`"${literal}"`).length - 1;
		assert.equal(count, 1, `"${literal}" appears ${count}x — it belongs only in the BRIDGE defaults`);
	}
});

// ---------------------------------------------------------------------------
// D · signal lifecycle
// ---------------------------------------------------------------------------

test("control_server installs SIGINT/SIGTERM handlers that flush and clean up", () => {
	assert.match(controlServerSrc, /\["SIGINT", "SIGTERM"\]/,
		"Ctrl+C used to leak Chromium and the python server, and left the manifest unable to say why it stopped");
	assert.match(controlServerSrc, /manifest\.interrupted = sig/,
		"the manifest must record that it was interrupted, and by what");
	assert.match(controlServerSrc, /let shuttingDown = false/,
		"shutdown must be idempotent — /quit and a signal can both reach it");
});

// ---------------------------------------------------------------------------
// H · misc
// ---------------------------------------------------------------------------

// safeFileLabel lives inside run_scenario.mjs, which exits on import without a
// game config. Same arrangement as safeShotName above: the algorithm restated
// and pinned behaviorally, plus a static check that the real file still uses it
// at every path.join that consumes a label.
function safeFileLabel(raw, fallback) {
	const cleaned = path.basename(String(raw ?? "")).replace(/[^A-Za-z0-9._-]/g, "_");
	return /[A-Za-z0-9_-]/.test(cleaned) ? cleaned : fallback;
}

test("a step label cannot write a screenshot outside the run bundle", () => {
	const shotsDir = path.resolve("/runs/scenario_x/screenshots");
	for (const raw of ["../../evil", "../../../etc/cron.d/x", "..\\..\\evil", "/tmp/evil", "a/b/c"]) {
		const label = safeFileLabel(raw, "step_0");
		const file = path.resolve(path.join(shotsDir, `${label}.png`));
		assert.equal(path.dirname(file), shotsDir, `"${raw}" escaped to ${file}`);
	}
});

test("label sanitizing keeps ordinary labels readable", () => {
	// This runs on EVERY screenshot of every run, so it must not mangle normal
	// authoring. The filename is how a reviewer finds the shot.
	assert.equal(safeFileLabel("helium_check", "fb"), "helium_check");
	assert.equal(safeFileLabel("boot.title-screen_2", "fb"), "boot.title-screen_2");
	// And a label that is merely awkward — not hostile — still yields something
	// recognizable rather than being thrown away.
	assert.equal(safeFileLabel("shop: after buying", "fb"), "shop__after_buying");
	assert.equal(safeFileLabel("", "step_7"), "step_7");
	assert.equal(safeFileLabel("...", "step_7"), "step_7");
});

test("every screenshot path.join in run_scenario goes through safeFileLabel", () => {
	const runner = readFileSync(path.join(ROOT, "src", "run_scenario.mjs"), "utf8");
	const joins = [...runner.matchAll(/path\.join\(screenshotsDir, ([^)]*)\)/g)].map((m) => m[1]);
	assert.ok(joins.length >= 4, `expected several screenshot joins, found ${joins.length}`);
	for (const arg of joins) {
		// A string literal ("boot_00_first_paint.png") is safe by construction.
		if (/^"[^"]*"$/.test(arg)) continue;
		assert.match(arg, /^`\$\{(label|stopLabel)\}\.png`$/,
			`a screenshot filename is built from something unsanitized: ${arg}`);
	}
	// …and both of those names must be assigned from safeFileLabel.
	for (const m of runner.matchAll(/const (label|stopLabel) = ([^;]*);/g)) {
		assert.match(m[2], /safeFileLabel\(/,
			`${m[1]} is assigned without sanitizing: ${m[2]}`);
	}
});

test("--validate does not execute the game's game_module — proven, not asserted", () => {
	// BEHAVIORAL, and the one that actually settles the question: a game_module
	// that writes a file on load. If --validate ever imports it again, the file
	// appears and this fails. No amount of regex reading proves this; running it
	// does.
	const dir = mkdtempSync(path.join(tmpdir(), "validate-import-"));
	try {
		const marker = path.join(dir, "IT_RAN.txt");
		writeFileSync(path.join(dir, "rules.mjs"),
			`import { writeFileSync } from "node:fs";\n` +
			`writeFileSync(${JSON.stringify(marker)}, "the game module executed");\n` +
			`export const consistencyRules = {};\n`);
		writeFileSync(path.join(dir, "playtest.actions.json"), JSON.stringify({
			catalog_version: 1, game: "fixture",
			actions: { do_thing: { fn: "godotDebugDoThing", positional: [], required: [], optional: [] } },
		}));
		writeFileSync(path.join(dir, "playtest.config.json"), JSON.stringify({
			game: "fixture",
			action_catalog: "playtest.actions.json",
			build_dir: "build/web-debug",
			game_module: "rules.mjs",
		}));
		const scenarioPath = path.join(dir, "s.json");
		writeFileSync(scenarioPath, JSON.stringify({ name: "s", steps: [{ action: "do_thing" }] }));

		execFileSync("node", [path.join(ROOT, "src", "run_scenario.mjs"), "--validate", scenarioPath], {
			cwd: dir,
			env: { ...process.env, PLAYTEST_GAME_ROOT: dir },
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});

		assert.equal(existsSync(marker), false,
			"--validate is advertised as a static pre-flight needing no browser, no game and no " +
			"npm install. It executed code out of the game repo.");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("--validate never imports the game's JavaScript", () => {
	// M-3. `--validate` is advertised as a cheap STATIC pre-flight that needs no
	// browser, no game and no npm install. A top-level `await import(game_module)`
	// made it execute arbitrary code out of the game repo on the way in, which
	// makes the advertisement false for exactly the case it was written for:
	// checking a scenario or config you do not fully trust yet.
	const runner = readFileSync(path.join(ROOT, "src", "run_scenario.mjs"), "utf8");
	const importAt = runner.indexOf("await import(pathToFileURL(path.resolve(GAME_ROOT, CONFIG.game_module))");
	assert.notEqual(importAt, -1, "the game_module import must still exist — it is how rules load at runtime");
	// It must live INSIDE a function, not at module scope. The enclosing
	// function's opening line is what proves it.
	const before = runner.slice(0, importAt);
	const lastFunc = before.lastIndexOf("async function ");
	const lastTopLevelStmt = before.lastIndexOf("\nconst CONSISTENCY_RULES");
	assert.ok(lastFunc > lastTopLevelStmt,
		"the game_module import must sit inside a function, reached only when assert_consistent runs");
	assert.match(runner.slice(lastFunc, lastFunc + 60), /async function consistencyRules/);
	assert.match(runner, /let CONSISTENCY_RULES = null;/,
		"null (not {}) is the 'not loaded yet' marker, so the import happens at most once");
});

// ---------------------------------------------------------------------------
// H · CI workflow permissions
// ---------------------------------------------------------------------------

test("the test workflow drops its GITHUB_TOKEN to read-only", () => {
	const wf = readFileSync(path.join(ROOT, ".github", "workflows", "test.yml"), "utf8");
	assert.match(wf, /^permissions:\s*$/m);
	assert.match(wf, /^\s+contents: read\s*$/m,
		"without an explicit permissions block the job's token inherits the repo default, which can be write");
});
