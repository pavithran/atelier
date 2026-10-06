// An item's diff against the baseline, computed from Artifacts objects. The
// binding reads trees, blobs and commit logs but has no diff operation, so the
// line diff (Myers) and the tree walk live here. The algorithms are pure and
// take a reader, so they are tested without Cloudflare.

import type { MainPreview } from "./preview/merge.ts";

export type Op = { op: " " | "+" | "-"; text: string };

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: Op[];
}

export type FileStatus = "added" | "deleted" | "modified" | "mode" | "binary" | "too-large" | "submodule";

export interface FileChange {
  path: string;
  status: FileStatus;
  added: number;
  removed: number;
  hunks: Hunk[];
}

export interface ItemDiff {
  base: string;          // main's head, which the diff is measured against
  head: string;
  files: FileChange[];
  truncated: boolean;    // more changed files than the limit; the rest are not listed
  baseTree?: string;     // main's tree and the head's
  headTree?: string;
  main?: MainPreview | null;  // how far main has moved since the fork point, and whether it merges; absent when not read
}

export const LIMITS = {
  files: 60,             // changed files listed
  blobBytes: 256 * 1024, // larger blobs are listed but not diffed
  diffLines: 20_000,     // old + new lines beyond which a file is not diffed
  treeReads: 1_000,      // directories read for one diff; deeper changes are not listed
  context: 3,
};

// ── line diff ──────────────────────────────────────────────────────────────

// Myers' O(ND) shortest edit script, returned as a full sequence of kept,
// added and removed lines, or null when it would cost more memory than a
// Worker can spare; the caller then lists the file as too large to diff.
// Common leading and trailing lines are set aside first, a side left empty
// needs no search, and each step keeps only the diagonals it reached, so
// memory grows with the square of the edit distance and not with the file.
export const DIFF_BUDGET = 4_000_000;   // stored diagonal positions, about 16 MB

export function diffLines(a: string[], b: string[], budget = DIFF_BUDGET): Op[] | null {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const head: Op[] = a.slice(0, pre).map((text) => ({ op: " ", text }));
  const tail: Op[] = a.slice(a.length - suf).map((text) => ({ op: " ", text }));
  const x0 = a.slice(pre, a.length - suf), y0 = b.slice(pre, b.length - suf);
  if (!x0.length) return [...head, ...y0.map((text): Op => ({ op: "+", text })), ...tail];
  if (!y0.length) return [...head, ...x0.map((text): Op => ({ op: "-", text })), ...tail];
  const middle = myers(x0, y0, budget);
  return middle ? [...head, ...middle, ...tail] : null;
}

function myers(a: string[], b: string[], budget: number): Op[] | null {
  const n = a.length, m = b.length, max = n + m;
  const offset = max;
  const v = new Int32Array(2 * max + 2);
  // trace[d] holds v for diagonals -d..d only, as they were before step d.
  const trace: Int32Array[] = [];
  let stored = 0, found = false;
  for (let d = 0; d <= max && !found; d++) {
    stored += 2 * d + 1;
    if (stored > budget) return null;
    trace.push(v.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) { found = true; break; }
    }
  }
  const at = (d: number, k: number) => trace[d][k + d];
  const ops: Op[] = [];
  let x = n, y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const k = x - y;
    const prevK = k === -d || (k !== d && at(d, k - 1) < at(d, k + 1)) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : at(d, prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) ops.push({ op: " ", text: a[--x] }), y--;
    if (d > 0) {
      if (x === prevX) ops.push({ op: "+", text: b[--y] });
      else ops.push({ op: "-", text: a[--x] });
    }
  }
  return ops.reverse();
}

