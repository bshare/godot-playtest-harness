#!/usr/bin/env node
/**
 * mcp_server.mjs — the harness verbs as an MCP server, over stdio.
 *
 *   node src/mcp_server.mjs        # speaks MCP on stdin/stdout; log lines go to stderr
 *
 * WHY: every verb in this repo is a CLI script, and every doc that teaches them
 * assumes an agent primed with this repo's skills. An MCP-capable client needs
 * neither — it calls tools/list, reads the descriptions, and drives the same
 * scripts through tools/call. The positioning is deliberate and mirrors
 * CHOOSING_YOUR_TOOLING.md: godot-mcp is the editor inner loop, this is the
 * artifact outer loop, same protocol.
 *
 * PROTOCOL, BY HAND. The repo's only dependency is playwright and it stays
 * that way, so this file implements the MCP stdio transport itself rather than
 * pulling in an SDK. That transport is small: JSON-RPC 2.0, one message per
 * line, no Content-Length framing (that is the LSP convention; MCP stdio is
 * newline-delimited — see the MCP spec's stdio transport). Implemented:
 * initialize, notifications/initialized, ping, tools/list, tools/call.
 * Anything else gets -32601, a malformed line gets -32700, and neither kills
 * the process — a wrapper that dies on the first bad byte hangs its client.
 *
 * EVERY TOOL SHELLS OUT to the existing script with cwd set to the caller's
 * `project_dir`. That is not laziness, it is the contract: the scripts already
 * resolve playtest.config.json, the catalog, and runs/ relative to cwd, and
 * they are the proven code path. This file adds no second implementation of
 * anything — a fix to run_scenario.mjs is a fix to the MCP surface for free.
 *
 * WHAT IS DELIBERATELY NOT HERE (v1): the interactive per-action session that
 * control_server.mjs provides (/reset, /act, /state against one persistent
 * browser). Those tools need lifecycle management — a session that outlives a
 * single tools/call, dies with the client, and never leaks a browser — that a
 * stateless spawn-per-call wrapper does not have. Wrapping it badly would leak
 * headless Chromium processes on every client crash. See docs/MCP.md.
 *
 * Import-safe: importing this module runs nothing (the tests import TOOLS and
 * handleMessage directly); `node src/mcp_server.mjs` starts the loop.
 */

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PROTOCOL_VERSION = "2025-06-18";
export const SERVER_INFO = { name: "godot-playtest-harness", version: "0.1.0" };

const DEFAULT_TIMEOUT_MS = 300000;

// Every tool requires project_dir: the game repo root, where
// playtest.config.json lives. The scripts resolve everything relative to cwd,
// so an MCP client — whose own cwd is wherever the host launched it — must say
// which game it means on every call. There is no default on purpose; a wrapper
// that guesses the game repeats control_server.mjs's original mistake
// (plausible defaults drove the wrong build and reported success).
const PROJECT_DIR_PROP = {
	project_dir: {
		type: "string",
		description:
			"Absolute path to the game repo root — the directory containing playtest.config.json. " +
			"Required on every call; the harness resolves the config, action catalog, build and runs/ " +
			"relative to it.",
	},
};
const TIMEOUT_PROP = {
	timeout_ms: {
		type: "number",
		description:
			`Kill the underlying script after this many milliseconds and return a timeout error ` +
			`(default ${DEFAULT_TIMEOUT_MS}). Raise it for long batches or long play_run sessions.`,
	},
};

