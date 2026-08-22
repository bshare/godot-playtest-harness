#!/usr/bin/env node
// prune_run.mjs — evidence retention for a finished run bundle.
//
// THE MECHANISM: the report is the manifest. Both testing protocols already
// require every finding to cite its evidence by filename (a rule that exists
// for report quality). That citation doubles as the retention signal, for free:
// cited screenshots are kept, uncited ones are deleted, and their filenames are
// recorded so a later reader can tell "never captured" from "captured and
// pruned". Since runs are seeded, recapture is exact and cheap.
//
// An agent therefore cannot delete what it cited, cannot hoard without writing
// a finding, and a lazy report prunes itself into visible uselessness.
//
// SAFETY: refuses to run without a report, refuses any path outside a runs
// directory, and --dry-run changes nothing.

import path from "node:path";
import { existsSync, readFileSync, readdirSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolveRunsRoot } from "./runs_guard.mjs";

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const positional = args.find((a) => !a.startsWith("--"));

function die(msg, code = 2) {
	console.error(`ERROR: ${msg}`);
	process.exit(code);
}

// The target must be NAMED. path.resolve("") is the cwd, so before this check
// an argument-less invocation from inside a bundle directory would quietly
// prune whatever directory the caller happened to be standing in — a deletion
// nobody typed the name of.
if (!positional) die(`usage: prune_run.mjs <run-dir> [--dry-run] — the run directory must be named explicitly`);
const runDir = path.resolve(positional);

if (!existsSync(runDir)) die(`run directory not found: ${runDir}`);

// Guard: only ever operate inside the bundle's OWN runs/ tree — the project's
// configured runs_dir when one is discoverable, otherwise a runs/ directory
// at a fixed position (the bundle's parent), with symlinks resolved before
// the containment check. See runs_guard.mjs for what this closes.
try {
	resolveRunsRoot(runDir, "bundle");
} catch (e) {
	die(e.message);
}

// Guard: no report, no prune. This ordering is the whole safety property — an
// agent cannot delete evidence before it has decided what it needs.
const reportPath = ["report.md", "REPORT.md", "findings.md"]
	.map((f) => path.join(runDir, f))
	.find((p) => existsSync(p));
if (!reportPath) {
	die(`no report found in ${runDir} (looked for report.md, REPORT.md, findings.md).\n` +
	    `The bundle is still live: write the report first, then prune.`);
}

const report = readFileSync(reportPath, "utf8");
const shotsDir = path.join(runDir, "screenshots");
const evidenceDir = path.join(runDir, "evidence");

// A play_run bundle (play_run.mjs) carries a machine-readable manifest.json
// whose turn records point at screenshots/ by relative path. Pruning the files
// without touching those pointers leaves every kept reader — human or script —
// chasing paths that no longer exist, so a recognised play_run manifest gets
// rewritten alongside the deletion: kept shots point at their evidence/ home,
// deleted ones keep their NAME under `screenshot_pruned` (same rule as the
// tombstone — "never captured" must stay distinguishable from "pruned").
const runManifestPath = path.join(runDir, "manifest.json");
let runManifest = null;      // play_run shape: screenshot pointers on turns[]
let scenarioManifest = null; // scenario shape: pointers on steps[].screenshot / .screenshot_after
if (existsSync(runManifestPath)) {
	try {
		const parsed = JSON.parse(readFileSync(runManifestPath, "utf8"));
		if (parsed?.kind === "play_run") runManifest = parsed;
		// A scenario bundle's manifest carries no `kind`; it is recognised by
		// its steps[] shape. Its screenshot pointers deserve the same repoint —
		// leaving them stale sends every later reader chasing dead paths, the
		// exact failure the play_run rewrite exists to prevent.
		else if (Array.isArray(parsed?.steps)) scenarioManifest = parsed;
	} catch {
		die(`manifest.json in ${runDir} is not valid JSON — refusing to prune a bundle whose own manifest is broken`);
	}
}

// Richer evidence (ROADMAP Tier 2 item 7): a run with evidence.video/trace on
// leaves video.webm / trace.zip in the run ROOT. They are retention subjects
// exactly like screenshots — cited in the report means kept (promoted into
// evidence/ under the finding's id), uncited means deleted with the name
// retained in the tombstone. Same report-first rule, enforced above.
const aux = ["video.webm", "trace.zip"].filter((f) => existsSync(path.join(runDir, f)));

