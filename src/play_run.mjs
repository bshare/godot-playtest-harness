#!/usr/bin/env node
/**
 * play_run.mjs — play a whole run in the BROWSER tier, turn by turn.
 *
 *   node src/play_run.mjs --game DIR --seed 900 --policy optimiser --max-turns 400 \
 *                         --screenshot-every 50
 *   node src/play_run.mjs --game DIR --seed 900 --policy optimiser --max-turns 200 --parity
 *
 * A scenario is committed to before it runs: every step after a failure was
 * planned blind to that failure. This is the other shape — a request/response
 * loop where the next action is chosen from `legal_moves` against the state the
 * game is actually in. That is what a real playthrough looks like, and it is
 * what turns an interesting seed from the sim tier into something you can watch.
 *
 * --parity is the check the two tiers exist to make possible. Same seed, same
 * policy, same code, one running headless and one under a browser: if the state
 * hashes ever differ, one of the tiers is not playing the game you think it is.
 * Everything measured on the cheap tier rests on that assumption, and until this
 * flag existed it had never actually been tested.
 *
 * NOTE: the server/browser plumbing below is deliberately a small copy of
 * run_scenario.mjs's rather than a refactor of it. run_scenario is 2000+ lines
 * of load-bearing, proven code; a driver this different is not worth destabilising
 * it for. If a third driver ever appears, extract then.
 */

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { locateGodot } from "./export_build.mjs";
// The arg parser is shared across play_run/batch/sweep_runs (one bespoke
// version per tool used to mean one tool at a time forgot to split
// `--flag=value`; batch.mjs's version already handled it and was tested, so
// it is the shared implementation now). Re-exported so existing importers of
// play_run.mjs's own `parseArgs` keep working unchanged.
import { parseArgs } from "./batch.mjs";
export { parseArgs };

/**
 * Resolve an ABSOLUTE python binary path — `python` then `python3`, PATH-only
 * (mirrors export_build.mjs's locateGodot, same reasoning: a bare name handed
 * to spawn with cwd set to the game directory would let a malicious game
 * repo's own python.exe/python3.exe run in place of the real interpreter on
 * Windows, where cwd is searched before PATH). Returns null rather than
 * throwing, so the caller decides how to report "none found".
 */
export function locatePython(env = process.env) {
    const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
    const exts = process.platform === "win32" ? [".exe", ""] : [""];
    // .cmd/.bat deliberately NOT scanned: Node spawn() without a shell cannot
    // execute batch files (EINVAL), and adding shell:true would reopen the
    // argument-injection risk this file documents. A batch-file-only install
    // falls through to the "none found" error, which names the env override.
    for (const name of ["python", "python3"]) {
        for (const dir of dirs) {
            for (const ext of exts) {
                const candidate = path.join(dir, name + ext);
                if (existsSync(candidate)) return candidate;
            }
        }
    }
    return null;
}

/**
 * Everything decided before the browser launches, in one testable place.
 * Precedence rules live here and nowhere else — notably PORT, where an env
 * override outranks the flag outranks the game's config outranks the default.
 */
export function resolveConfig({ argv = [], env = {}, cwd = process.cwd() } = {}) {
    const opts = parseArgs(argv);
    const GAME_ROOT = path.resolve(opts.game ?? env.PLAYTEST_GAME_ROOT ?? cwd);
    const CONFIG = JSON.parse(readFileSync(path.join(GAME_ROOT, "playtest.config.json"), "utf8"));
    const PORT = Number(env.PLAYTEST_PORT ?? opts.port ?? CONFIG.port ?? 8062);
    const POLICY = String(opts.policy ?? "random");
    return {
        opts,
        GAME_ROOT,
        CONFIG,
        BUILD_DIR: path.resolve(GAME_ROOT, CONFIG.build_dir ?? "build/web-debug"),
        RUNS_DIR: path.resolve(GAME_ROOT, CONFIG.runs_dir ?? "runs"),
        PORT,
        BASE_URL: `http://localhost:${PORT}`,
        BOOT_SEQUENCE: CONFIG.boot_sequence ?? [],
        SEED: Number(opts.seed ?? 1),
        POLICY,
        MAX_TURNS: Number(opts["max-turns"] ?? 200),
        SHOT_EVERY: Number(opts["screenshot-every"] ?? 0),
        /**
         * Normally the same policy runs on both tiers. --sim-policy deliberately
         * runs a DIFFERENT one on the sim side, which must make parity fail at
         * turn one. That is the negative control, and it is not optional
         * discipline: a parity check that has never been seen to fail is
         * indistinguishable from one that compares nothing, and this one passed
         * 40/40 on its first run.
         */
        SIM_POLICY: String(opts["sim-policy"] ?? POLICY),
        /**
         * These five are the adapter-delegating bridge functions, not ordinary
         * game actions. A game whose bridge only exposes hand-written per-action
         * callbacks cannot be driven by this tool — that is the point of the
         * shared adapter, and the sim_reset error in main() says so rather than
         * failing on an undefined call.
         */
        FN: {
            simReset: "godotDebugSimReset",
            legalMoves: "godotDebugLegalMoves",
            policyStep: "godotDebugPolicyStep",
            stateHash: "godotDebugStateHash",
            dumpState: CONFIG.bridge?.state_fn ?? "godotDebugDumpState",
            resultVar: CONFIG.bridge?.result_var ?? "godotDebugLastActionResult",
            stateVar: CONFIG.bridge?.state_var ?? "godotDebugLastState",
        },
    };
}

