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
  merged?: Landed;       // set on a merged item's diff, which shows the change as it landed (mergedDiff)
}

// How a merged item's diff was read: from the merge commit's first parent to
// the merge, or, when the merge is the accepted head itself (a fast-forward),
// from the item's fork point to that head.
export interface Landed { commit: string; from: "first-parent" | "fork-point" }

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

// An item's diff as text, in git's shape so a reader greps it as any diff: a
// file header, the status git would note, then the hunks with their @@ lines.
// Files Artifacts could not diff (binary, too large, a submodule) keep their
// place as notes, so the text still lists every changed file. This is what a
// review too large for its brief leaves in R2 by reference (t284): the ledger
// names the key and anything may read the whole diff back as text.
export function renderDiffText(item: string, diff: ItemDiff): string {
  const out: string[] = [`# diff of ${item} from ${diff.base} (base) to ${diff.head} (head), as Atelier read it from Artifacts`];
  for (const f of diff.files) {
    out.push(`diff --git a/${f.path} b/${f.path}`);
    if (f.status === "added") out.push("new file");
    if (f.status === "deleted") out.push("deleted file");
    if (f.status === "mode") out.push("mode changed");
    if (f.status === "binary") out.push("Binary files differ");
    if (f.status === "too-large") out.push(`File too large to diff here (over ${LIMITS.diffLines} lines or ${LIMITS.blobBytes} bytes)`);
    if (f.status === "submodule") out.push("Submodule");
    for (const h of f.hunks) {
      out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
      for (const line of h.lines) out.push(`${line.op}${line.text}`);
    }
  }
  if (diff.truncated) out.push(`# only the first ${LIMITS.files} changed files are listed; more are not`);
  return out.join("\n");
}

