// Mechanically derive a declarative action catalog from the two hand-maintained
// tables in the old run_scenario.mjs. Transcribing 40 actions by hand would
// introduce exactly the kind of silent arg-name error the validator exists to
// catch, so instead we introspect the real buildArgs functions:
//
//   pass A — proxy returns a unique marker per key  -> position => arg name
//   pass B — proxy returns undefined                -> `?? default` surfaces
//
// Combining the two passes gives name + default per positional slot.

import fs from "node:fs";

const SRC = process.argv[2];
const OUT = process.argv[3];
const src = fs.readFileSync(SRC, "utf8");

function sliceBlock(startMarker) {
	const i = src.indexOf(startMarker);
	if (i === -1) throw new Error(`marker not found: ${startMarker}`);
	const open = src.indexOf("{", i);
	let depth = 0;
	for (let j = open; j < src.length; j++) {
		if (src[j] === "{") depth++;
		else if (src[j] === "}") {
			depth--;
			if (depth === 0) return src.slice(open, j + 1);
		}
	}
	throw new Error(`unbalanced block for ${startMarker}`);
}

// eval() on sliced source, visible to a security scan of a public repo — but
// SRC here is always this repo's own run_scenario.mjs (never user input, a
// network response, or anything else untrusted), this tool is a dev-time
// generator invoked by hand, and it is not imported by anything that ships.
// The blast radius of "attacker controls run_scenario.mjs" is already total
// before this line runs. A safer JSON-parse-based extractor isn't viable
// here either: these blocks are live JS object literals (function values in
// ACTION_ARG_SPECS/NON_BRIDGE_ARG_SPECS), not data.
const defs = eval(`(${sliceBlock("const ACTION_DEFS =")})`);
const argSpecs = eval(`(${sliceBlock("const ACTION_ARG_SPECS =")})`);
const nonBridge = eval(`(${sliceBlock("const NON_BRIDGE_ARG_SPECS =")})`);

const MARK = (k) => ({ __arg: k });

function positionalFor(name, buildArgs) {
	const readA = [];
	const proxyA = new Proxy({}, {
		get(_t, k) { readA.push(String(k)); return MARK(String(k)); },
		has() { return true; },
	});
	const proxyB = new Proxy({}, { get() { return undefined; }, has() { return true; } });

	let a, b;
	try { a = buildArgs(proxyA); } catch (e) { throw new Error(`${name}: buildArgs threw (pass A): ${e.message}`); }
	try { b = buildArgs(proxyB); } catch (e) { throw new Error(`${name}: buildArgs threw (pass B): ${e.message}`); }

	if (!Array.isArray(a)) throw new Error(`${name}: buildArgs did not return an array`);
	if (a.length !== b.length) throw new Error(`${name}: pass A/B length mismatch`);

	return a.map((slot, i) => {
		if (slot && typeof slot === "object" && "__arg" in slot) {
			const dflt = b[i];
			return dflt === undefined ? { name: slot.__arg } : { name: slot.__arg, default: dflt };
		}
		// The arg went through a transform before being passed. The only one in
		// use is JSON.stringify (the bridge takes a JSON *string*, not an object,
		// for dictionary-valued args), which leaves our marker serialised inside
		// the resulting string. Detect that rather than reporting a false
		// "declared but never read" — the catalog carries it as an encode step.
		if (typeof slot === "string") {
			const m = slot.match(/\{"__arg":"([^"]+)"\}/);
			if (m) {
				let dflt;
				try { dflt = JSON.parse(b[i]); } catch { dflt = undefined; }
				const out = { name: m[1], encode: "json" };
				if (dflt !== undefined) out.default = dflt;
				return out;
			}
		}
		// A literal that never touched the args object at all.
		return { literal: slot === undefined ? null : slot };
	});
}

const actions = {};
const problems = [];

for (const [name, def] of Object.entries(defs)) {
	const spec = argSpecs[name];
	if (!spec) { problems.push(`${name}: in ACTION_DEFS but NOT in ACTION_ARG_SPECS (unvalidated action)`); }
	let positional;
	try { positional = positionalFor(name, def.buildArgs); }
	catch (e) { problems.push(e.message); continue; }

	actions[name] = {
		fn: def.fn,
		positional,
		required: spec ? spec.required : [],
		optional: spec ? spec.optional : [],
	};

	// Cross-check the two tables against each other — this is the drift the
	// single-catalog design exists to make impossible from now on.
	if (spec) {
		const used = new Set(positional.filter((p) => p.name).map((p) => p.name));
		const declared = new Set([...spec.required, ...spec.optional]);
		for (const u of used) if (!declared.has(u)) problems.push(`${name}: buildArgs reads "${u}" but ACTION_ARG_SPECS does not declare it`);
		for (const d of declared) if (!used.has(d)) problems.push(`${name}: ACTION_ARG_SPECS declares "${d}" but buildArgs never reads it`);
	}
}

for (const name of Object.keys(argSpecs)) {
	if (!defs[name]) problems.push(`${name}: in ACTION_ARG_SPECS but NOT in ACTION_DEFS (validatable but uncallable)`);
}

const catalog = {
	catalog_version: 1,
	game: "generic",
	state_schema_version: null,
	actions,
	runner_actions: nonBridge,
};

fs.writeFileSync(OUT, JSON.stringify(catalog, null, "\t") + "\n");

console.log(`actions:        ${Object.keys(actions).length}`);
console.log(`runner actions: ${Object.keys(nonBridge).length}`);
console.log(`problems:       ${problems.length}`);
for (const p of problems) console.log(`  ! ${p}`);
// Drift IS the failure this tool exists to detect — exiting 0 with problems
// printed made it useless in any automated invocation.
if (problems.length > 0) process.exitCode = 1;
