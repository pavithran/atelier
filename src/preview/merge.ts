// Would this task merge cleanly into main as it is now? A three-way
// comparison, read only: the fork point (base), main's current head (ours)
// and the task's head (theirs). A path changed on one side only merges; a
// path changed the same way on both sides merges; a path changed differently
// on both sides merges only when the changes touch separate lines of the
// base, as git's own merge would decide, and is otherwise a conflict. Nothing
// here writes; `atelier merge` still makes the merge.

import { changedPaths, diffLines, repoReader, splitLines, type Reader } from "../diff.ts";

export interface Conflict { path: string; reason: string }
export interface Mergeability {
  clean: boolean;
  conflicts: Conflict[];
  both: string[];               // paths both sides changed, conflicting or not
  ours: number;                 // paths changed on main since the fork point
  theirs: number;               // paths the task changed
}

const BLOB_LIMIT = 512 * 1024;
const isBinary = (b: Uint8Array) => b.subarray(0, 8000).includes(0);

// The hash at a path, reading each tree once per call site.
function locator(r: Reader) {
  const trees = new Map<string, ReturnType<Reader["tree"]>>();
  const tree = (h: string) => {
    if (!trees.has(h)) trees.set(h, r.tree(h));
    return trees.get(h)!;
  };
  return async (root: string, path: string): Promise<string | null> => {
    let hash = root;
    const parts = path.split("/");
    for (let i = 0; i < parts.length; i++) {
      const e = (await tree(hash))?.find((x) => x.name === parts[i]);
      if (!e) return null;
      if (i === parts.length - 1) return e.type === "blob" ? e.hash : null;
      if (e.type !== "tree") return null;
      hash = e.hash;
    }
    return null;
  };
}

// The base lines each side's changes occupy: [start, end) in base line
// numbers, where an insertion between lines is the empty range at its place.
// Null when the files are too different to diff within the line-diff budget.
export function changedRegions(base: string[], side: string[]): [number, number][] | null {
  const ops = diffLines(base, side);
  if (!ops) return null;
  const out: [number, number][] = [];
  let i = 0, start = -1;
  for (const op of ops) {
    if (op.op === " ") {
      if (start >= 0) { out.push([start, i]); start = -1; }
      i++;
    } else {
      if (start < 0) start = i;
      if (op.op === "-") i++;
    }
  }
  if (start >= 0) out.push([start, i]);
  return out;
}

// Two sides' changes to one file conflict when any of their regions overlap
// or touch, which is where git's merge stops and asks a person. Null when
// either side is too different from the base to compare here.
export function linesConflict(base: string[], ours: string[], theirs: string[]): boolean | null {
  const a = changedRegions(base, ours), b = changedRegions(base, theirs);
  if (!a || !b) return null;
  return a.some(([s1, e1]) => b.some(([s2, e2]) => s1 <= e2 && s2 <= e1));
}

export async function mergeability(
  main: Reader, task: Reader, baseTree: string, oursTree: string, theirsTree: string,
): Promise<Mergeability> {
  const [oursPaths, theirsPaths] = await Promise.all([
    baseTree === oursTree ? Promise.resolve([]) : changedPaths(main, baseTree, oursTree),
    changedPaths(task, baseTree, theirsTree),
  ]);
  const ourSet = new Set(oursPaths);
  const both = theirsPaths.filter((p) => ourSet.has(p)).sort();
  const atMain = locator(main), atTask = locator(task);
  const conflicts: Conflict[] = [];
  for (const path of both) {
    const [b, o, t] = await Promise.all([atMain(baseTree, path), atMain(oursTree, path), atTask(theirsTree, path)]);
    if (o === t) continue;                                    // the same change on both sides
    if (!o || !t) { conflicts.push({ path, reason: o ? "deleted by the task, changed on main" : t ? "deleted on main, changed by the task" : "removed or replaced on both sides" }); continue; }
    const [bb, ob, tb] = await Promise.all([b ? main.blob(b) : Promise.resolve(new Uint8Array()), main.blob(o), task.blob(t)]);
    if (!bb || !ob || !tb) { conflicts.push({ path, reason: "could not be read" }); continue; }
    if ([bb, ob, tb].some((x) => x.length > BLOB_LIMIT)) { conflicts.push({ path, reason: "too large to compare here" }); continue; }
    if ([bb, ob, tb].some(isBinary)) { conflicts.push({ path, reason: "a binary file changed on both sides" }); continue; }
    const d = new TextDecoder();
    const clash = linesConflict(splitLines(d.decode(bb)), splitLines(d.decode(ob)), splitLines(d.decode(tb)));
    if (clash === null) conflicts.push({ path, reason: "too large to compare here" });
    else if (clash) conflicts.push({ path, reason: b ? "both sides changed the same lines" : "added on both sides with different contents" });
  }
  return { clean: conflicts.length === 0, conflicts, both, ours: oursPaths.length, theirs: theirsPaths.length };
}

// Live tasks whose changes touch the same paths, as pairs with the shared
// paths, so two agents working on one file are seen before either merges.
export function overlaps(tasks: { id: string; paths: string[] }[]): { a: string; b: string; paths: string[] }[] {
  const out: { a: string; b: string; paths: string[] }[] = [];
  for (let i = 0; i < tasks.length; i++) {
    const mine = new Set(tasks[i].paths);
    for (let j = i + 1; j < tasks.length; j++) {
      const shared = tasks[j].paths.filter((p) => mine.has(p)).sort();
      if (shared.length) out.push({ a: tasks[i].id, b: tasks[j].id, paths: shared });
    }
  }
  return out;
}

// Where a task stands against main as it is now: how many commits main has
// gained since the task's fork point, and whether the task would merge.
export interface MainPreview {
  head: string;                 // main's head now
  ahead: number;                // commits on main since the fork point
  aheadCapped: boolean;         // the fork point is older than the log read; `ahead` is a floor
  merge: Mergeability;
}

const MAIN_LOG = 1000;

export async function previewAgainstMain(artifacts: Artifacts, baselineRepo: string, workspaceRepo: string, base: string, baseTree: string, headTree: string): Promise<MainPreview | null> {
  using baseline = await artifacts.get(baselineRepo);
  using fork = await artifacts.get(workspaceRepo);
  const log = await baseline.log({ limit: MAIN_LOG });
  const head = log[0];
  if (!head) return null;
  const at = log.findIndex((c) => c.hash === base);
  const ahead = at < 0 ? log.length : at;
  const merge = head.hash === base
    ? { clean: true, conflicts: [], both: [], ours: 0, theirs: 0 }
    : await mergeability(repoReader(baseline), repoReader(fork), baseTree, head.treeHash, headTree);
  return { head: head.hash, ahead, aheadCapped: at < 0, merge };
}
