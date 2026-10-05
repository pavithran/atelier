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
// numbers, where an insertion between lines is the empty range at its place,
// with the lines the side puts there. Null when the files are too different
// to diff within the line-diff budget.
export type Region = [number, number, string[]];

export function changedRegions(base: string[], side: string[]): Region[] | null {
  const ops = diffLines(base, side);
  if (!ops) return null;
  const out: Region[] = [];
  let i = 0, start = -1, added: string[] = [];
  for (const op of ops) {
    if (op.op === " ") {
      if (start >= 0) { out.push([start, i, added]); start = -1; added = []; }
      i++;
    } else {
      if (start < 0) start = i;
      if (op.op === "-") i++;
      else added.push(op.text);
    }
  }
  if (start >= 0) out.push([start, i, added]);
  return out;
}

const sameChange = (a: Region, b: Region) => a[0] === b[0] && a[1] === b[1] && a[2].length === b[2].length && a[2].every((l, k) => l === b[2][k]);

// Two sides' changes to one file conflict when any of their regions overlap
// or touch, which is where git's merge stops and asks a person, unless both
// sides made the identical change there, which git takes once. Null when
// either side is too different from the base to compare here.
export function linesConflict(base: string[], ours: string[], theirs: string[]): boolean | null {
  const a = changedRegions(base, ours), b = changedRegions(base, theirs);
  if (!a || !b) return null;
  return a.some((x) => b.some((y) => x[0] <= y[1] && y[0] <= x[1] && !sameChange(x, y)));
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
    const clash = linesConflict(linesOf(bb), linesOf(ob), linesOf(tb));
    if (clash === null) conflicts.push({ path, reason: "too large to compare here" });
    else if (clash) conflicts.push({ path, reason: b ? "both sides changed the same lines" : "added on both sides with different contents" });
  }
  // A path that is a file on one side and a folder on the other: git cannot
  // put both at one place, though no single path is changed by both sides.
  // Only entries that survive count: a side that deleted the longer path, or
  // replaced the file, leaves nothing to collide.
  const theirSet = new Set(theirsPaths);
  const collisions = new Set<string>();
  const sides = [
    { paths: theirsPaths, other: ourSet, has: (p: string) => atTask(theirsTree, p), fileOnOther: (p: string) => atMain(oursTree, p) },
    { paths: oursPaths, other: theirSet, has: (p: string) => atMain(oursTree, p), fileOnOther: (p: string) => atTask(theirsTree, p) },
  ];
  for (const side of sides) {
    for (const p of side.paths) {
      const parts = p.split("/");
      for (let i = 1; i < parts.length; i++) {
        const prefix = parts.slice(0, i).join("/");
        if (!side.other.has(prefix) || both.includes(prefix) || collisions.has(prefix)) continue;
        if ((await side.fileOnOther(prefix)) && (await side.has(p))) collisions.add(prefix);
      }
    }
  }
  for (const path of [...collisions].sort()) conflicts.push({ path, reason: "a file on one side and a folder on the other" });
  return { clean: conflicts.length === 0, conflicts, both, ours: oursPaths.length, theirs: theirsPaths.length };
}

// A file's lines, with a missing final newline kept as part of the last line,
// so that adding or removing only the final newline is a change to that line,
// as it is to git.
const NO_EOL = "\u0000no newline at end of file";
export function linesOf(bytes: Uint8Array): string[] {
  const text = new TextDecoder().decode(bytes);
  const lines = splitLines(text);
  if (text !== "" && !text.endsWith("\n")) lines[lines.length - 1] += NO_EOL;
  return lines;
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

// Where a task stands against main as it is now: how far main has moved since
// the task's fork point, and whether the task would merge. Artifacts lists
// main's first-parent line only, so a merged task counts once, as its merge.
export interface MainPreview {
  head: string;                 // main's head now
  ahead: number;                // commits on main's first-parent line since the fork point
  aheadCapped: boolean;         // the fork point is older than the log read; `ahead` is a floor
  merge: Mergeability;
}

const MAIN_LOG = 1000;

// The commits in main's log that the fork point cannot reach. Artifacts gives
// the first-parent line, so each merge counts once and the commits it brought
// in are not counted. When the log was cut short and the fork point is not in
// it, the count is a floor. When the whole log was read and the fork point is
// not in it, the fork point is not on main and there is no count.
export function commitsSince(log: { hash: string; parents?: string[] }[], base: string, cut: boolean): { ahead: number | null; capped: boolean } {
  const byHash = new Map(log.map((c) => [c.hash, c]));
  if (!byHash.has(base)) return cut ? { ahead: log.length, capped: true } : { ahead: null, capped: false };
  const reached = new Set<string>();
  const stack = [base];
  while (stack.length) {
    const h = stack.pop()!;
    if (reached.has(h)) continue;
    reached.add(h);
    for (const p of byHash.get(h)?.parents ?? []) if (byHash.has(p)) stack.push(p);
  }
  return { ahead: log.length - reached.size, capped: false };
}

export async function previewAgainstMain(artifacts: Artifacts, baselineRepo: string, workspaceRepo: string, base: string, baseTree: string, headTree: string): Promise<MainPreview | null> {
  using baseline = await artifacts.get(baselineRepo);
  using fork = await artifacts.get(workspaceRepo);
  const log = await baseline.log({ limit: MAIN_LOG });
  const head = log[0];
  if (!head) return null;
  const { ahead, capped } = commitsSince(log, base, log.length >= MAIN_LOG);
  if (ahead === null) return null;
  const merge = head.hash === base
    ? { clean: true, conflicts: [], both: [], ours: 0, theirs: 0 }
    : await mergeability(repoReader(baseline), repoReader(fork), baseTree, head.treeHash, headTree);
  return { head: head.hash, ahead, aheadCapped: capped, merge };
}