// Group an edit script into unified-diff hunks with `context` lines around changes.
export function toHunks(ops: Op[], context = LIMITS.context): Hunk[] {
  const hunks: Hunk[] = [];
  let oldLine = 1, newLine = 1;
  let current: Hunk | null = null;
  let trailing = 0; // unchanged lines since the last change in `current`
  for (let i = 0; i < ops.length; i++) {
    const o = ops[i];
    if (o.op === " ") {
      if (current) {
        if (trailing < context) {
          current.lines.push(o);
          current.oldLines++;
          current.newLines++;
          trailing++;
        } else {
          // Close the hunk unless another change follows within the context window.
          const nextChange = ops.slice(i, i + context + 1).findIndex((p) => p.op !== " ");
          if (nextChange === -1) { hunks.push(current); current = null; }
          else { current.lines.push(o); current.oldLines++; current.newLines++; }
        }
      }
      oldLine++; newLine++;
      continue;
    }
    if (!current) {
      const lead = [];
      for (let j = i - 1; j >= 0 && lead.length < context && ops[j].op === " "; j--) lead.unshift(ops[j]);
      current = {
        oldStart: oldLine - lead.length,
        newStart: newLine - lead.length,
        oldLines: lead.length,
        newLines: lead.length,
        lines: [...lead],
      };
    }
    current.lines.push(o);
    trailing = 0;
    if (o.op === "-") { current.oldLines++; oldLine++; }
    else { current.newLines++; newLine++; }
  }
  if (current) hunks.push(current);
  // Git numbers an empty side from zero: "@@ -0,0 +1,2 @@" for a new file.
  for (const h of hunks) {
    if (h.oldLines === 0) h.oldStart--;
    if (h.newLines === 0) h.newStart--;
  }
  return hunks;
}

export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function isBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8000);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

// ── tree diff ──────────────────────────────────────────────────────────────

export interface Entry { name: string; mode: string; hash: string; type: string }

export interface Reader {
  tree(hash: string): Promise<Entry[] | null>;
  blob(hash: string): Promise<Uint8Array | null>;
}

type Leaf = { path: string; hash: string; mode: string };

// Paths whose entry differs between two trees, descending only into subtrees
// whose hashes differ.
// The entries that differ between two directory listings, and nothing else:
// the listings are dropped before any recursion, so a deep tree holds only
// the changed names of each ancestor, never their whole directories.
function differing(a: Entry[] | null, b: Entry[] | null): [Entry | undefined, Entry | undefined, string][] {
  const left = new Map((a ?? []).map((e) => [e.name, e]));
  const out: [Entry | undefined, Entry | undefined, string][] = [];
  for (const rt of b ?? []) {
    const l = left.get(rt.name);
    left.delete(rt.name);
    if (!(l && l.hash === rt.hash && l.mode === rt.mode)) out.push([l, rt, rt.name]);
  }
  for (const [name, l] of left) out.push([l, undefined, name]);
  return out.sort((x, y) => (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0));
}

async function changedLeaves(r: Reader, base: string | null, head: string | null, prefix: string, out: [Leaf | null, Leaf | null][], cap: number) {
  if (out.length > cap) return;
  // The listings are passed straight to differing() and never held here.
  // Every changed entry is kept: a changed subdirectory may hold no changed
  // file at all (an empty tree), so no level can know in advance how many of
  // its entries will be listed.
  const changed = differing(...(await Promise.all([base ? r.tree(base) : [], head ? r.tree(head) : []])));
  for (const [l, rt, name] of changed) {
    if (out.length > cap) return;
    const path = prefix + name;
    const lTree = l?.type === "tree", rTree = rt?.type === "tree";
    if (lTree || rTree) {
      await changedLeaves(r, lTree ? l!.hash : null, rTree ? rt!.hash : null, path + "/", out, cap);
      if (l && !lTree) out.push([{ path, hash: l.hash, mode: l.mode }, null]);
      if (rt && !rTree) out.push([null, { path, hash: rt.hash, mode: rt.mode }]);
      continue;
    }
    // A submodule is listed as a change of the commit it points to; its
    // contents live in another repository and are not read.
    out.push([l ? { path, hash: l.hash, mode: l.mode } : null, rt ? { path, hash: rt.hash, mode: rt.mode } : null]);
  }
}

const decoder = new TextDecoder();

const OUT_OF_READS = new Error("diff tree read budget reached");

