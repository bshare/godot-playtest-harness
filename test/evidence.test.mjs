// Richer evidence (ROADMAP Tier 2 item 7) + built-in generic-bridge actions.
// Run via `npm test`. No browser, no Godot:
//
//   * the built-in generic actions' VALIDATOR behavior is exercised through
//     `--validate`, the same way harness.test.mjs guards the original silent
//     failures — unknown args, missing required args, catalog precedence;
//   * their ARG MAPPING (step args → bridge fn positional args, including the
//     `pressed` default) is proven end-to-end over the DESKTOP transport
//     against a fake TCP game server, which also proves the manifest records
//     dump_controls' parsed tree and the evidence *_skipped tombstones;
//   * prune_run's video.webm / trace.zip retention runs against fixture
//     bundles, same as the screenshot rules it mirrors.
//
// What genuinely needs a live browser (Playwright video/trace recording, the
// pageerror tag, perf sampling) is NOT faked here — see the transport's own
// code comments; those paths are gated so that with evidence off the browser
// manifest is byte-identical to before.

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { execFileSync, execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = path.join(ROOT, "src", "run_scenario.mjs");
const PRUNE = path.join(ROOT, "src", "prune_run.mjs");

// ---------------------------------------------------------------------------
// Validator behavior for the built-in generic actions
// ---------------------------------------------------------------------------

const EMPTY_CATALOG = { catalog_version: 1, game: "fixture", actions: {} };

function validate(steps, { catalog = EMPTY_CATALOG, config = {} } = {}) {
	const dir = mkdtempSync(path.join(tmpdir(), "evidence-test-"));
	try {
		writeFileSync(path.join(dir, "playtest.actions.json"), JSON.stringify(catalog));
		writeFileSync(path.join(dir, "playtest.config.json"), JSON.stringify({
			game: "fixture",
			action_catalog: "playtest.actions.json",
			build_dir: "build/web-debug",
			...config,
		}));
		const scenarioPath = path.join(dir, "s.json");
		writeFileSync(scenarioPath, JSON.stringify({ name: "s", steps }));
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

test("the six generic actions validate with an EMPTY catalog — that is the point of them", () => {
	const r = validate([
		{ action: "dump_controls", label: "tree" },
		{ action: "click_control", args: { path: "/root/Main/StartButton" } },
		{ action: "press_action", args: { action_name: "ui_accept" } },
		{ action: "press_action", args: { action_name: "move_left", pressed: false } },
		{ action: "send_key", args: { keycode: 32 } },
		{ action: "send_key", args: { keycode: 32, pressed: false } },
		{ action: "set_slider", args: { path: "/root/UI/Volume", value: 0.7 } },
		{ action: "select_tab", args: { path: "/root/UI/Tabs", tab_index: 2 } },
	]);
	assert.equal(r.ok, true, r.out);
});

test("generic actions hard-fail on a missing required arg", () => {
	for (const [step, missing] of [
		[{ action: "click_control" }, "path"],
		[{ action: "press_action", args: { pressed: true } }, "action_name"],
		[{ action: "send_key" }, "keycode"],
		[{ action: "set_slider", args: { path: "/root/UI/V" } }, "value"],
		[{ action: "select_tab", args: { tab_index: 1 } }, "path"],
	]) {
		const r = validate([step]);
		assert.equal(r.ok, false, `${step.action} without args.${missing} must be a hard error`);
		assert.match(r.out, new RegExp(missing), `the error must name the missing arg "${missing}"`);
	}
});

test("an unknown args key on a generic action warns but does not fail", () => {
	// (The warning body itself goes to stderr, which the success path does not
	// capture — same convention as harness.test.mjs — so this matches the
	// stdout summary. Two warnings: the unknown "pth" key + zero-assertions.)
	const r = validate([{ action: "click_control", args: { path: "/root/A", pth: "typo" } }]);
	assert.equal(r.ok, true, r.out);
	assert.match(r.out, /2 warning/i);
});

test("a generic-action arg name misplaced at step top level is a hard error", () => {
	// keycode as a sibling of "action" is the same class of incident as the
	// original x/y one — it must never silently vanish.
	const r = validate([{ action: "send_key", keycode: 32 }]);
	assert.equal(r.ok, false, "an arg-shaped top-level key must be a hard error");
	assert.match(r.out, /keycode/);
});

test("expect/expect_reason are valid on generic actions — they produce a real success result", () => {
	const r = validate([
		{ action: "click_control", args: { path: "/root/A" }, expect: "success" },
		{ action: "press_action", args: { action_name: "nope" }, expect: "refused", expect_reason: "no InputMap action" },
	]);
	assert.equal(r.ok, true, r.out);
});

test("a game's catalog wins a name collision with a generic builtin", () => {
	// This game defines its OWN click_control taking `node`. The builtin's
	// `path` spec must not leak in: args.path is now the unknown-key warning,
	// and the catalog's required `node` is what's enforced.
	const catalog = {
		catalog_version: 1,
		game: "fixture",
		actions: {
			click_control: {
				fn: "godotDebugMyOwnClick",
				positional: [{ name: "node" }],
				required: ["node"],
				optional: [],
			},
		},
	};
	const bad = validate([{ action: "click_control", args: { path: "/root/A" } }], { catalog });
	assert.equal(bad.ok, false, "the catalog's required arg must be enforced, not the builtin's");
	assert.match(bad.out, /node/);
	const good = validate([{ action: "click_control", args: { node: "StartButton" } }], { catalog });
	assert.equal(good.ok, true, good.out);
});

// ---------------------------------------------------------------------------
// End-to-end over the desktop transport: arg mapping, dump_controls storage,
// evidence gating and the *_skipped tombstones — all with a fake TCP server.
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

const FAKE_CONTROLS = {
	version: 1,
	controls: [
		{ name: "StartButton", path: "/root/Main/StartButton", class: "Button", text: "Start" },
	],
};

// A fake game bridge: answers ping, echoes every call's fn/args as a success
// result (and records them), serves the controls var.
function startFakeBridge(port) {
	const calls = [];
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
				let resp;
				if (req.op === "ping") {
					resp = { id: req.id, ok: true, result: "pong" };
				} else if (req.op === "call") {
					calls.push({ fn: req.fn, args: req.args });
					resp = { id: req.id, ok: true, result: { success: true, action: req.fn } };
				} else if (req.op === "read" && req.var === "godotDebugLastControls") {
					resp = { id: req.id, ok: true, result: FAKE_CONTROLS };
				} else {
					resp = { id: req.id, ok: true, result: null };
				}
				sock.write(JSON.stringify(resp) + "\n");
			}
		});
		sock.on("close", () => sockets.delete(sock));
		sock.on("error", () => {});
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => resolve({
			calls,
			close: () => new Promise((r) => {
				for (const s of sockets) s.destroy();
				server.close(() => r());
			}),
		}));
	});
}