// The tool table. `script` names the sibling CLI; `argv(args)` turns the MCP
// arguments into that CLI's argv; `env(args)` contributes environment
// variables. Descriptions are written for an agent that has read NONE of this
// repo's docs: what the tool answers, and when to prefer it over the others.
export const TOOLS = [
	{
		name: "validate_scenarios",
		script: "run_scenario.mjs",
		description:
			"Statically validate playtest scenario JSON files against the game's action catalog — no " +
			"browser, no build, runs in milliseconds. Catches unknown actions, missing required args, " +
			"and misplaced argument keys (the class of mistake that otherwise runs '14/14 succeeded' " +
			"while silently clicking (0,0)). ALWAYS run this before run_scenario on any scenario you " +
			"wrote or edited. Non-zero exit (isError) means at least one scenario is broken; the text " +
			"output names each problem.",
		inputSchema: {
			type: "object",
			properties: {
				...PROJECT_DIR_PROP,
				patterns: {
					type: "array",
					items: { type: "string" },
					description:
						"Scenario paths relative to project_dir, e.g. [\"scenarios/first_run.json\"] or " +
						"[\"scenarios/*.json\"] (simple * globs are expanded by the validator itself).",
				},
				...TIMEOUT_PROP,
			},
			required: ["project_dir", "patterns"],
		},
		argv: (a) => ["--validate", ...a.patterns],
	},
	{
		name: "run_scenario",
		script: "run_scenario.mjs",
		description:
			"Execute one scenario JSON file against the game's debug web export in a real (headless) " +
			"browser: boots the game, performs each step through the debug bridge, and writes a run " +
			"bundle under runs/<name>_<timestamp>/ containing manifest.json (every step's result and " +
			"state snapshots — the ground truth) plus screenshots/. Use for 'does this flow work, what " +
			"does the player see'. Requires a debug web export at the path named in playtest.config.json. " +
			"isError means a step failed, a console error was captured, or a UI-surface finding was " +
			"filed — read the output and the bundle's manifest.json.",
		inputSchema: {
			type: "object",
			properties: {
				...PROJECT_DIR_PROP,
				scenario_path: {
					type: "string",
					description: "Path to the scenario JSON, relative to project_dir (e.g. scenarios/first_run.json).",
				},
				headed: {
					type: "boolean",
					description: "Run with a visible browser window instead of headless (HEADED=1). Only useful when a human is watching.",
				},
				session: {
					type: "string",
					description:
						"Session name for cross-run state continuity (SESSION=<name>). Use the SAME name across " +
						"consecutive calls to carry game state from one scenario to the next; omit for a fresh boot. " +
						"Requires the game to implement save export/import.",
				},
				...TIMEOUT_PROP,
			},
			required: ["project_dir", "scenario_path"],
		},
		argv: (a) => [a.scenario_path],
		env: (a) => ({
			...(a.headed ? { HEADED: "1" } : {}),
			...(a.session ? { SESSION: String(a.session) } : {}),
		}),
	},
	{
		name: "play_run",
		script: "play_run.mjs",
		description:
			"Play a whole run turn by turn in the browser tier: a policy chooses each action from the " +
			"game's legal_moves against live state, instead of committing to a scripted scenario up " +
			"front. Also hosts --parity, the check that the headless sim tier and the browser play the " +
			"same game turn for turn. Arguments are passed through verbatim as CLI flags, e.g. " +
			"[\"--game\", \".\", \"--seed\", \"900\", \"--policy\", \"optimiser\", \"--max-turns\", \"200\"]. " +
			"Run with an empty passthrough to get the script's own usage text.",
		inputSchema: {
			type: "object",
			properties: {
				...PROJECT_DIR_PROP,
				passthrough: {
					type: "array",
					items: { type: "string" },
					description: "CLI arguments handed to play_run.mjs verbatim (flags and values as separate items).",
				},
				...TIMEOUT_PROP,
			},
			required: ["project_dir", "passthrough"],
		},
		argv: (a) => [...a.passthrough],
	},
	{
		name: "batch",
		script: "batch.mjs",
		description:
			"Run the headless sim tier over N seeds and aggregate — milliseconds per run, no browser, " +
			"no screenshots. This is where balance questions belong ('is the boss too hard' over a " +
			"thousand runs, policy-vs-policy ratios), and where --verify-determinism and " +
			"--verify-isolation live, the checks that decide whether any sim number is true. Requires " +
			"the game to have a sim adapter (see SIM_TIER.md); games without one get a clear error. " +
			"Arguments pass through verbatim, e.g. [\"--game\", \".\", \"--runs\", \"200\", \"--seed\", " +
			"\"1\", \"--policy\", \"random\"].",
		inputSchema: {
			type: "object",
			properties: {
				...PROJECT_DIR_PROP,
				passthrough: {
					type: "array",
					items: { type: "string" },
					description: "CLI arguments handed to batch.mjs verbatim (flags and values as separate items).",
				},
				...TIMEOUT_PROP,
			},
			required: ["project_dir", "passthrough"],
		},
		argv: (a) => [...a.passthrough],
	},
	{
		name: "coverage",
		script: "coverage.mjs",
		description:
			"Report what a pass of run bundles NEVER touched: catalog actions no bundle attempted, and " +
			"per-facet content no run met. Distinguishes 'no findings because sound' from 'no findings " +
			"because never looked' — run it after a playtest pass, before trusting an empty findings " +
			"list. A successful report exits 0 whatever it found (an unexercised action is a question, " +
			"not a failure); a broken invocation — no readable bundles, unusable facet spec — exits 1. Arguments pass " +
			"through verbatim, e.g. [\"--game\", \".\", \"--runs\", \"runs\"] or a list of specific " +
			"bundle directories.",
		inputSchema: {
			type: "object",
			properties: {
				...PROJECT_DIR_PROP,
				passthrough: {
					type: "array",
					items: { type: "string" },
					description: "CLI arguments handed to coverage.mjs verbatim (flags and values as separate items).",
				},
				...TIMEOUT_PROP,
			},
			required: ["project_dir", "passthrough"],
		},
		argv: (a) => [...a.passthrough],
	},
	{
		name: "prune_run",
		script: "prune_run.mjs",
		description:
			"Evidence retention for one finished run bundle: screenshots cited in the bundle's report " +
			"are promoted to evidence/ and kept, everything uncited is deleted with its filename " +
			"recorded in MANIFEST.md. Refuses to run if the bundle has no report (write the report " +
			"first — that ordering is the safety property). Refuses to touch a bundle outside its own " +
			"runs tree: the project's playtest.config.json runs_dir when one is discoverable above the " +
			"bundle, otherwise a runs/ directory that is literally the bundle's parent — both checked " +
			"after resolving symlinks, so a confused or malicious run_dir cannot reach an unrelated " +
			"directory that merely has \"runs\" somewhere in its path. Use dry_run:true first to see what " +
			"would happen.",
		inputSchema: {
			type: "object",
			properties: {
				...PROJECT_DIR_PROP,
				run_dir: {
					type: "string",
					description: "The run bundle directory, relative to project_dir (e.g. runs/critique_20260809).",
				},
				dry_run: {
					type: "boolean",
					description: "Report what would be kept/deleted without changing anything.",
				},
				...TIMEOUT_PROP,
			},
			required: ["project_dir", "run_dir"],
		},
		argv: (a) => [a.run_dir, ...(a.dry_run ? ["--dry-run"] : [])],
	},
	{
		name: "sweep_runs",
		script: "sweep_runs.mjs",
		description:
			"Age and budget sweep over a whole runs/ directory: deletes pruned bundles past their " +
			"retention window and flags unpruned bundles whose report never arrived. Run per milestone, " +
			"not per run — prune_run handles individual bundles. Refuses to sweep anything but the " +
			"project's own runs tree: the project's playtest.config.json runs_dir when one is " +
			"discoverable above the given directory, otherwise a directory that is itself literally " +
			"named runs/ — both checked after resolving symlinks, so a confused or malicious runs_dir " +
			"cannot reach an unrelated directory that merely has \"runs\" somewhere in its path. " +
			"Use dry_run:true first.",
		inputSchema: {
			type: "object",
			properties: {
				...PROJECT_DIR_PROP,
				runs_dir: {
					type: "string",
					description: "The runs directory, relative to project_dir (usually just \"runs\").",
				},
				dry_run: {
					type: "boolean",
					description: "Report what would be swept without deleting anything.",
				},
				...TIMEOUT_PROP,
			},
			required: ["project_dir", "runs_dir"],
		},
		argv: (a) => [a.runs_dir, ...(a.dry_run ? ["--dry-run"] : [])],
	},
];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// ---- JSON-RPC plumbing ------------------------------------------------------

