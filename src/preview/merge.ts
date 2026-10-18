// Would this task merge cleanly into main as it is now? A three-way
// comparison, read only: the fork point (base), main's current head (ours)
// and the task's head (theirs). A path changed on one side only merges; a
// path changed the same way on both sides merges; a path changed differently
// on both sides merges only when the changes touch separate lines of the
// base, as git's own merge would decide, and is otherwise a conflict. Nothing
// here writes; `atelier merge` still makes the merge.
//
// The project's merge declarations (bin/merge-manifest.json, read through
// src/merge-declarations.ts, t463) are read as the CLI's merge pipeline
// reads them: a declared record file both sides changed merges by key, and
// a declared generated output is never a conflict but regenerable, listed
// apart with every output of a generator whose inputs both sides changed,
// since the pipeline regenerates those once the sources merge. No
// generator runs here.

import { changedPaths, diffLines, mergeBase, repoReader, splitLines, type Reader } from "../diff.ts";
import { MANIFEST_PATH, declarationProblems, generatorsToRun, mergeRecords, parseManifest, type Manifest } from "../merge-declarations.ts";
import { globToRegExp } from "../rules.ts";

export interface Conflict { path: string; reason: string }
export interface Mergeability {
  clean: boolean;
  conflicts: Conflict[];
  both: string[];               // paths both sides changed, conflicting or not
  regenerable?: string[];       // declared generated outputs the merge regenerates (not conflicts)
  generators?: string[];        // the generators that would regenerate them
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
      if (i === parts.length - 1) return e.type === "blob" || e.type === "exec" ? e.hash : null;
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
const regionsConflict = (a: Region[], b: Region[]) => a.some((x) => b.some((y) => x[0] <= y[1] && y[0] <= x[1] && !sameChange(x, y)));

// Two sides' changes to one file conflict when any of their regions overlap
// or touch, which is where git's merge stops and asks a person, unless both
// sides made the identical change there, which git takes once. Null when
// either side is too different from the base to compare here.
export function linesConflict(base: string[], ours: string[], theirs: string[]): boolean | null {
  const a = changedRegions(base, ours), b = changedRegions(base, theirs);
  if (!a || !b) return null;
  return regionsConflict(a, b);
}

// The lines git's merge would give a file both sides changed on separate
// lines: the base with each side's regions applied in order, a change both
// sides made alike taken once. Null where the sides conflict or either is
// too different from the base to diff.
export function mergeLines(base: string[], ours: string[], theirs: string[]): string[] | null {
  const a = changedRegions(base, ours), b = changedRegions(base, theirs);
  if (!a || !b || regionsConflict(a, b)) return null;
  const regions = [...a, ...b].sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out: string[] = [];
  let at = 0;
  for (let k = 0; k < regions.length; k++) {
    const r = regions[k];
    if (k + 1 < regions.length && sameChange(r, regions[k + 1])) k++;
    out.push(...base.slice(at, r[0]), ...r[2]);
    at = r[1];
  }
  out.push(...base.slice(at));
  return out;
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
  const mergedText = new Map<string, string>();
  const declared = await declarations(main, task, baseTree, oursTree, theirsTree);
  if ("problem" in declared) conflicts.push({ path: MANIFEST_PATH, reason: declared.problem });
  const manifest = "manifest" in declared ? declared.manifest : null;
  const outputs = new Set(manifest?.generators.flatMap((g) => g.outputs) ?? []);
  const generators = generatorsToRun(manifest, { mb: baseTree, a: oursPaths, b: theirsPaths, conflicted: both.filter((p) => outputs.has(p)) }, globToRegExp);
  const regenerable = [...new Set([...both.filter((p) => outputs.has(p)), ...generators.flatMap((g) => g.outputs)])].sort();
  for (const path of both) {
    if (outputs.has(path)) continue;                          // regenerated once the sources merge
    const [b, o, t] = await Promise.all([atMain(baseTree, path), atMain(oursTree, path), atTask(theirsTree, path)]);
    if (o === t) continue;                                    // the same change on both sides
    if (!o || !t) { conflicts.push({ path, reason: o ? "deleted by the task, changed on main" : t ? "deleted on main, changed by the task" : "removed or replaced on both sides" }); continue; }
    const [bb, ob, tb] = await Promise.all([b ? main.blob(b) : Promise.resolve(new Uint8Array()), main.blob(o), task.blob(t)]);
    if (!bb || !ob || !tb) { conflicts.push({ path, reason: "could not be read" }); continue; }
    if ([bb, ob, tb].some((x) => x.length > BLOB_LIMIT)) { conflicts.push({ path, reason: "too large to compare here" }); continue; }
    if ([bb, ob, tb].some(isBinary)) { conflicts.push({ path, reason: "a binary file changed on both sides" }); continue; }
    const record = manifest?.records.find((r) => r.path === path);
    if (record) {
      const merged = mergeRecords(...[bb, ob, tb].map((x) => new TextDecoder().decode(x)) as [string, string, string], record.pattern, record.framed);
      if (merged.problems.length) conflicts.push({ path, reason: `a declared record file that breaks its format: ${merged.problems.join("; ")}` });
      else if (merged.conflicts.length) conflicts.push({ path, reason: `records both sides changed differently: ${merged.conflicts.join("; ")}` });
      else mergedText.set(path, merged.text);
      continue;
    }
    const clash = linesConflict(linesOf(bb), linesOf(ob), linesOf(tb));
    if (clash === null) conflicts.push({ path, reason: "too large to compare here" });
    else if (clash) conflicts.push({ path, reason: b ? "both sides changed the same lines" : "added on both sides with different contents" });
    else mergedText.set(path, new TextDecoder().decode(bytesOf(mergeLines(linesOf(bb), linesOf(ob), linesOf(tb))!)));
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
  // Validate entries in the actual merged tree, including independent
  // additions at different paths and deletions from either side.
  if (!conflicts.length && manifest) {
    const files = new Map<string, string>();
    const folders = new Map<string, string[]>();
    const readMerged = async (path: string) => {
      if (mergedText.has(path)) return mergedText.get(path)!;
      const [reader, tree, at] = theirSet.has(path) ? [task, theirsTree, atTask] : [main, oursTree, atMain];
      const hash = await at(tree, path);
      if (!hash) return null;
      const bytes = await reader.blob(hash);
      if (!bytes) { conflicts.push({ path, reason: "could not be read" }); return null; }
      return new TextDecoder().decode(bytes);
    };
    for (const registry of manifest.registries) {
      const names = new Set([...(await folderFiles(main, oursTree, registry.dir)), ...(await folderFiles(task, theirsTree, registry.dir))]);
      const surviving: string[] = [];
      for (const name of names) {
        const path = `${registry.dir}/${name}`;
        const text = await readMerged(path);
        if (text !== null) { surviving.push(name); files.set(path, text); }
      }
      folders.set(registry.dir, surviving);
    }
    for (const record of manifest.records) {
      const text = await readMerged(record.path);
      if (text !== null) files.set(record.path, text);
    }
    for (const reason of declarationProblems(manifest, (path) => files.get(path) ?? null, (dir) => folders.get(dir) ?? [], globToRegExp)) {
      conflicts.push({ path: MANIFEST_PATH, reason });
    }
  }
  return {
    clean: conflicts.length === 0, conflicts, both, ours: oursPaths.length, theirs: theirsPaths.length,
    ...(regenerable.length ? { regenerable, generators: generators.map((g) => g.name) } : {}),
  };
}

// Direct files only, matching the CLI registry reader.
async function folderFiles(reader: Reader, root: string, folder: string): Promise<string[]> {
  let hash = root;
  for (const part of folder.split("/")) {
    const entry = (await reader.tree(hash))?.find((e) => e.name === part && e.type === "tree");
    if (!entry) return [];
    hash = entry.hash;
  }
  return (await reader.tree(hash) ?? []).filter((e) => e.type === "blob" || e.type === "exec").map((e) => e.name);
}

// The merge declarations the merged tree would hold: the task's where it
// changed the manifest, main's otherwise. None where the tree has no
// manifest; a problem where it cannot be read or parsed, which stops the
// pipeline's merge too.
async function declarations(main: Reader, task: Reader, baseTree: string, oursTree: string, theirsTree: string): Promise<{ manifest: Manifest } | { problem: string } | { none: true }> {
  const taskChanged = (await changedPaths(task, baseTree, theirsTree)).includes(MANIFEST_PATH);
  const [reader, tree] = taskChanged ? [task, theirsTree] : [main, oursTree];
  const hash = await locator(reader)(tree, MANIFEST_PATH);
  if (!hash) return { none: true };
  const bytes = await reader.blob(hash);
  if (!bytes) return { problem: "the merge manifest could not be read" };
  try { return { manifest: parseManifest(new TextDecoder().decode(bytes)) }; }
  catch (error) { return { problem: (error as Error).message.split("\n").join(" ") }; }
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

// The file linesOf read, written back: a final newline unless the last line
// says the file had none.
export function bytesOf(lines: string[]): Uint8Array {
  const noEol = lines.length > 0 && lines[lines.length - 1].endsWith(NO_EOL);
  const text = lines.map((l) => (l.endsWith(NO_EOL) ? l.slice(0, -NO_EOL.length) : l)).join("\n");
  return new TextEncoder().encode(lines.length && !noEol ? `${text}\n` : text);
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
//
// The fork point is the newest commit on main's first-parent line that the
// workspace's history holds (mergedHistory, mergeBase). The agent shapes
// that history, so this preview is advisory: it says what git would do
// with the history the fork presents. What the task changes is measured
// elsewhere, against main's head (see againstMain in src/diff.ts), and this
// preview never feeds the gate.
export interface MainPreview {
  head: string;                 // main's head now
  ahead: number;                // commits on main's first-parent line since the fork point
  aheadCapped: boolean;         // the fork point is older than the log read; `ahead` is a floor
  merge: Mergeability;
}

const MAIN_LOG = 1000;
const FORK_LOG = 500;

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

// The workspace's history as the fork point is looked for in it: the
// first-parent line read from its head, and behind each further parent a
// merge on it names, the first-parent chain from that parent, read the same
// way and in turn. A plan's branch takes main two merges deep: the
// integrator merges a merge-main part onto the branch, and the part's head
// is a merge whose second parent is main (t274), so main's newer commits are
// found only behind a merge's second parent. A chain stops at a commit main's
// first-parent line has, since what lies behind it is older main, and at a
// commit already read; the reads stop at FORK_READS chains or FORK_COMMITS
// commits, with what was found by then.
const FORK_READS = 20, FORK_COMMITS = 5000;
type Logged = { hash: string; parents?: string[] };
async function mergedHistory(fork: ArtifactsRepo, forkLog: Logged[], mainLog: Logged[]): Promise<Logged[]> {
  const main = new Set(mainLog.map((c) => c.hash));
  const out: Logged[] = [...forkLog];
  const seen = new Set<string>();
  const starts: string[] = [];
  const walk = (page: Logged[]) => {
    for (const c of page) {
      if (seen.has(c.hash)) break;
      seen.add(c.hash);
      if (main.has(c.hash)) break;
      for (const p of (c.parents ?? []).slice(1)) if (!main.has(p) && !seen.has(p)) starts.push(p);
    }
  };
  walk(forkLog);
  for (let reads = 0; starts.length && reads < FORK_READS && seen.size < FORK_COMMITS; reads++) {
    const start = starts.shift()!;
    if (seen.has(start)) { reads--; continue; }
    const page = await fork.log({ ref: start, limit: FORK_LOG });
    out.push(...page);
    walk(page);
  }
  return out;
}

// Null when either repository is empty, or when the fork's history meets
// none of main's first-parent line within the logs read: there is then no fork
// point to preview from, and the page says the preview could not be read.
export async function previewAgainstMain(artifacts: Artifacts, baselineRepo: string, workspaceRepo: string): Promise<MainPreview | null> {
  using baseline = await artifacts.get(baselineRepo);
  using fork = await artifacts.get(workspaceRepo);
  const [log, forkLog] = await Promise.all([baseline.log({ limit: MAIN_LOG }), fork.log({ limit: FORK_LOG })]);
  const head = log[0], theirs = forkLog[0];
  if (!head || !theirs) return null;
  const base = mergeBase(await mergedHistory(fork, forkLog, log), log.map((c) => c.hash));
  if (!base) return null;
  const baseTree = log.find((c) => c.hash === base)!.treeHash;
  const { ahead, capped } = commitsSince(log, base, log.length >= MAIN_LOG);
  if (ahead === null) return null;
  const merge = head.hash === base
    ? { clean: true, conflicts: [], both: [], ours: 0, theirs: 0 }
    : await mergeability(repoReader(baseline), repoReader(fork), baseTree, head.treeHash, theirs.treeHash);
  return { head: head.hash, ahead, aheadCapped: capped, merge };
}
