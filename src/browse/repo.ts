// Reading a repository for people: a directory, a file, the log, one commit's
// changes, and the commits that changed a path. Everything goes through the
// Artifacts binding's reads (log, readCommit, readTree, readBlob); nothing
// here writes. The functions take a small interface rather than the binding,
// so the tests drive them with plain objects.

import { treeDiff, type FileChange, type Reader } from "../diff.ts";

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
}

export function repoSource(repo: ArtifactsRepo): Source {
  return {
    tree: (h) => repo.readTree(h),
    blob: async (h) => {
      const b = await repo.readBlob(h);
      return b ? new Uint8Array(await b.arrayBuffer()) : null;
    },
    log: (o) => repo.log(o),
    commit: (h) => repo.readCommit(h),
  };
}

// A path from a URL: segments without empty parts, "." or "..". Anything else
// is refused rather than normalised, so a link means exactly one path.
export function cleanPath(parts: string[]): string[] | null {
  const out = parts.filter((p) => p !== "");
  return out.some((p) => p === "." || p === ".." || p.includes("\0")) ? null : out;
}

export type Node =
  | { kind: "tree"; hash: string; entries: { name: string; type: string; mode: string; hash: string }[] }
  | { kind: "blob"; hash: string; mode: string }
  | { kind: "other"; hash: string; type: string };

// The object at a path under a root tree, or null when the path does not exist.
export async function walk(r: Reader, rootTree: string, path: string[]): Promise<Node | null> {
  let hash = rootTree;
  for (let i = 0; i < path.length; i++) {
    const entries = await r.tree(hash);
    const entry = entries?.find((x) => x.name === path[i]);
    if (!entry) return null;
    if (i < path.length - 1 && entry.type !== "tree") return null;
    if (i === path.length - 1) {
      if (entry.type === "blob") return { kind: "blob", hash: entry.hash, mode: entry.mode };
      if (entry.type !== "tree") return { kind: "other", hash: entry.hash, type: entry.type };
    }
    hash = entry.hash;
  }
  const entries = (await r.tree(hash)) ?? [];
  // Directories first, then files, each by name, as a reader expects.
  const sorted = [...entries].sort((a, b) => (a.type === "tree" ? 0 : 1) - (b.type === "tree" ? 0 : 1) || a.name.localeCompare(b.name));
  return { kind: "tree", hash, entries: sorted.map(({ name, type, mode, hash }) => ({ name, type, mode, hash })) };
}

export const FILE_LIMIT = 512 * 1024;

export type FileView =
  | { kind: "text"; lines: string[]; bytes: number }
  | { kind: "binary"; bytes: number }
  | { kind: "too-large"; bytes: number };

export function viewFile(bytes: Uint8Array): FileView {
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
export async function commitChanges(s: Source, hash: string): Promise<{ commit: Commit; parent: string | null; files: FileChange[]; truncated: boolean } | null> {
  const commit = await s.commit(hash);
  if (!commit) return null;
  const parentHash = commit.parents[0] ?? null;
  const parent = parentHash ? await s.commit(parentHash) : null;
  const r: Reader = { tree: (h) => (h === EMPTY_TREE ? Promise.resolve([]) : s.tree(h)), blob: s.blob };
  const { files, truncated } = await treeDiff(r, parent?.treeHash ?? EMPTY_TREE, commit.treeHash);
  return { commit, parent: parentHash, files, truncated };
}

// Git's empty tree. A reader asked for it returns no entries, so a root
// commit diffs as every file added.
export const EMPTY_TREE = "4b825dc642cb6eb9a060c54bf8d69288fbee4904";

export const HISTORY_CAP = 200;

// The commits on the first-parent line that changed what is at a path: the
// entry's hash differs from the next older commit's. Trees are read once per
// hash, so directories that did not change cost nothing after the first read.
// At most HISTORY_CAP commits are examined; `complete` says whether that was
// the whole history.
export async function pathHistory(s: Source, ref: string, path: string[], cap = HISTORY_CAP): Promise<{ commits: Commit[]; complete: boolean }> {
  const log = await s.log({ ref, limit: cap + 1 });
  const seen = log.slice(0, cap);
  const trees = new Map<string, Promise<Awaited<ReturnType<Reader["tree"]>>>>();
  const cached: Reader = {
    tree: (h) => {
      if (!trees.has(h)) trees.set(h, s.tree(h));
      return trees.get(h)!;
    },
    blob: s.blob,
  };
  const at = await Promise.all(seen.map(async (c) => (await walk(cached, c.treeHash, path))?.hash ?? null));
  const complete = log.length <= cap;
  const commits = seen.filter((_, i) => {
    const older = i + 1 < seen.length ? at[i + 1] : complete ? null : at[i];
    return at[i] !== older;
  });
  return { commits, complete };
}

export type { FileChange };
