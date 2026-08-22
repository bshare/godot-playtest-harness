// runs_guard.mjs — the deletion-safety check shared by prune_run.mjs and
// sweep_runs.mjs.
//
// THE BUG THIS REPLACES: both tools used to guard destructive filesystem
// operations with `path.split(sep).includes("runs")` — true if the string
// "runs" appears as ANY path component ANYWHERE in the resolved path, at any
// depth, unrelated to the actual project. `mkdir -p /tmp/evil/runs/x` was
// enough to satisfy it; an MCP client passing a confused run_dir/runs_dir
// could point either tool at a directory that has nothing to do with this
// harness and have it deleted.
//
// THE FIX has two tiers, tried in order:
//
//   1. CONFIGURED: walk up from the target looking for playtest.config.json.
//      If found, its `runs_dir` (default "runs", resolved against the
//      config's own directory) IS the governing root — no matter what any
//      path component happens to be named. A target outside that root is
//      refused even if some ancestor of it is literally called "runs": that
//      is exactly the "unrelated runs folder that happens to share a name"
//      case.
//
//   2. LITERAL-NAME FALLBACK, when no config is found anywhere above the
//      target: the runs root must be at a FIXED position relative to the
//      target — the target's own parent for a bundle (prune_run), the
//      target itself for a runs tree (sweep_runs) — and that fixed position
//      must be literally named "runs". This closes the "anywhere in the
//      path" hole even without a config to consult: a "runs" component ten
//      levels above the target no longer counts.
//
// Both tiers finish with fs.realpathSync on root and target (symlink
// defense — a symlinked runs/ pointing elsewhere must not launder a path
// that would otherwise be refused) and a path.relative containment check.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

function findProjectConfig(start) {
    let dir = start;
    for (;;) {
        const configPath = path.join(dir, "playtest.config.json");
        if (existsSync(configPath)) {
            try {
                return { dir, config: JSON.parse(readFileSync(configPath, "utf8")) };
            } catch (e) {
                return { dir, config: null, error: e };
            }
        }
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

/**
 * Resolve and verify the runs root that governs `target`, throwing a clear,
 * user-facing message on any escape.
 *
 * `kind`:
 *   "bundle" — target is one run bundle (prune_run.mjs). The runs root is
 *              target's own PARENT in the literal-name fallback, and target
 *              must be a STRICT descendant of the root either way (a bundle
 *              cannot legitimately equal its own runs root).
 *   "root"   — target IS the runs directory itself (sweep_runs.mjs). The
 *              runs root is the target itself in the literal-name fallback,
 *              and target may legitimately equal the root.
 *
 * Returns { root, target } — both realpath'd absolute paths — on success.
 */
export function resolveRunsRoot(target, kind) {
    if (kind !== "bundle" && kind !== "root") throw new Error(`resolveRunsRoot: invalid kind "${kind}"`);
    if (!existsSync(target)) throw new Error(`path not found: ${target}`);

    const resolvedTarget = realpathSync(path.resolve(target));
    const found = findProjectConfig(path.dirname(resolvedTarget));

    let root;
    let source;
    if (found) {
        if (!found.config) {
            throw new Error(
                `${path.join(found.dir, "playtest.config.json")} is not valid JSON — refusing to trust an ` +
                `unreadable config to decide what may be deleted`,
            );
        }
        root = path.resolve(found.dir, found.config.runs_dir ?? "runs");
        source = `configured runs_dir in ${path.join(found.dir, "playtest.config.json")}`;
        // The configured root must stay INSIDE the project that configured it.
        // Taken verbatim, a typo'd "runs_dir": "../../" made the governing tree
        // the grandparent of the project — and the sweep tool then age-deletes
        // anything unpruned under that entire tree. A guard that lets its own
        // config point it at the filesystem at large is not a guard.
        const rel = path.relative(found.dir, root);
        if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
            throw new Error(
                `refusing runs_dir ${JSON.stringify(found.config.runs_dir)} (${source}): it resolves to ` +
                `${root}, outside (or equal to) the project directory that configured it. The runs root ` +
                `must be a subdirectory of the project.`,
            );
        }
    } else {
        root = kind === "bundle" ? path.dirname(resolvedTarget) : resolvedTarget;
        source = 'literal-name fallback (no playtest.config.json found above the target)';
        if (path.basename(root) !== "runs") {
            throw new Error(
                `refusing to touch a path with no governing runs root: no playtest.config.json was found above ` +
                `${target}, and its ${kind === "bundle" ? "parent directory" : "own directory"} is not literally named "runs".`,
            );
        }
    }

    if (!existsSync(root)) {
        throw new Error(`refusing to touch ${target}: its resolved runs root ${root} (${source}) does not exist`);
    }
    const realRoot = realpathSync(root);

    const rel = path.relative(realRoot, resolvedTarget);
    const contained = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    if (!contained) {
        throw new Error(
            `refusing to touch a path outside its runs root: ${target} resolves outside ${realRoot} (${source})`,
        );
    }
    if (kind === "bundle" && rel === "") {
        throw new Error(`refusing to touch ${target}: it IS the runs root, not a bundle inside it`);
    }

    return { root: realRoot, target: resolvedTarget };
}
