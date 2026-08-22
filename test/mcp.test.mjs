// Tests for src/mcp_server.mjs — the MCP stdio wrapper around the harness CLIs.
//
// No browser, no Godot: the server is spawned as a real child process and
// driven over its actual stdio transport (newline-delimited JSON-RPC), because
// the transport IS the deliverable — a unit test that calls handleMessage()
// directly would pass with a broken line reader. The only tool exercised
// end-to-end is validate_scenarios, the one harness verb that needs neither a
// build nor playwright, against the fixture game in test/fixtures/mcp-game/.
//
// What is guarded and why:
//   * the handshake (initialize -> initialized -> tools/list): the first thing
//     every MCP client does, and the only discovery mechanism an unprimed
//     agent has — if the tool table or schemas regress, every client is blind;
//   * tools/call round-trip with isError faithfully mirroring exit codes: a
//     wrapper that reports a failed validation as success would recreate the
//     exact class of silent-pass bug the validator exists to prevent;
//   * protocol resilience: an unknown method must be -32601 and a malformed
//     line must be -32700, and NEITHER may kill the process — a server that
//     dies mid-session hangs its client forever.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(ROOT, "src", "mcp_server.mjs");
const FIXTURE_GAME = path.join(ROOT, "test", "fixtures", "mcp-game");

const EXPECTED_TOOLS = [
	"validate_scenarios", "run_scenario", "play_run", "batch",
	"coverage", "prune_run", "sweep_runs",
];

// ---- a minimal line-delimited JSON-RPC client -------------------------------

class McpClient {
	constructor() {
		this.child = spawn(process.execPath, [SERVER], {
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		this.nextId = 1;
		this.pending = new Map(); // id -> resolve
		this.unmatched = []; // responses with null/unknown id (e.g. parse errors)
		this.unmatchedWaiters = [];
		this.exited = false;
		this.child.on("exit", () => { this.exited = true; });
		let buf = "";
		this.child.stdout.setEncoding("utf8");
		this.child.stdout.on("data", (chunk) => {
			buf += chunk;
			let nl;
			while ((nl = buf.indexOf("\n")) !== -1) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (line === "") continue;
				const msg = JSON.parse(line);
				const waiter = this.pending.get(msg.id);
				if (waiter) {
					this.pending.delete(msg.id);
					waiter(msg);
				} else if (this.unmatchedWaiters.length > 0) {
					this.unmatchedWaiters.shift()(msg);
				} else {
					this.unmatched.push(msg);
				}
			}
		});
	}

	writeLine(line) { this.child.stdin.write(line + "\n"); }

	notify(method, params) {
		this.writeLine(JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }));
	}

	request(method, params, { timeoutMs = 30000 } = {}) {
		const id = this.nextId++;
		const msg = { jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) };
		return new Promise((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`no response to ${method} (id ${id}) within ${timeoutMs}ms`)),
				timeoutMs,
			);
			this.pending.set(id, (response) => { clearTimeout(timer); resolve(response); });
			this.writeLine(JSON.stringify(msg));
		});
	}

	/** Next response that matched no pending request id (parse errors carry id null). */
	nextUnmatched({ timeoutMs = 10000 } = {}) {
		if (this.unmatched.length > 0) return Promise.resolve(this.unmatched.shift());
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("no unmatched response arrived")), timeoutMs);
			this.unmatchedWaiters.push((msg) => { clearTimeout(timer); resolve(msg); });
		});
	}

	kill() { try { this.child.kill(); } catch { /* already gone */ } }
}

let client;
before(() => { client = new McpClient(); });
after(() => { client.kill(); });

// One session, in protocol order: the handshake test must run first, exactly
// as a real client would issue it, and later tests reuse the same live server
// — which is itself an assertion that nothing before them killed it.

test("handshake: initialize returns version, capabilities, serverInfo", async () => {
	const res = await client.request("initialize", {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "mcp-test", version: "0.0.0" },
	});
	assert.equal(res.error, undefined);
	assert.equal(res.result.protocolVersion, "2025-06-18");
	assert.deepEqual(res.result.capabilities, { tools: {} });
	assert.equal(res.result.serverInfo.name, "godot-playtest-harness");

	// The initialized notification must be accepted silently — no response.
	client.notify("notifications/initialized");
});

test("tools/list: the full tool table, each entry actionable cold", async () => {
	const res = await client.request("tools/list");
	assert.equal(res.error, undefined);
	const tools = res.result.tools;
	assert.deepEqual(tools.map((t) => t.name).sort(), [...EXPECTED_TOOLS].sort());
	for (const tool of tools) {
		// An agent with none of this repo's docs sees only these fields; a
		// one-liner description or a schema-less tool is unusable cold.
		assert.ok(tool.description.length > 100, `${tool.name}: description too thin to act on`);
		assert.equal(tool.inputSchema.type, "object");
		assert.ok(tool.inputSchema.required.includes("project_dir"),
			`${tool.name}: every tool must require project_dir`);
		assert.ok(tool.inputSchema.properties.project_dir,
			`${tool.name}: project_dir must be described`);
	}
});

test("ping round-trips", async () => {
	const res = await client.request("ping");
	assert.equal(res.error, undefined);
	assert.deepEqual(res.result, {});
});

test("tools/call: validate_scenarios passes a good scenario", async () => {
	const res = await client.request("tools/call", {
		name: "validate_scenarios",
		arguments: { project_dir: FIXTURE_GAME, patterns: ["scenarios/good.json"] },
	});
	assert.equal(res.error, undefined);
	assert.notEqual(res.result.isError, true,
		`good scenario reported as error: ${res.result.content[0].text}`);
	const text = res.result.content[0].text;
	assert.match(text, /exit code: 0/);
	assert.match(text, /good\.json/);
});

test("tools/call: validate_scenarios flags a bad scenario as isError", async () => {
	const res = await client.request("tools/call", {
		name: "validate_scenarios",
		arguments: { project_dir: FIXTURE_GAME, patterns: ["scenarios/bad.json"] },
	});
	assert.equal(res.error, undefined);
	assert.equal(res.result.isError, true);
	const text = res.result.content[0].text;
	// The script's own diagnostics must survive the round trip — the agent
	// fixes the scenario from this text or not at all.
	assert.match(text, /no_such_action/);
	assert.match(text, /thing_id/);
});

test("tools/call: a missing project_dir is a tool error, not a hang", async () => {
	const res = await client.request("tools/call", {
		name: "validate_scenarios",
		arguments: { patterns: ["scenarios/good.json"] },
	});
	assert.equal(res.error, undefined);
	assert.equal(res.result.isError, true);
	assert.match(res.result.content[0].text, /project_dir/);
});

test("tools/call: an unknown tool name is -32602", async () => {
	const res = await client.request("tools/call", { name: "no_such_tool", arguments: {} });
	assert.equal(res.error.code, -32602);
});

test("unknown method: -32601, and the server survives", async () => {
	const res = await client.request("resources/list");
	assert.equal(res.error.code, -32601);
	assert.match(res.error.message, /resources\/list/);
	const pong = await client.request("ping");
	assert.deepEqual(pong.result, {});
});

test("malformed JSON line: -32700 with id null, without process death", async () => {
	client.writeLine("{this is not json");
	const res = await client.nextUnmatched();
	assert.equal(res.error.code, -32700);
	assert.equal(res.id, null);
	// The whole point: the server must still be alive and answering.
	const pong = await client.request("ping");
	assert.deepEqual(pong.result, {});
	assert.equal(client.exited, false);
});
