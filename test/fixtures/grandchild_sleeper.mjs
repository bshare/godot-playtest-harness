// Fixture for the mcp_server.mjs timeout-kill test (finding D). Stands in for
// a tool script that itself spawns a `godot --headless` grandchild: this
// process is the "tool" runTool() spawns, and it in turn spawns a plain node
// process that just sleeps forever, standing in for the engine.
//
//   node grandchild_sleeper.mjs <pidFilePath>
//
// Writes the grandchild's pid to <pidFilePath> as soon as it is spawned, then
// idles forever itself (so the timeout in runTool is what ends this process,
// exactly like a real tool that outlives its budget). Never exits on its own.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const pidFile = process.argv[2];
if (!pidFile) {
    console.error("usage: grandchild_sleeper.mjs <pidFilePath>");
    process.exit(2);
}

const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(pidFile, String(grandchild.pid));

// Keep this process alive indefinitely — it only ever ends by being killed.
setInterval(() => {}, 1000);