function rpcResult(id, result) {
	return { jsonrpc: "2.0", id, result };
}
function rpcError(id, code, message, data) {
	const err = { code, message };
	if (data !== undefined) err.data = data;
	return { jsonrpc: "2.0", id: id ?? null, error: err };
}

/** MCP tool result: text content plus the protocol-level isError flag. */
function toolText(text, isError = false) {
	return { content: [{ type: "text", text }], isError };
}

/**
 * Kill `child` AND anything it spawned — a plain child.kill("SIGKILL") only
 * reaches the immediate node process. A tool that itself spawns a `godot
 * --headless` grandchild (batch.mjs, play_run.mjs's sim tier) leaves that
 * grandchild running past the timeout, especially on Windows, where
 * TerminateProcess does not cascade to children at all.
 *
 * On Windows: `taskkill /pid <pid> /T /F` — /T kills the whole process tree,
 * /F forces it. On POSIX: the child is spawned detached (its own process
 * group, see below), so `kill(-pid)` signals the whole group at once; a
 * plain child.kill() falls back if the group is already gone.
 */
function killChildTree(child) {
	if (!child.pid) return;
	if (process.platform === "win32") {
		spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
	} else {
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {
			// No process group (already exited, or spawn raced the kill) —
			// fall back to signalling the child directly.
			try { child.kill("SIGKILL"); } catch { /* already gone */ }
		}
	}
}