export async function treeDiff(r: Reader, baseTree: string, headTree: string, limits = LIMITS): Promise<{ files: FileChange[]; truncated: boolean }> {
  const pairs: [Leaf | null, Leaf | null][] = [];
  // A diff reads at most limits.treeReads directories; what lies beyond is
  // left unlisted and the diff is marked truncated.
  let reads = 0;
  const bounded: Reader = { tree: (h) => { if (++reads > limits.treeReads) throw OUT_OF_READS; return r.tree(h); }, blob: r.blob };
  let outOfReads = false;
  await changedLeaves(bounded, baseTree, headTree, "", pairs, limits.files).catch((err) => { if (err !== OUT_OF_READS) throw err; outOfReads = true; });
  const truncated = outOfReads || pairs.length > limits.files;
  const files = await Promise.all(pairs.slice(0, limits.files).map(async ([l, rt]) => {
    const path = (rt ?? l)!.path;
    if (l?.mode === "160000" || rt?.mode === "160000") return { path, status: "submodule" as FileStatus, added: 0, removed: 0, hunks: [] };
    const status: FileStatus = !l ? "added" : !rt ? "deleted" : l.hash === rt.hash ? "mode" : "modified";
    if (status === "mode") return { path, status, added: 0, removed: 0, hunks: [] };
    const [before, after] = await Promise.all([l ? r.blob(l.hash) : null, rt ? r.blob(rt.hash) : null]);
    const size = Math.max(before?.length ?? 0, after?.length ?? 0);
    if (size > limits.blobBytes) return { path, status: "too-large" as FileStatus, added: 0, removed: 0, hunks: [] };
    if ((before && isBinary(before)) || (after && isBinary(after))) return { path, status: "binary" as FileStatus, added: 0, removed: 0, hunks: [] };
    const a = before ? splitLines(decoder.decode(before)) : [];
    const b = after ? splitLines(decoder.decode(after)) : [];
    if (a.length + b.length > limits.diffLines) return { path, status: "too-large" as FileStatus, added: 0, removed: 0, hunks: [] };
    const ops = diffLines(a, b);
    if (!ops) return { path, status: "too-large" as FileStatus, added: 0, removed: 0, hunks: [] };
    return {
      path, status,
      added: ops.filter((o) => o.op === "+").length,
      removed: ops.filter((o) => o.op === "-").length,
      hunks: toHunks(ops, limits.context),
    };
  }));
  return { files, truncated };
}

// ── Artifacts ──────────────────────────────────────────────────────────────

// What an item changes is measured against main as it is now: every path
// whose content at the item's head differs from main's head. That is the set
// of paths a merge of the item could change on main, whatever the merge base
// turns out to be, because git keeps a path both sides agree on. No commit
// graph the agent pushes can shrink it: the only way to take a path off the
// list is to hold main's content for it. A workspace behind main lists main's
// newer changes too, until `atelier update` brings them in; a workspace that
// has them lists only its own work.
//
// The fork point below is not used for this. It is read from the fork's
// first-parent log, which the agent shapes: a merge commit whose first parent
// descends from an older main commit makes that commit the fork point, while
// the merge's other parent carries main's newer history, so git merges the
// item with a newer base and a protected file the head quietly reverted lands
// unmeasured. The fork point serves only the merge preview, which says how far
// main has moved and whether the item's own commits would merge, and is
// advisory.
export interface Measure { main: string; mainTree: string; head: string; headTree: string }

export async function againstMain(fork: ArtifactsRepo, baseline: ArtifactsRepo): Promise<Measure | null> {
  const [[head], [main]] = await Promise.all([fork.log({ limit: 1 }), baseline.log({ limit: 1 })]);
  if (!head || !main) return null;
  return { main: main.hash, mainTree: main.treeHash, head: head.hash, headTree: head.treeHash };
}