/** The manifest's outcome column, from the final state and why the loop stopped. */
export function deriveOutcome(finalState, stopped) {
    return finalState?.sim?.game_over
        ? (finalState?.sim?.player?.is_dead ? "LOST" : "WON")
        : (stopped === "max_turns" ? "TIMEOUT" : "STOPPED");
}

/**
 * The end-of-run parity verdict when no turn diverged. "Zero turns matched" is
 * not a pass: without that rule, a bridge that fails on turn one reports parity
 * OK and the check that was supposed to validate the cheap tier validates nothing.
 */
export function parityVerdict(browserTurns, simTurns) {
    const compared = Math.min(browserTurns, simTurns);
    if (compared === 0) {
        return { ok: false, reason: "no turns were compared", sim_turns: simTurns, browser_turns: browserTurns };
    }
    // Unequal turn counts mean part of one run was NEVER compared — the browser
    // playing past the end of the sim trace (the common case whenever the game
    // ends before max_turns) used to report "parity OK" while its trailing
    // turns went entirely unchecked. A verdict must not claim more than it
    // verified: mismatched lengths are their own failure, with the compared
    // prefix reported so the reader knows how far the evidence actually goes.
    if (browserTurns !== simTurns) {
        return {
            ok: false,
            reason: `turn-count mismatch: browser played ${browserTurns} turns, sim trace has ${simTurns} — ` +
                `only the first ${compared} were compared; the rest are unverified`,
            turns_compared: compared, sim_turns: simTurns, browser_turns: browserTurns,
        };
    }
    return { ok: true, turns_compared: compared, sim_turns: simTurns, browser_turns: browserTurns };
}

async function call(page, FN, fnName, args = []) {
    await page.evaluate(({ fnName, args }) => window[fnName](...args), { fnName, args });
    await sleep(60);
    const json = await page.evaluate((v) => window[v], FN.resultVar);
    return json ? JSON.parse(json) : null;
}

async function dumpState(page, FN) {
    await page.evaluate((f) => window[f](), FN.dumpState);
    await sleep(60);
    const json = await page.evaluate((v) => window[v], FN.stateVar);
    return json ? JSON.parse(json) : null;
}

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
            if (Date.now() - started > timeoutMs) throw new Error(`server never came up at ${url}`);
            await sleep(200);
        }
    }
}