/**
 * Run one tool call: spawn the script with cwd = project_dir, collect
 * stdout/stderr, enforce the timeout. Resolves to an MCP tool result — tool
 * failures (bad args, non-zero exit, timeout) are isError results, never
 * JSON-RPC errors, so the calling agent sees the script's own diagnostics.
 */
export async function runTool(tool, args) {
	if (typeof args?.project_dir !== "string" || args.project_dir === "") {
		return toolText(`project_dir is required: the game repo root containing playtest.config.json.`, true);
	}
	const projectDir = path.resolve(args.project_dir);
	if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
		return toolText(`project_dir does not exist or is not a directory: ${projectDir}`, true);
	}
	// Fail the shape errors up front with a message naming the field, instead
	// of letting the script print its usage line against mysterious argv.
	for (const req of tool.inputSchema.required) {
		if (args[req] === undefined) return toolText(`missing required argument: ${req}`, true);
	}
	for (const [key, spec] of Object.entries(tool.inputSchema.properties)) {
		if (spec.type === "array" && args[key] !== undefined) {
			if (!Array.isArray(args[key]) || args[key].some((v) => typeof v !== "string")) {
				return toolText(`argument ${key} must be an array of strings`, true);
			}
		}
	}

	const timeoutMs = Number.isFinite(args.timeout_ms) && args.timeout_ms > 0
		? args.timeout_ms
		: DEFAULT_TIMEOUT_MS;
	const scriptPath = path.join(SRC_DIR, tool.script);
	const argv = tool.argv(args);
	const extraEnv = tool.env ? tool.env(args) : {};

	return await new Promise((resolvePromise) => {
		const child = spawn(process.execPath, [scriptPath, ...argv], {
			cwd: projectDir,
			env: { ...process.env, ...extraEnv },
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			// POSIX only: its own process group, so a timeout can kill(-pid)
			// the whole tree at once (see killChildTree). Windows has no
			// process-group kill of its own; taskkill /T does the equivalent
			// without needing this — and detached:true there would spawn a
			// new console window for no benefit.
			detached: process.platform !== "win32",
		});
		// Capped, head-and-tail. A runaway child (a misconfigured engine spewing
		// per-frame errors) used to grow these strings without bound and then
		// ship the whole thing as one MCP response. The head carries the setup
		// and first failure; the tail carries the final error and exit context;
		// the middle is where repetition lives. 64 KB each side, per stream.
		const CAP = 64 * 1024;
		const streams = { stdout: { head: "", tail: "", total: 0 }, stderr: { head: "", tail: "", total: 0 } };
		const append = (which, d) => {
			const s = streams[which];
			const text = String(d);
			if (s.head.length < CAP) s.head += text.slice(0, CAP - s.head.length);
			s.tail = (s.tail + text).slice(-CAP);
			s.total += text.length;
		};
		const render = (which) => {
			const s = streams[which];
			if (s.total <= CAP) return s.head; // head holds everything
			if (s.total <= CAP * 2) return s.head + s.tail.slice(-(s.total - CAP)); // no gap — just avoid the overlap
			return `${s.head}\n... [${s.total - CAP * 2} chars elided — output capped at ${CAP} head + ${CAP} tail per stream] ...\n${s.tail}`;
		};
		let timedOut = false;
		child.stdout.on("data", (d) => append("stdout", d));
		child.stderr.on("data", (d) => append("stderr", d));

		const timer = setTimeout(() => {
			timedOut = true;
			// The whole tree, not just this node process — see killChildTree.
			// The run bundle written so far survives either way.
			killChildTree(child);
		}, timeoutMs);

		const finish = (exitCode, spawnError) => {
			clearTimeout(timer);
			if (spawnError) {
				resolvePromise(toolText(`failed to spawn ${tool.script}: ${spawnError.message}`, true));
				return;
			}
			if (timedOut) {
				resolvePromise(toolText(
					`TIMEOUT: ${tool.name} exceeded ${timeoutMs}ms and was killed. ` +
					`Partial output follows. Raise timeout_ms if the work is legitimately long.\n` +
					`--- stdout ---\n${render("stdout")}\n--- stderr ---\n${render("stderr")}`,
					true,
				));
				return;
			}
			const text =
				`exit code: ${exitCode}\n--- stdout ---\n${render("stdout")}\n--- stderr ---\n${render("stderr")}`;
			resolvePromise(toolText(text, exitCode !== 0));
		};
		child.on("error", (err) => finish(null, err));
		child.on("close", (code) => finish(code ?? -1, null));
	});
}