// EVERYTHING in screenshots/ must be accounted for before anything is deleted.
// The enumeration used to filter to image extensions while the deletion removed
// the whole directory — so a .gif, a stray .txt, or a nested subdirectory was
// neither counted, nor tombstoned, nor kept: silently destroyed with no audit
// trail, in the one tool whose entire contract is "deleted names are recorded".
// An entry this tool does not recognise is a refusal, not a casualty.
const entries = existsSync(shotsDir) ? readdirSync(shotsDir, { withFileTypes: true }) : [];
const all = [];
const unexpected = [];
for (const e of entries) {
	if (e.isFile() && /\.(png|jpe?g|webp)$/i.test(e.name)) all.push(e.name);
	else unexpected.push(e.isDirectory() ? `${e.name}/` : e.name);
}
if (unexpected.length > 0) {
	die(`screenshots/ contains entries this tool does not manage: ${unexpected.join(", ")}.\n` +
	    `Pruning deletes the whole directory, and these would be destroyed without being counted, ` +
	    `cited-checked, or tombstoned. Move or delete them deliberately, then re-run.`);
}
if (all.length === 0 && aux.length === 0) {
	console.log(existsSync(shotsDir)
		? "nothing to prune — screenshots/ is empty"
		: "nothing to prune — no screenshots/ directory");
	process.exit(0);
}

