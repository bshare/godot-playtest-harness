// The predicate vocabulary shared by assert_state and wait_for: dotted-path
// resolution over a dump_state snapshot plus the eight comparison ops.
//
// Extracted from run_scenario.mjs (the first seam of its planned split) so
// these pure functions can be unit-tested directly instead of through a
// spawned child process. Origin: tooling_audit_v1.md finding 1 — before this
// vocabulary existed, a repair set up to fail reported "5/5 steps succeeded",
// exit 0, because nothing ever read what the result actually said.
//
// Two deliberate semantics, both fixing real false-verdict holes:
//
//  - Path resolution only follows OWN properties. "constructor" or
//    "__proto__" in a path used to resolve to inherited JS machinery, so an
//    assert could pass against something that was never game state. A dump is
//    plain JSON; inherited properties are by definition not in it.
//  - `==`/`!=` numeric coercion is SYMMETRIC and only applies when both sides
//    are numbers or numeric strings. The old rule coerced only when the
//    EXPECTED side was a number, so {value:"3"} vs state 3 failed while
//    {value:3} vs state "3" passed — and Number(null) === 0 made `== 0`
//    asserts pass against null. null, booleans, and "" never coerce.

// Splits a dotted path with optional array indices ("grid.modules[0].x",
// "tasks.available.survivor_a[2]") into a flat list of string/number keys.
export function parsePath(pathExpr) {
	const tokens = [];
	for (const segment of String(pathExpr).split(".")) {
		const m = segment.match(/^([^\[\]]*)((?:\[\d+\])*)$/);
		if (!m) throw new Error(`assert_state: malformed path segment "${segment}" in "${pathExpr}"`);
		const [, name, indexPart] = m;
		if (name) tokens.push(name);
		for (const idx of indexPart.matchAll(/\[(\d+)\]/g)) tokens.push(Number(idx[1]));
	}
	return tokens;
}

// Walks `root` along `tokens`. Returns { found, value } rather than throwing
// on a missing key — a missing path is exactly what "exists" needs to test,
// and every other op reports a clear "path did not resolve" rather than a
// raw "Cannot read properties of undefined" stack.
export function resolvePath(root, tokens) {
	let cur = root;
	for (const token of tokens) {
		// Own properties of objects/arrays only: a snapshot is parsed JSON, so
		// anything reachable only through the prototype chain ("constructor",
		// "toString", array methods) is not game state and must read as absent.
		if (cur === null || typeof cur !== "object" || !Object.hasOwn(cur, token)) {
			return { found: false, value: undefined };
		}
		cur = cur[token];
	}
	return { found: cur !== undefined, value: cur };
}

// True when `expect` names the same refusal as `actual`, matching either the
// whole string or just the reason CODE — everything before the first colon.
// See the call site for why the code alone has to be enough.
export function reasonMatches(actual, expect) {
	if (typeof actual !== "string") return false;
	if (actual === expect) return true;
	return actual.split(":")[0].trim() === expect;
}

export const ASSERT_STATE_OPS = new Set(["==", "!=", ">", "<", ">=", "<=", "exists", "contains"]);

// A value's numeric reading, or undefined when it has none. Only numbers and
// non-empty strings that parse to a finite number qualify — null, booleans,
// and "" are excluded on purpose (Number() would read them as 0/1).
function numeric(v) {
	if (typeof v === "number") return v;
	if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
	return undefined;
}

function looseEquals(a, b) {
	if (a === b) return true;
	const na = numeric(a);
	const nb = numeric(b);
	return na !== undefined && nb !== undefined && na === nb;
}

// Evaluates one assert_state step's comparison. Returns { pass, actual,
// expected, message } — never throws for a normal pass/fail; throwing is the
// caller's job (so it can decide fatal vs. non-fatal).
export function evaluateAssertState(state, pathExpr, op, expected) {
	if (!ASSERT_STATE_OPS.has(op)) {
		throw new Error(`assert_state: unknown op "${op}" — must be one of ${[...ASSERT_STATE_OPS].join(", ")}`);
	}
	const tokens = parsePath(pathExpr);
	const { found, value } = resolvePath(state, tokens);

	if (op === "exists") {
		return { pass: found === true, actual: found, expected: true, path: pathExpr, op };
	}

	if (!found) {
		return {
			pass: false, actual: undefined, expected, path: pathExpr, op,
			message: `path "${pathExpr}" did not resolve in the dump_state snapshot (use op "exists" to test presence itself)`,
		};
	}

	let pass;
	if (op === "contains") {
		if (Array.isArray(value)) pass = value.includes(expected);
		else if (typeof value === "string") pass = value.includes(String(expected));
		else if (value !== null && typeof value === "object") pass = Object.hasOwn(value, expected);
		else pass = false;
	} else if (op === "==" || op === "!=") {
		pass = op === "==" ? looseEquals(value, expected) : !looseEquals(value, expected);
	} else {
		// Ordering demands numbers on BOTH sides. A comparison against null or
		// "high" failing silently is the vacuous-pass class again; say why.
		const nv = numeric(value);
		const ne = numeric(expected);
		if (nv === undefined || ne === undefined) {
			return {
				pass: false, actual: value, expected, path: pathExpr, op,
				message: `op "${op}" needs numeric values on both sides, got ` +
					`${JSON.stringify(value)} ${op} ${JSON.stringify(expected)}`,
			};
		}
		switch (op) {
			case ">": pass = nv > ne; break;
			case "<": pass = nv < ne; break;
			case ">=": pass = nv >= ne; break;
			case "<=": pass = nv <= ne; break;
		}
	}
	return { pass, actual: value, expected, path: pathExpr, op };
}