// Whether content is binary: a NUL byte within its first 8000 bytes, as git
// decides it. Decided from the content alone, never from the path.
export function isBinary(bytes: Uint8Array): boolean {
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

export type Leaf = { path: string; hash: string; mode: string };

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

// Changed entries a level holds while the diff descends into one of them,
// however wide the level is.
const RETAINED = 1_000;

// The changed entries of one level from `from` on, at most `size` of them,
// with how many the level has. The listings and the whole changed list live
// only in this call, so a level holds no more than the page it is given.
async function changedPage(r: Reader, base: string | null, head: string | null, from: number, size: number) {
  const changed = differing(...(await Promise.all([base ? r.tree(base) : [], head ? r.tree(head) : []])));
  return { page: changed.slice(from, from + size), total: changed.length };
}

async function changedLeaves(r: Reader, base: string | null, head: string | null, prefix: string, out: [Leaf | null, Leaf | null][], cap: number) {
  // A level holds one page of RETAINED changed entries while the diff
  // descends, so a deep tree where every file at every level changed holds a
  // page per ancestor rather than each ancestor's whole directory. When
  // entries remain past the page, the level is read again and continues from
  // the next one: an entry that lists nothing, such as an added empty
  // directory, never hides a later one. The page is the same size however
  // close the list is to its cap, so a level is read at most once per page
  // rather than once per entry as the cap nears.
  for (let done = 0; out.length <= cap; ) {
    const { page, total } = await changedPage(r, base, head, done, RETAINED);
    done += page.length;
    for (const [l, rt, name] of page) {
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
    if (done >= total) return;
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
    const tooLarge = { path, status: "too-large" as FileStatus, added: 0, removed: 0, hunks: [] };
    if (size > limits.blobBytes) return tooLarge;
    if ((before && isBinary(before)) || (after && isBinary(after))) return { path, status: "binary" as FileStatus, added: 0, removed: 0, hunks: [] };
    const a = before ? splitLines(decoder.decode(before)) : [];
    const b = after ? splitLines(decoder.decode(after)) : [];
    if (a.length + b.length > limits.diffLines) return tooLarge;
    const ops = diffLines(a, b);
    if (!ops) return tooLarge;
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

// The merge base the preview works from: the newest commit on main's
// first-parent line that the workspace holds, either among the commits of
// the workspace read (its first-parent line, and the chains behind its
// merges' further parents: mergedHistory in src/preview/merge.ts) or as a
// parent of one of them. A workspace rebased with `atelier
// update` is previewed against what it was rebased onto, and one that merged
// main is previewed against the main commit it merged, not against where it
// forked, whose newer main commits it already holds (t230). The agent shapes
// this history (see againstMain), so it is read only for the merge preview,
// never to measure what the item changes.
export function mergeBase(workspaceLog: { hash: string; parents?: string[] }[], baselineLog: string[]): string | null {
  const held = new Set(workspaceLog.flatMap((c) => [c.hash, ...(c.parents ?? [])]));
  return baselineLog.find((h) => held.has(h)) ?? null;
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

// Every pair of entries that differs between two trees, uncapped by the
// display limit: the base side and the head side of each path, either null
// where the path is absent on that side, with the hash and mode of each. A
// path added, deleted, modified, renamed (listed as a deletion and an
// addition), type-changed or mode-changed is listed; one both trees hold
// with the same hash and mode is not. It is enumeration only: nothing is
// read or classified here, so a caller that must see every changed object
// (the secret scan, scanTrees in src/secret-scan.ts) reads each by its hash
// and decides for itself what it is.
export async function changedEntries(r: Reader, baseTree: string, headTree: string, cap = 20_000): Promise<[Leaf | null, Leaf | null][]> {
  const pairs: [Leaf | null, Leaf | null][] = [];
  await changedLeaves(r, baseTree, headTree, "", pairs, cap);
  if (pairs.length > cap) throw new Error(`more than ${cap} changed paths`);
  return pairs;
}

// Every changed path, uncapped by the display limit: deciding whether an item
// touches a protected path needs the whole list, not the first page of it.
export async function changedPaths(r: Reader, baseTree: string, headTree: string, cap = 20_000): Promise<string[]> {
  return (await changedEntries(r, baseTree, headTree, cap)).map(([l, rt]) => (rt ?? l)!.path);
}

// The workspace's head and every path it differs from main's head on (see
// againstMain), both read from Artifacts with the measure the sandbox runner
// uses. The gate classifies a change on these paths, so they come from here
// and never from the caller, and never from a fork point the workspace's
// history chooses. When either repository has no commits, nothing is
// measured: the paths are null and the gate waits.
export interface Measurement { head: string | null; main: string | null; changedPaths: string[] | null }

export async function measureWorkspace(artifacts: Artifacts, baselineRepo: string, workspaceRepo: string): Promise<Measurement> {
  using fork = await artifacts.get(workspaceRepo);
  using baseline = await artifacts.get(baselineRepo);
  const m = await againstMain(fork, baseline);
  if (!m) return { head: (await fork.log({ limit: 1 }))[0]?.hash ?? null, main: null, changedPaths: null };
  return { head: m.head, main: m.main, changedPaths: await changedPaths(pairReader(fork, baseline), m.mainTree, m.headTree) };
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

// A reader for the secret scan over any other: a tree or blob the head or
// base names that neither repository holds is an error, never empty content.
// The display diff reads a missing object as nothing (changedPage, treeDiff),
// which shows a reader what can be shown; the scan must not, because a missing
// blob read as empty is a file with no added lines, and so no findings, and a
// missing tree is a directory with no changes. Thrown, the scan stays pending
// and is retried (scanRecorded in src/index.ts).
export function strictReader(r: Reader): Reader {
  return {
    tree: async (h) => {
      const t = await r.tree(h);
      if (!t) throw new Error(`secret scan: tree ${h.slice(0, 8)} is missing from the repositories`);
      return t;
    },
    blob: async (h) => {
      const b = await r.blob(h);
      if (!b) throw new Error(`secret scan: blob ${h.slice(0, 8)} is missing from the repositories`);
      return b;
    },
  };
}

// ── merged items ───────────────────────────────────────────────────────────

// Where a merged item landed, read from its record: the merge commit of its
// last `item.merged` event, with the head merged and where the item forked.
// A part merged through its plan landed on the plan's branch first, so its
// change is the merge that integrated it there (`part.integrated`), in the
// plan's fork, and not the plan's merge onto main, which carries every part.
// Null for an item not merged.
export interface Landing { commit: string; head: string | null; base: string | null; onPlanBranch: boolean }

export function landingOf(
  item: { id: string; state: string; base: string | null; acceptedHead: string | null },
  events: { itemId: string | null; kind: string; data: Record<string, unknown> }[],
): Landing | null {
  if (item.state !== "merged") return null;
  const own = events.filter((e) => e.itemId === item.id);
  const merge = own.findLast((e) => e.kind === "item.merged" && typeof e.data.mergeCommit === "string");
  if (!merge) return null;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const integrated = merge.data.via ? own.findLast((e) => e.kind === "part.integrated" && typeof e.data.mergeCommit === "string") : undefined;
  if (integrated) return { commit: integrated.data.mergeCommit as string, head: str(integrated.data.head), base: item.base, onPlanBranch: true };
  return { commit: merge.data.mergeCommit as string, head: str(merge.data.head) ?? item.acceptedHead, base: item.base, onPlanBranch: false };
}

// A merged item's diff as it landed (t321), never against main as it is now:
// main has moved on since, and against today's main every file added after
// the merge would be listed as the item deleting it. A merge commit with its
// own first parent, a true merge or a squash, is diffed from that parent;
// one that is the merged head itself, a fast-forward, is diffed from the
// item's fork point, since its first parent is only the head's last commit's.
// `repoName` holds the merge commit; the workspace, when there is one, is
// read too for a fork point main does not hold. A merge that cannot be read
// throws, so the page says the diff is unavailable rather than empty.
export async function mergedDiff(artifacts: Artifacts, repoName: string, workspaceRepo: string | null, landing: Landing): Promise<ItemDiff> {
  using repo = await artifacts.get(repoName);
  using fork = workspaceRepo ? await artifacts.get(workspaceRepo) : null;
  const reader = fork ? pairReader(fork, repo) : repoReader(repo);
  const commit = async (h: string) => (await repo.readCommit(h)) ?? (fork ? await fork.readCommit(h) : null);
  const merge = await commit(landing.commit);
  if (!merge) throw new Error(`merge commit ${landing.commit} is not readable`);
  const fastForward = merge.hash === landing.head && merge.parents.length < 2;
  const baseHash = fastForward ? landing.base : merge.parents[0] ?? null;
  const base = baseHash ? await commit(baseHash) : null;
  if (!base) throw new Error(`the commit ${landing.commit} landed on is not readable`);
  const from: Landed["from"] = fastForward ? "fork-point" : "first-parent";
  const shown = { base: base.hash, head: merge.hash, baseTree: base.treeHash, headTree: merge.treeHash, merged: { commit: merge.hash, from } };
  if (base.treeHash === merge.treeHash) return { ...shown, files: [], truncated: false };
  return { ...shown, ...(await treeDiff(reader, base.treeHash, merge.treeHash)) };
}
