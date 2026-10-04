// Reading a repository for people: a directory, a file, the log, one commit's
// changes, and the commits that changed a path. Everything goes through the
// Artifacts binding's reads (log, readCommit, readTree, readBlob); nothing
// here writes. The functions take a small interface rather than the binding,
// so the tests drive them with plain objects.

import { LIMITS, treeDiff, type FileChange, type Reader } from "../diff.ts";

// The same test git uses: a zero byte in the first 8,000 means binary.
const isBinary = (bytes: Uint8Array) => bytes.subarray(0, 8000).includes(0);

export interface Commit {
  hash: string;
  treeHash: string;
  message: string;
  author: { name: string; email: string };
  parents: string[];
  authoredAt: number;
}

export interface Source extends Reader {
  log(opts: { ref?: string; limit?: number; offset?: number }): Promise<Commit[]>;
  commit(hash: string): Promise<Commit | null>;
  // A file's bytes, or only its size when it is over `limit`, so a large file
  // is refused without being read into memory.
  file(hash: string, limit: number): Promise<Uint8Array | { size: number } | null>;
}

// A file Artifacts would not buffer is reported as too large, not as an error.
const MEMORY_LIMIT = /MEMORY_LIMIT/;
const OVERSIZE = new Uint8Array(LIMITS.blobBytes + 1);

export function repoSource(repo: ArtifactsRepo): Source {
  return {
    tree: (h) => repo.readTree(h),
    blob: async (h) => {
      try {
        const b = await repo.readBlob(h);
        if (!b) return null;
        // Bytes beyond the diff's own limit are never compared; a stand-in of
        // that size is enough for the diff to list the file as too large.
        if (b.size > OVERSIZE.length - 1) return OVERSIZE;
        return new Uint8Array(await b.arrayBuffer());
      } catch (err) {
        if (MEMORY_LIMIT.test(String((err as { code?: string }).code ?? err))) return OVERSIZE;
        throw err;
      }
    },
    log: (o) => repo.log(o),
    commit: (h) => repo.readCommit(h),
    file: async (h, limit) => {
      try {
        const b = await repo.readBlob(h);
        if (!b) return null;
        return b.size > limit ? { size: b.size } : new Uint8Array(await b.arrayBuffer());
      } catch (err) {
        if (MEMORY_LIMIT.test(String((err as { code?: string }).code ?? err))) return { size: Number.POSITIVE_INFINITY };
        throw err;
      }
    },
  };
}

// A path from a URL: segments without empty parts, "." or "..". Anything else
// is refused rather than normalised, so a link means exactly one path.
export function cleanPath(parts: string[]): string[] | null {
  const out = parts.filter((p) => p !== "");
  return out.some((p) => p === "." || p === ".." || p.includes("\0")) ? null : out;
}

// Regular and executable files are both files; a symbolic link is shown as
// the path it points to; a submodule has no content here.
export const READABLE = new Set(["blob", "exec", "symlink"]);

export type Node =
  | { kind: "tree"; hash: string; entries: { name: string; type: string; mode: string; hash: string }[]; total: number }
  | { kind: "blob"; hash: string; mode: string; type: string }
  | { kind: "other"; hash: string; type: string };

// The most entries a directory page lists; the rest are counted, not shown.
export const TREE_LIMIT = 1000;

// The object at a path under a root tree, or null when the path does not exist.
export async function walk(r: Reader, rootTree: string, path: string[]): Promise<Node | null> {
  let hash = rootTree;
  for (let i = 0; i < path.length; i++) {
    const entries = await r.tree(hash);
    const entry = entries?.find((x) => x.name === path[i]);
    if (!entry) return null;
    if (i < path.length - 1 && entry.type !== "tree") return null;
    if (i === path.length - 1) {
      if (READABLE.has(entry.type)) return { kind: "blob", hash: entry.hash, mode: entry.mode, type: entry.type };
      if (entry.type !== "tree") return { kind: "other", hash: entry.hash, type: entry.type };
    }
    hash = entry.hash;
  }
  // Artifacts returns a directory whole, so its size bounds this read and no
  // limit here can avoid that; TREE_LIMIT bounds what is copied out and shown.
  // The sort works on a copy of the references, never on the reader's array.
  const entries = (await r.tree(hash)) ?? [];
  const sorted = [...entries].sort((a, b) => (a.type === "tree" ? 0 : 1) - (b.type === "tree" ? 0 : 1) || a.name.localeCompare(b.name));
  return { kind: "tree", hash, entries: sorted.slice(0, TREE_LIMIT).map(({ name, type, mode, hash }) => ({ name, type, mode, hash })), total: sorted.length };
}

export const FILE_LIMIT = 512 * 1024;

export type FileView =
  | { kind: "text"; lines: string[]; bytes: number }
  | { kind: "binary"; bytes: number }
  | { kind: "too-large"; bytes: number };

export function viewFile(bytes: Uint8Array | { size: number }): FileView {
  if (!(bytes instanceof Uint8Array)) return { kind: "too-large", bytes: bytes.size };
  if (bytes.length > FILE_LIMIT) return { kind: "too-large", bytes: bytes.length };
  if (isBinary(bytes)) return { kind: "binary", bytes: bytes.length };
  const text = new TextDecoder().decode(bytes);
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return { kind: "text", lines, bytes: bytes.length };
}