// Runs the runner as a child process (async, so the in-process fake server
// keeps serving) against a throwaway desktop-transport game repo. Returns the
// run's manifest plus the fake bridge's recorded calls.
async function runDesktopScenario(steps, { configExtra = {}, env = {} } = {}) {
	const dir = mkdtempSync(path.join(tmpdir(), "evidence-e2e-"));
	const port = await getFreePort();
	const fake = await startFakeBridge(port);
	try {
		writeFileSync(path.join(dir, "playtest.actions.json"), JSON.stringify(EMPTY_CATALOG));
		writeFileSync(path.join(dir, "playtest.config.json"), JSON.stringify({
			game: "fixture",
			action_catalog: "playtest.actions.json",
			transport: "desktop",
			desktop: { port, ready_timeout_ms: 8000 },
			...configExtra,
		}));
		const scenarioPath = path.join(dir, "s.json");
		writeFileSync(scenarioPath, JSON.stringify({ name: "e2e", steps }));

		const result = await new Promise((resolve) => {
			execFile("node", [RUNNER, scenarioPath], {
				cwd: dir,
				env: { ...process.env, PLAYTEST_GAME_ROOT: dir, ...env },
				encoding: "utf8",
				timeout: 60000,
			}, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, out: `${stdout}${stderr}` }));
		});

		const runsDir = path.join(dir, "runs");
		const runDirs = existsSync(runsDir) ? readdirSync(runsDir).filter((d) => d !== "_sessions") : [];
		assert.equal(runDirs.length, 1, `expected exactly one run bundle, got ${JSON.stringify(runDirs)}\n${result.out}`);
		const manifest = JSON.parse(readFileSync(path.join(runsDir, runDirs[0], "manifest.json"), "utf8"));
		return { manifest, calls: fake.calls, code: result.code, out: result.out };
	} finally {
		await fake.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

test("generic actions map step args to the right bridge fns and positional args, over the desktop transport", async () => {
	const { manifest, calls, code, out } = await runDesktopScenario([
		{ action: "dump_controls", label: "tree" },
		{ action: "click_control", args: { path: "/root/Main/StartButton" } },
		{ action: "press_action", args: { action_name: "ui_accept" } },         // pressed defaults true
		{ action: "send_key", args: { keycode: 32, pressed: false } },
		{ action: "set_slider", args: { path: "/root/UI/Volume", value: 0.7 } },
		{ action: "select_tab", args: { path: "/root/UI/Tabs", tab_index: 2 }, expect: "success" },
	]);
	assert.equal(code, 0, out);

	assert.deepEqual(calls, [
		{ fn: "godotDebugDumpControls", args: [] },
		{ fn: "godotDebugClickControl", args: ["/root/Main/StartButton"] },
		{ fn: "godotDebugPressAction", args: ["ui_accept", true] },
		{ fn: "godotDebugSendKey", args: [32, false] },
		{ fn: "godotDebugSetSlider", args: ["/root/UI/Volume", 0.7] },
		{ fn: "godotDebugSelectTab", args: ["/root/UI/Tabs", 2] },
	], "each builtin must call its bridge fn with exactly the documented positional args");

	// dump_controls stores the PARSED tree in the step record, like dump_state,
	// and the step's label survives into the manifest.
	const dump = manifest.steps[0];
	assert.equal(dump.label, "tree");
	assert.deepEqual(dump.controls, FAKE_CONTROLS);
	assert.equal(dump.ok, true);

	// The expect check ran and passed on the generic action.
	const tab = manifest.steps[5];
	assert.deepEqual(tab.expect_check, { expect: "success", expect_reason: null, pass: true });
	assert.equal(manifest.steps.every((s) => s.ok), true);
});

test("expect: 'refused' fails a generic-action step whose bridge reported success", async () => {
	const { manifest, code } = await runDesktopScenario([
		{ action: "click_control", args: { path: "/root/A" }, expect: "refused" },
	]);
	assert.equal(manifest.steps[0].ok, false, "the fake bridge said success; expect refused must fail the step");
	assert.match(manifest.steps[0].error, /expected success:false/);
	assert.notEqual(code, 0, "a failed step must fail the run");
});

test("with no evidence config the manifest carries none of the evidence keys — byte-identical default", async () => {
	const { manifest } = await runDesktopScenario([{ action: "dump_controls" }]);
	for (const key of ["video", "trace", "perf", "video_skipped", "trace_skipped", "perf_skipped"]) {
		assert.equal(key in manifest, false, `manifest.${key} must be absent when evidence is off`);
	}
});

test("evidence on a desktop run records the *_skipped tombstones, never fake files", async () => {
	const { manifest, code, out } = await runDesktopScenario(
		[{ action: "dump_controls" }],
		{ configExtra: { evidence: { video: true, trace: true, perf: true } } });
	assert.equal(code, 0, out);
	assert.equal(manifest.video_skipped, "desktop transport");
	assert.equal(manifest.trace_skipped, "desktop transport");
	assert.equal(manifest.perf_skipped, "desktop transport");
	for (const key of ["video", "trace", "perf"]) {
		assert.equal(key in manifest, false, `manifest.${key} must not exist on a desktop run`);
	}
});

test("evidence flags can be forced from the environment", async () => {
	const { manifest } = await runDesktopScenario(
		[{ action: "dump_controls" }],
		{ env: { PLAYTEST_EVIDENCE_VIDEO: "1" } });
	assert.equal(manifest.video_skipped, "desktop transport",
		"PLAYTEST_EVIDENCE_VIDEO=1 must enable the feature without touching the config");
	assert.equal("trace_skipped" in manifest, false, "flags are independent");
});

// ---------------------------------------------------------------------------
// prune_run: video.webm and trace.zip obey the same report-first retention
// ---------------------------------------------------------------------------

function makeBundle({ withReport = true, reportBody, withShots = true } = {}) {
	const base = mkdtempSync(path.join(tmpdir(), "evidence-runs-"));
	const runDir = path.join(base, "runs", "critique_0001");
	mkdirSync(runDir, { recursive: true });
	if (withShots) {
		mkdirSync(path.join(runDir, "screenshots"), { recursive: true });
		for (const n of ["a", "b"]) {
			writeFileSync(path.join(runDir, "screenshots", `beat_${n}.png`), Buffer.alloc(2048, 1));
		}
	}
	writeFileSync(path.join(runDir, "video.webm"), Buffer.alloc(4096, 2));
	writeFileSync(path.join(runDir, "trace.zip"), Buffer.alloc(4096, 3));
	if (withReport) {
		writeFileSync(path.join(runDir, "report.md"), reportBody ??
			"# Critique\n\n## F01 — the flicker\nEvidence: `video.webm` shows it; `beat_a.png` is the still.\n");
	}
	return { base, runDir };
}

function prune(runDir, args = []) {
	try {
		return { ok: true, out: execFileSync("node", [PRUNE, runDir, ...args], { encoding: "utf8" }) };
	} catch (e) {
		return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
	}
}

test("a cited video is kept under its finding id; an uncited trace is deleted with a tombstone", () => {
	const { base, runDir } = makeBundle();
	try {
		const r = prune(runDir);
		assert.equal(r.ok, true, r.out);

		const kept = readdirSync(path.join(runDir, "evidence")).sort();
		assert.deepEqual(kept, ["F01_beat_a.png", "F01_video.webm"]);
		assert.equal(existsSync(path.join(runDir, "video.webm")), false, "the kept video moved to evidence/");
		assert.equal(existsSync(path.join(runDir, "trace.zip")), false, "the uncited trace is gone");

		const tombstone = readFileSync(path.join(runDir, "MANIFEST.md"), "utf8");
		assert.match(tombstone, /trace\.zip/, "the deleted trace's name must be recorded");
		assert.match(tombstone, /beat_b\.png/);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("an uncited video is deleted under the same rule — no special treatment for being big", () => {
	const { base, runDir } = makeBundle({ reportBody: "# Critique\n\n## F01 — x\nEvidence: `beat_a.png`.\n" });
	try {
		const r = prune(runDir);
		assert.equal(r.ok, true, r.out);
		assert.equal(existsSync(path.join(runDir, "video.webm")), false);
		assert.equal(existsSync(path.join(runDir, "trace.zip")), false);
		const tombstone = readFileSync(path.join(runDir, "MANIFEST.md"), "utf8");
		assert.match(tombstone, /video\.webm/);
		assert.match(tombstone, /trace\.zip/);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("prune --dry-run leaves video and trace untouched", () => {
	const { base, runDir } = makeBundle();
	try {
		const r = prune(runDir, ["--dry-run"]);
		assert.equal(r.ok, true, r.out);
		assert.equal(existsSync(path.join(runDir, "video.webm")), true);
		assert.equal(existsSync(path.join(runDir, "trace.zip")), true);
		assert.equal(existsSync(path.join(runDir, "MANIFEST.md")), false);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("prune still refuses without a report when the only evidence is video/trace", () => {
	const { base, runDir } = makeBundle({ withReport: false, withShots: false });
	try {
		const r = prune(runDir);
		assert.equal(r.ok, false, "report-first applies to video/trace exactly as to screenshots");
		assert.equal(existsSync(path.join(runDir, "video.webm")), true, "nothing may be deleted");
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("a bundle with video/trace but NO screenshots directory still prunes", () => {
	const { base, runDir } = makeBundle({ withShots: false, reportBody: "# R\n\n## F02 — y\nSee `trace.zip`.\n" });
	try {
		const r = prune(runDir);
		assert.equal(r.ok, true, r.out);
		assert.deepEqual(readdirSync(path.join(runDir, "evidence")), ["F02_trace.zip"]);
		assert.equal(existsSync(path.join(runDir, "video.webm")), false);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// prune_run: citation matching is WORD-BOUNDED, not a raw substring search.
// `not_shot.png` mentioning "shot.png" as a substring must not count as a
// citation of a DIFFERENT file actually named shot.png — and the direction
// of any remaining ambiguity stays over-keep, never over-delete.
// ---------------------------------------------------------------------------

function makeNamedBundle(shotNames, reportBody) {
	const base = mkdtempSync(path.join(tmpdir(), "evidence-citation-"));
	const runDir = path.join(base, "runs", "critique_0002");
	mkdirSync(path.join(runDir, "screenshots"), { recursive: true });
	for (const n of shotNames) writeFileSync(path.join(runDir, "screenshots", n), Buffer.alloc(1024, 4));
	writeFileSync(path.join(runDir, "report.md"), reportBody);
	return { base, runDir };
}

test("SUBSTRING: a file named shot.png is NOT cited by a report that only mentions not_shot.png", () => {
	const { base, runDir } = makeNamedBundle(
		["shot.png"],
		"# Critique\n\n## F01 — the bug\nSee `not_shot.png` for the repro.\n",
	);
	try {
		const r = prune(runDir);
		assert.equal(r.ok, true, r.out);
		assert.deepEqual(readdirSync(path.join(runDir, "evidence")), [], "nothing was actually cited — evidence/ must be empty");
		const tombstone = readFileSync(path.join(runDir, "MANIFEST.md"), "utf8");
		assert.match(tombstone, /shot\.png/, "shot.png must be recorded as deleted, not silently kept as a false match");
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("SUBSTRING, mirrored: not_shot.png is genuinely cited even though shot.png (a substring of it) is not", () => {
	const { base, runDir } = makeNamedBundle(
		["shot.png", "not_shot.png"],
		"# Critique\n\n## F01 — the bug\nSee `not_shot.png` for the repro.\n",
	);
	try {
		const r = prune(runDir);
		assert.equal(r.ok, true, r.out);
		const kept = readdirSync(path.join(runDir, "evidence")).sort();
		assert.deepEqual(kept, ["F01_not_shot.png"], "the real citation is kept; the substring match is not");
		assert.equal(existsSync(path.join(runDir, "shot.png")), false);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});
