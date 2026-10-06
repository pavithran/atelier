// An Artifacts tree as a tar stream, for unpacking inside the check container.
import type { Reader } from "../diff.ts";
import type { Patch } from "../preview/merge.ts";
import { entryBytes, type TarEntry } from "./tar.ts";

const MODES: Record<string, number> = { blob: 0o644, exec: 0o755, symlink: 0o777 };

// Stream a tree as tar, depth first, reading each directory's blobs together.
// A patch lays changes over the tree by path, for a merged check: an entry
// replaces or adds the file at its path, null removes it, and a path whose
// folder the tree lacks makes that folder. The tree may be null for a folder
// only the patch holds.
export async function writeTree(r: Reader, tree: string | null, write: (b: Uint8Array) => Promise<void>, prefix = "", patch?: Map<string, Patch | null>): Promise<number> {
  const entries = tree === null ? [] : await r.tree(tree);
  if (!entries) throw new Error(`tree ${tree} not found`);
  // The patch's paths under this folder: its own files, and the folders they
  // lie in, which are made here when the tree has none.
  const own = new Map<string, Patch | null>();
  const folders = new Set<string>();
  for (const [path, change] of patch ?? []) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) own.set(rest, change);
    else folders.add(rest.slice(0, slash));
  }
  let files = 0;
  const kept = entries.filter((e) => (e.type === "blob" || e.type === "exec" || e.type === "symlink") && !own.has(e.name));
  const added = [...own].filter((x): x is [string, Patch] => x[1] !== null).map(([name, p]) => ({ name, type: p.type, hash: p.hash, data: p.data }));
  const leaves = [...kept.map((e) => ({ name: e.name, type: e.type, hash: e.hash as string | undefined, data: undefined as Uint8Array | undefined })), ...added];
  const data = await Promise.all(leaves.map((e) => (e.data ? Promise.resolve(e.data) : r.blob(e.hash!))));
  for (let i = 0; i < leaves.length; i++) {
    const e = leaves[i], bytes = data[i];
    if (!bytes) throw new Error(`blob ${e.hash} for ${prefix}${e.name} not found`);
    const entry: TarEntry = e.type === "symlink"
      ? { path: prefix + e.name, mode: MODES.symlink, kind: "symlink", target: new TextDecoder().decode(bytes) }
      : { path: prefix + e.name, mode: MODES[e.type], kind: "file", data: bytes };
    for (const chunk of entryBytes(entry)) if (chunk.length) await write(chunk);
    files++;
  }
  for (const e of entries.filter((x) => x.type === "tree")) {
    folders.delete(e.name);
    files += await writeTree(r, e.hash, write, `${prefix}${e.name}/`, patch);
  }
  for (const name of folders) files += await writeTree(r, null, write, `${prefix}${name}/`, patch);
  return files;
}