/** Run the same seed and policy on the headless tier, and return its per-turn hashes. */
async function simTrace({ gameRoot, runs = 1, seed, policy, maxTurns, outPath }) {
    // ABSOLUTE path only — never a bare "godot" handed to spawn with cwd set
    // to the game directory (Windows searches that cwd before PATH). GODOT
    // is kept as a legacy alias for GODOT_BIN.
    const godot = locateGodot({ ...process.env, GODOT_BIN: process.env.GODOT_BIN ?? process.env.GODOT });
    if (!godot) {
        throw new Error(
            "no Godot binary found: set GODOT_BIN (or GODOT) to the executable's full path, " +
            "or put `godot` or `godot4` on PATH.",
        );
    }
    const args = [
        "--headless", "-s", "res://tools/sim/sim_runner.gd", "--",
        `--runs=${runs}`, `--seed=${seed}`, `--policy=${policy}`,
        `--max-turns=${maxTurns}`, `--out=${outPath}`, "--trace",
    ];
    await new Promise((res, rej) => {
        const proc = spawn(godot, args, { cwd: gameRoot, stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        proc.stderr.on("data", (d) => { stderr += d.toString(); });
        proc.on("close", (code) => code === 0 ? res() : rej(new Error(`sim exited ${code}\n${stderr.slice(-1500)}`)));
        proc.on("error", rej);
    });
    const [record] = readFileSync(outPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    // An empty sim output otherwise surfaces two calls later as "Cannot read
    // properties of undefined" — the real cause (the file) lost from the message.
    if (!record) throw new Error(`sim produced no records at ${outPath} — cannot run a parity check against an empty trace`);
    return record;
}

async function main() {
    const { opts, GAME_ROOT, CONFIG, BUILD_DIR, RUNS_DIR, PORT, BASE_URL, BOOT_SEQUENCE,
            SEED, POLICY, MAX_TURNS, SHOT_EVERY, SIM_POLICY, FN } =
        resolveConfig({ argv: process.argv.slice(2), env: process.env });

    if (!existsSync(BUILD_DIR)) throw new Error(`no debug build at ${BUILD_DIR} — export it first`);

    const { chromium } = await import("playwright");
    const runId = `play_${POLICY}_seed${SEED}_${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const runDir = path.join(RUNS_DIR, runId);
    const shotsDir = path.join(runDir, "screenshots");
    mkdirSync(shotsDir, { recursive: true });

    // Kick the sim off first when checking parity: it is the cheap side, and a
    // sim that cannot even run makes the browser half pointless.
    let sim = null;
    if (opts.parity) {
        console.log(`sim tier: seed ${SEED}, policy ${SIM_POLICY}, ${MAX_TURNS} turns...`);
        if (SIM_POLICY !== POLICY) console.log(`  NEGATIVE CONTROL: sim=${SIM_POLICY} vs browser=${POLICY} — parity MUST fail`);
        sim = await simTrace({ gameRoot: GAME_ROOT, seed: SEED, policy: SIM_POLICY, maxTurns: MAX_TURNS, outPath: path.join(runDir, "sim.jsonl") });
        console.log(`  ${sim.trace.length} turns, outcome ${sim.outcome}`);
    }

    await new Promise((resolve, reject) => {
        const probe = http.createServer();
        probe.once("error", (err) => reject(err.code === "EADDRINUSE"
            ? new Error(`Port ${PORT} already in use — a leftover server here would silently serve the WRONG build. Use --port.`)
            : err));
        probe.once("listening", () => probe.close(resolve));
        probe.listen(PORT);
    });

    // ABSOLUTE path only (see locatePython above), and --bind 127.0.0.1: this
    // server has no auth and serves whatever debug build is in BUILD_DIR —
    // binding to all interfaces would expose it to the LAN.
    const pythonBin = locatePython(process.env);
    if (!pythonBin) {
        throw new Error(
            "no python interpreter found: play_run.mjs serves the debug build locally via " +
            "`python -m http.server` (checked as `python` then `python3`). Put one on PATH, " +
            "or run a static file server yourself and pass --port to match it.",
        );
    }
    const server = spawn(pythonBin, ["-m", "http.server", String(PORT), "--bind", "127.0.0.1", "--directory", BUILD_DIR], { stdio: "ignore" });
    // A spawn failure here (e.g. the resolved path stopped being executable
    // between the check above and now) must not crash the process with a raw
    // ENOENT stack — mirrors simTrace's proc.on("error") above.
    let serverSpawnError = null;
    server.on("error", (err) => {
        serverSpawnError = new Error(`failed to start the local build server (${pythonBin}): ${err.message}`);
    });
    const manifest = {
        kind: "play_run",
        seed: SEED, policy: POLICY, sim_policy: SIM_POLICY, max_turns: MAX_TURNS,
        started_at: new Date().toISOString(),
        build_dir: BUILD_DIR,
        console_errors: [],
        turns: [],
        parity: null,
        outcome: null,
    };

    let browser;
    try {
        // Race the poll against the spawn's own error event, so a missing/
        // unexecutable python surfaces its real cause immediately instead of
        // a generic "server never came up" after the full poll timeout.
        await Promise.race([
            waitForServer(BASE_URL),
            new Promise((_, reject) => {
                server.on("error", () => reject(serverSpawnError));
                if (serverSpawnError) reject(serverSpawnError);
            }),
        ]);
        const browserExe = process.env.PLAYWRIGHT_EXECUTABLE_PATH ?? CONFIG.browser_executable ?? undefined;
        browser = await chromium.launch({ headless: process.env.HEADED !== "1", ...(browserExe ? { executablePath: browserExe } : {}) });
        const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
        page.on("console", (m) => { if (m.type() === "error") manifest.console_errors.push(m.text()); });
        page.on("pageerror", (e) => manifest.console_errors.push(String(e)));

        await page.goto(BASE_URL);
        await page.waitForFunction((f) => typeof window[f] === "function", FN.dumpState, { timeout: 60000 });

        for (const step of BOOT_SEQUENCE) {
            await call(page, FN, step.fn, step.args ?? []);
            await sleep(200);
        }

        const reset = await call(page, FN, FN.simReset, [SEED]);
        if (!reset?.success) {
            throw new Error(
                `${FN.simReset} unavailable or failed. play_run.mjs requires a bridge that delegates ` +
                `to the shared adapter (sim_reset / legal_moves / policy_step / state_hash). See SIM_TIER.md.`);
        }
        await sleep(300);

        // The turn counter is the count of SUCCESSFUL turns, matching the sim
        // runner exactly. Both `random` and any scripted policy are seeded off
        // it, so counting attempts instead of successes would desynchronise the
        // two tiers on the first rejected action — a parity failure with no
        // cause in the game at all.
        let turn = 0;
        let stopped = "max_turns";
        while (turn < MAX_TURNS) {
            const result = await call(page, FN, FN.policyStep, [POLICY, turn]);
            if (!result?.success) { stopped = result?.reason ?? "policy_step_failed"; break; }
            turn++;

            const record = { turn, chosen: result.chosen, hash: result.state_hash };

            if (sim) {
                const expected = sim.trace[turn - 1];
                if (expected && expected.hash !== result.state_hash) {
                    record.parity = { expected: expected.hash, got: result.state_hash, sim_action: expected.action };
                    manifest.parity = {
                        ok: false,
                        diverged_at_turn: turn,
                        sim: { action: expected.action, args: expected.args, hash: expected.hash },
                        browser: { chosen: result.chosen, hash: result.state_hash },
                    };
                    manifest.turns.push(record);
                    // Stop at the FIRST divergence. Every turn after it is
                    // measured against a state the two tiers no longer share,
                    // so continuing would produce a wall of consequential
                    // mismatches around one real cause.
                    stopped = "parity_divergence";
                    break;
                }
            }

            manifest.turns.push(record);

            if (SHOT_EVERY > 0 && turn % SHOT_EVERY === 0) {
                const file = path.join(shotsDir, `turn_${String(turn).padStart(5, "0")}.png`);
                await page.screenshot({ path: file });
                // Forward slashes on every OS: manifests are portable artifacts,
                // and win32 backslashes here were unresolvable pointers on Linux.
                record.screenshot = path.relative(runDir, file).split(path.sep).join("/");
            }
        }

        const finalState = await dumpState(page, FN);
        manifest.final_state = finalState;
        manifest.turns_played = turn;
        manifest.stopped_because = stopped;
        manifest.outcome = deriveOutcome(finalState, stopped);

        await page.screenshot({ path: path.join(shotsDir, "final.png") });

        if (sim && manifest.parity === null) {
            manifest.parity = parityVerdict(turn, sim.trace.length);
        }
    } finally {
        // server.kill() FIRST: a throwing browser.close() used to skip it,
        // leaving an orphaned python server holding the port — and the next
        // run's EADDRINUSE probe then blamed a "leftover server serving the
        // wrong build" for what was really this teardown's leak.
        server.kill();
        if (browser) await browser.close();
    }

    manifest.finished_at = new Date().toISOString();
    writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2));

    console.log(`\n${manifest.turns_played} turns, outcome ${manifest.outcome} (stopped: ${manifest.stopped_because})`);
    if (manifest.console_errors.length) console.log(`${manifest.console_errors.length} console error(s)`);
    if (manifest.parity) {
        console.log(manifest.parity.ok
            ? `parity OK — ${manifest.parity.turns_compared} turns identical across tiers`
            : `parity FAILED — ${JSON.stringify(manifest.parity, null, 2)}`);
    }
    console.log(`run bundle: ${runDir}`);
    process.exit(manifest.parity && !manifest.parity.ok ? 1 : 0);
}

// Import-safe: the config load and the run itself happen only when this file
// IS the program, so the exported helpers above are testable without a game.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((err) => { console.error(err.message); process.exit(1); });
}