function escapeRegExp(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A file counts as cited if its name appears anywhere in the report. Deliberately
// generous: over-keeping one image is a far cheaper mistake than deleting one
// that mattered — but the match must land on a WORD BOUNDARY. Plain
// String#indexOf treated "shot.png" as cited whenever the report mentioned
// "not_shot.png" (a substring match, not a citation), which is over-keeping
// for the wrong reason — a file nobody actually cited surviving because its
// name happens to be a suffix of one that was. The character immediately
// before the match must not be a filename/identifier character.
const findingIdFor = (name) => {
	// Case-insensitive on Windows, where the filesystem is: a report citing
	// `Boot.PNG` for a file named `boot.png` refers — on this platform — to
	// the same file, and a case-sensitive matcher would delete cited evidence.
	const flags = process.platform === "win32" ? "i" : "";
	const pattern = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(name)}`, flags);
	const match = pattern.exec(report);
	if (!match) return null;
	// Nearest finding ID (F01, F123) appearing before the citation.
	const before = report.slice(0, match.index);
	const ids = [...before.matchAll(/\b(F\d{2,4})\b/g)];
	return ids.length ? ids[ids.length - 1][1] : "UNFILED";
};

const kept = [];
const deleted = [];
let keptBytes = 0;
let deletedBytes = 0;

// `dir` is where the file lives now: screenshots go by the shots directory,
// aux evidence (video/trace) sits in the run root.
for (const name of all) {
	const full = path.join(shotsDir, name);
	const size = statSync(full).size;
	const id = findingIdFor(name);
	if (id) {
		kept.push({ name, id, size, dir: shotsDir });
		keptBytes += size;
	} else {
		deleted.push({ name, size, dir: shotsDir });
		deletedBytes += size;
	}
}
for (const name of aux) {
	const full = path.join(runDir, name);
	const size = statSync(full).size;
	const id = findingIdFor(name);
	if (id) {
		kept.push({ name, id, size, dir: runDir });
		keptBytes += size;
	} else {
		deleted.push({ name, size, dir: runDir });
		deletedBytes += size;
	}
}

const fmt = (b) => `${(b / 1024 / 1024).toFixed(2)} MB`;
console.log(`${DRY ? "[dry-run] " : ""}${runDir}`);
console.log(`  captured ${all.length + aux.length} (${fmt(keptBytes + deletedBytes)})`);
console.log(`  keep     ${kept.length} cited (${fmt(keptBytes)})`);
console.log(`  delete   ${deleted.length} uncited (frees ${fmt(deletedBytes)})`);
for (const k of kept) console.log(`    keep  ${k.id}  ${k.name}`);

if (DRY) {
	console.log("\n[dry-run] nothing changed. Re-run without --dry-run to apply.");
	process.exit(0);
}

if (kept.length === 0) {
	console.log("\nWARNING: the report cites no screenshots, so nothing is being kept.");
	console.log("If that's wrong, cite the images in the report and re-run — citation is what saves them.");
}

// THE TOMBSTONE IS WRITTEN BEFORE ANYTHING MOVES. A crash between deletion and
// record-keeping used to leave renamed files with no record — and a re-run then
// said "nothing to prune" and exited 0, hiding the partial state. Every name
// below is already decided, so the audit trail can exist before the risk does.
const tombstone = `# Evidence Manifest — ${path.basename(runDir)}
Pruned: ${new Date().toISOString()}

Captured: ${all.length} screenshots${aux.length ? ` + ${aux.length} evidence file(s) (${aux.join(", ")})` : ""}, ${fmt(keptBytes + deletedBytes)}
Kept:     ${kept.length} (cited as evidence), ${fmt(keptBytes)}
Deleted:  ${deleted.length}, freeing ${fmt(deletedBytes)}

## Kept
${kept.length ? kept.map((k) => `| evidence/${k.id}_${k.name} | ${k.id} |`).join("\n") : "_(none cited)_"}

## Deleted — names retained so a later reader knows these existed
${deleted.map((d) => d.name).join(", ") || "_(none)_"}

To recapture: re-run the scenario that produced this bundle. Runs are seeded, so
recapture is exact.
`;
writeFileSync(path.join(runDir, "MANIFEST.md"), tombstone);

mkdirSync(evidenceDir, { recursive: true });
// Destinations checked BEFORE any rename: renameSync replaces an existing
// target silently on every platform, so residue in evidence/ from a crashed
// earlier attempt (or a hand-placed file) would be overwritten without a word.
for (const k of kept) {
	const stem = k.name.replace(/\.[^.]+$/, "");
	const ext = path.extname(k.name);
	const dst = path.join(evidenceDir, `${k.id}_${stem}${ext}`);
	if (existsSync(dst)) {
		die(`evidence destination already exists: ${dst} — refusing to overwrite it. ` +
		    `If it is residue from an interrupted prune, inspect and remove it deliberately, then re-run.`);
	}
}
for (const k of kept) {
	const stem = k.name.replace(/\.[^.]+$/, "");
	const ext = path.extname(k.name);
	renameSync(path.join(k.dir, k.name), path.join(evidenceDir, `${k.id}_${stem}${ext}`));
}
// Delete file-by-file — only names this run enumerated and recorded above.
// A recursive directory delete would also take anything that appeared since
// the enumeration; per-file deletion means nothing is ever destroyed that the
// tombstone cannot name.
for (const d of deleted) {
	rmSync(path.join(d.dir, d.name), { force: true });
}
// The screenshots directory itself goes only once it is verifiably empty; if
// something landed in it mid-prune, it survives (and the leftover directory is
// the visible signal that it did).
if (existsSync(shotsDir)) {
	if (readdirSync(shotsDir).length === 0) rmSync(shotsDir, { recursive: true, force: true });
	else console.error(`WARNING: screenshots/ gained entries mid-prune — directory left in place.`);
}

// Separator-agnostic basename: manifests are written with forward slashes
// now, but bundles produced before that fix (or by an old harness) carry
// win32 backslashes, and POSIX path.basename treats a backslash as part of
// the filename — which would misfile every such pointer as pruned.
const manifestBasename = (p) => p.split(/[\\/]/).pop();

if (runManifest) {
	const keptByName = new Map(kept.map((k) => [k.name, `evidence/${k.id}_${k.name}`]));
	const repoint = (record) => {
		if (typeof record?.screenshot !== "string") return;
		const name = manifestBasename(record.screenshot);
		if (keptByName.has(name)) {
			record.screenshot = keptByName.get(name);
		} else {
			record.screenshot_pruned = name;
			delete record.screenshot;
		}
	};
	for (const t of runManifest.turns ?? []) repoint(t);
	runManifest.pruned_at = new Date().toISOString();
	writeFileSync(runManifestPath, JSON.stringify(runManifest, null, 2));
	console.log(`rewrote manifest.json — turn records now point at evidence/ or say screenshot_pruned`);
}

// Scenario bundles carry the same class of pointer on steps[] — `screenshot`
// and `screenshot_after` — and get the same rewrite for the same reason.
if (scenarioManifest) {
	const keptByName = new Map(kept.map((k) => [k.name, `evidence/${k.id}_${k.name}`]));
	const repointKey = (record, key) => {
		if (typeof record?.[key] !== "string") return;
		const name = manifestBasename(record[key]);
		if (keptByName.has(name)) {
			record[key] = keptByName.get(name);
		} else {
			record[`${key}_pruned`] = name;
			delete record[key];
		}
	};
	for (const s of scenarioManifest.steps) {
		repointKey(s, "screenshot");
		repointKey(s, "screenshot_after");
	}
	scenarioManifest.pruned_at = new Date().toISOString();
	writeFileSync(runManifestPath, JSON.stringify(scenarioManifest, null, 2));
	console.log(`rewrote manifest.json — step records now point at evidence/ or say screenshot_pruned`);
}

console.log(`\nwrote ${path.join(runDir, "MANIFEST.md")}`);
console.log(`freed ${fmt(deletedBytes)}`);