// The commit a ref names, or null.
export async function resolve(s: Source, ref: string): Promise<Commit | null> {
  return (await s.log({ ref, limit: 1 }))[0] ?? null;
}

export const LOG_PAGE = 50;

export async function logPage(s: Source, ref: string, page: number): Promise<{ commits: Commit[]; more: boolean }> {
  const commits = await s.log({ ref, limit: LOG_PAGE + 1, offset: Math.max(0, page) * LOG_PAGE });
  return { commits: commits.slice(0, LOG_PAGE), more: commits.length > LOG_PAGE };
}

// One commit's changes against its first parent; a root commit against nothing.
export async function commitChanges(s: Source, hash: string): Promise<{ commit: Commit; parent: string | null; files: FileChange[]; truncated: boolean; parentMissing?: boolean } | null> {
  const commit = await s.commit(hash);
  if (!commit) return null;
  const parentHash = commit.parents[0] ?? null;
  const parent = parentHash ? await s.commit(parentHash) : null;
  // A parent that cannot be read is said so; diffing against nothing would
  // show every file as added.
  if (parentHash && !parent) return { commit, parent: parentHash, files: [], truncated: false, parentMissing: true };
  const r: Reader = { tree: (h) => (h === EMPTY_TREE ? Promise.resolve([]) : s.tree(h)), blob: s.blob };
  const { files, truncated } = await treeDiff(r, parent?.treeHash ?? EMPTY_TREE, commit.treeHash);
  return { commit, parent: parentHash, files, truncated };
}

// Git's empty tree. A reader asked for it returns no entries, so a root
// commit diffs as every file added.
export const EMPTY_TREE = "4b825dc642cb6eb9a060c54bf8d69288fbee4904";

// A path's history examines at most this many commits, ten at a time. Each
// distinct tree on the path is read once, so a page costs one read per
// commit for the root and one per changed directory below it: about a
// hundred reads for a shallow path, and up to the cap times the path's depth
// for a deep path changed in every commit.
export const HISTORY_CAP = 100;
// And at most this many tree reads in all: a deep path changed in every
// commit stops early and says the history is incomplete.
export const HISTORY_READS = 400;
const HISTORY_BATCH = 10;

// The commits on the first-parent line that changed what is at a path: the
// entry's hash differs from the next older commit's. Trees are read once per
// hash, so directories that did not change cost nothing after the first read.
// At most HISTORY_CAP commits are examined; `complete` says whether that was
// the whole history.
export async function pathHistory(s: Source, ref: string, path: string[], cap = HISTORY_CAP, budget = HISTORY_READS): Promise<{ commits: Commit[]; complete: boolean }> {
  const log = await s.log({ ref, limit: cap + 1 });
  const trees = new Map<string, ReturnType<Reader["tree"]>>();
  let reads = 0;
  const cached: Reader = {
    tree: (h) => {
      if (!trees.has(h)) {
        if (++reads > budget) throw OVER_BUDGET;
        trees.set(h, s.tree(h));
      }
      return trees.get(h)!;
    },
    blob: s.blob,
  };
  // Each commit's entry at the path, located ten commits at a time; the walk
  // stops at the first commit the read budget does not reach.
  const at: (string | null)[] = [];
  let stopped = false;
  for (let i = 0; i < log.length && !stopped; i += HISTORY_BATCH) {
    const batch = await Promise.all(log.slice(i, i + HISTORY_BATCH).map((c) =>
      locate(cached, c.treeHash, path).catch((err) => { if (err === OVER_BUDGET) return UNKNOWN; throw err; })));
    for (const x of batch) {
      if (x === UNKNOWN) { stopped = true; break; }
      at.push(x as string | null);
    }
  }
  // A commit is decided against the one before it in history. The oldest one
  // located is decided only when it is the first commit of all.
  const last = log[at.length - 1];
  const reachedRoot = at.length === log.length && log.length <= cap && (!last || last.parents.length === 0);
  const decided = Math.min(cap, reachedRoot ? at.length : at.length - 1);
  const commits = log.slice(0, Math.max(0, decided)).filter((_, i) => i + 1 < at.length ? at[i] !== at[i + 1] : at[i] !== null);
  return { commits, complete: reachedRoot };
}

const OVER_BUDGET = new Error("history read budget reached");
const UNKNOWN = Symbol("unknown");

// The hash at a path without listing the final directory, as history needs.
async function locate(r: Reader, root: string, path: string[]): Promise<string | null> {
  let hash = root;
  for (let i = 0; i < path.length; i++) {
    const e = (await r.tree(hash))?.find((x) => x.name === path[i]);
    if (!e) return null;
    // The mode is part of what changed: an executable bit, or a file turned
    // into a symbolic link, is a change even when the bytes are the same.
    if (i === path.length - 1) return `${e.mode} ${e.hash}`;
    if (e.type !== "tree") return null;
    hash = e.hash;
  }
  return hash;
}

export type { FileChange };