/**
 * Handle one parsed JSON-RPC message. Returns the response object to write,
 * or null for notifications (which get no response by JSON-RPC rule).
 */
export async function handleMessage(msg) {
	if (typeof msg !== "object" || msg === null || Array.isArray(msg)) {
		return rpcError(null, -32600, "Invalid Request: expected a JSON-RPC object");
	}
	const { id, method, params } = msg;
	const isNotification = id === undefined;

	switch (method) {
		case "initialize":
			return rpcResult(id, {
				protocolVersion: PROTOCOL_VERSION,
				capabilities: { tools: {} },
				serverInfo: SERVER_INFO,
			});
		case "notifications/initialized":
		case "notifications/cancelled":
			return null; // accepted, no response
		case "ping":
			return rpcResult(id, {});
		case "tools/list":
			return rpcResult(id, {
				tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
			});
		case "tools/call": {
			const tool = TOOL_BY_NAME.get(params?.name);
			if (!tool) return rpcError(id, -32602, `Unknown tool: ${params?.name}`);
			const result = await runTool(tool, params?.arguments ?? {});
			return rpcResult(id, result);
		}
		default:
			// Unknown notification: silently ignored per JSON-RPC. Unknown
			// request: method-not-found, and the loop keeps running.
			return isNotification ? null : rpcError(id, -32601, `Method not found: ${method}`);
	}
}

// ---- stdio loop -------------------------------------------------------------

export function startStdioLoop({ stdin = process.stdin, stdout = process.stdout } = {}) {
	let buffer = "";
	const write = (obj) => { stdout.write(JSON.stringify(obj) + "\n"); };

	stdin.setEncoding("utf8");
	stdin.on("data", (chunk) => {
		buffer += chunk;
		let nl;
		while ((nl = buffer.indexOf("\n")) !== -1) {
			const line = buffer.slice(0, nl).replace(/\r$/, "");
			buffer = buffer.slice(nl + 1);
			if (line.trim() === "") continue;
			let msg;
			try {
				msg = JSON.parse(line);
			} catch (e) {
				// A malformed line must not kill the server — respond and carry
				// on. id is unknowable from an unparseable line, so it is null.
				write(rpcError(null, -32700, `Parse error: ${e.message}`));
				continue;
			}
			// Requests are handled async (tools/call can run for minutes) and
			// each writes its own response line when done.
			handleMessage(msg).then((response) => {
				if (response !== null) write(response);
			}).catch((err) => {
				write(rpcError(msg.id ?? null, -32603, `Internal error: ${err.message}`));
			});
		}
	});
	stdin.on("end", () => {
		// Client closed our stdin: the session is over. Exit cleanly so a
		// crashed client never leaves an orphaned server.
		process.exit(0);
	});
}

// Import-safe main guard: `node src/mcp_server.mjs` starts the loop; importing
// the module (as the tests do) runs nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	console.error(`${SERVER_INFO.name} MCP server listening on stdio (protocol ${PROTOCOL_VERSION})`);
	startStdioLoop();
}