// A reader over both repositories. The head's objects are in the fork; main's
// newer objects are only in the baseline. Git objects are content addressed,
// so a hash names the same object wherever it is found, and the fork is tried
// first because a workspace that has taken main's commits holds both sides.
export function pairReader(fork: ArtifactsRepo, baseline: ArtifactsRepo): Reader {
  const a = repoReader(fork), b = repoReader(baseline);
  return {
    tree: async (h) => (await a.tree(h)) ?? b.tree(h),
    blob: async (h) => (await a.blob(h)) ?? b.blob(h),
  };
}

// The fork point is the newest commit on the workspace's first-parent history
// that the baseline also has, so a workspace rebased with `atelier update`
// is previewed against what it was rebased onto, not against where it was
// forked. The agent shapes this history (see againstMain), so it is read only
// for the merge preview, never to measure what the item changes.
export function mergeBase(workspaceLog: string[], baselineLog: string[]): string | null {
  const shared = new Set(baselineLog);
  return workspaceLog.find((h) => shared.has(h)) ?? null;
}

// The workspace head and its fork point, with the trees of both.
export interface ForkPoint { base: string; baseTree: string; head: string; headTree: string }

export async function forkPoint(fork: ArtifactsRepo, baseline: ArtifactsRepo): Promise<ForkPoint | null> {
  const [forkLog, baseLog] = await Promise.all([fork.log({ limit: 500 }), baseline.log({ limit: 1000 })]);
  const head = forkLog[0];
  const base = mergeBase(forkLog.map((c) => c.hash), baseLog.map((c) => c.hash));
  if (!head || !base) return null;
  const baseCommit = forkLog.find((c) => c.hash === base) ?? (await fork.readCommit(base));
  if (!baseCommit) return null;
  return { base, baseTree: baseCommit.treeHash, head: head.hash, headTree: head.treeHash };
}

export function repoReader(repo: ArtifactsRepo): Reader {
  return {
    tree: (h) => repo.readTree(h),
    blob: async (h) => {
      const b = await repo.readBlob(h);
      return b ? new Uint8Array(await b.arrayBuffer()) : null;
    },
  };
}

// Every changed path, uncapped by the display limit: deciding whether an item
// touches a protected path needs the whole list, not the first page of it.
export async function changedPaths(r: Reader, baseTree: string, headTree: string, cap = 20_000): Promise<string[]> {
  const pairs: [Leaf | null, Leaf | null][] = [];
  await changedLeaves(r, baseTree, headTree, "", pairs, cap);
  if (pairs.length > cap) throw new Error(`more than ${cap} changed paths`);
  return pairs.map(([l, rt]) => (rt ?? l)!.path);
}

// The workspace's head and every path it changes against its fork point, both
// read from Artifacts, as the sandbox runner reads them. The gate classifies a
// change on these paths, so they come from here and never from the caller.
// When forkPoint finds no commit the workspace shares with the baseline,
// nothing is measured: the paths are null and the gate waits.
export interface Measurement { head: string | null; changedPaths: string[] | null }

export async function measureWorkspace(artifacts: Artifacts, baselineRepo: string, workspaceRepo: string): Promise<Measurement> {
  using fork = await artifacts.get(workspaceRepo);
  using baseline = await artifacts.get(baselineRepo);
  const fp = await forkPoint(fork, baseline);
  if (!fp) return { head: (await fork.log({ limit: 1 }))[0]?.hash ?? null, changedPaths: null };
  return { head: fp.head, changedPaths: await changedPaths(repoReader(fork), fp.baseTree, fp.headTree) };
}

// The item's diff against main as it is now (see againstMain).
export async function itemDiff(artifacts: Artifacts, baselineRepo: string, workspaceRepo: string): Promise<ItemDiff | null> {
  using fork = await artifacts.get(workspaceRepo);
  using baseline = await artifacts.get(baselineRepo);
  const m = await againstMain(fork, baseline);
  if (!m) return null;
  if (m.mainTree === m.headTree) return { base: m.main, head: m.head, files: [], truncated: false, baseTree: m.mainTree, headTree: m.headTree };
  const { files, truncated } = await treeDiff(pairReader(fork, baseline), m.mainTree, m.headTree);
  return { base: m.main, head: m.head, files, truncated, baseTree: m.mainTree, headTree: m.headTree };
}
