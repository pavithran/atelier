// An Artifacts tree as a tar stream, for unpacking inside the check container.
import type { Reader } from "../diff.ts";
import { entryBytes, type TarEntry } from "./tar.ts";

const MODES: Record<string, number> = { blob: 0o644, exec: 0o755, symlink: 0o777 };

// Stream a tree as tar, depth first, reading each directory's blobs together.
export async function writeTree(r: Reader, tree: string, write: (b: Uint8Array) => Promise<void>, prefix = ""): Promise<number> {
  const entries = await r.tree(tree);
  if (!entries) throw new Error(`tree ${tree} not found`);
  let files = 0;
  const leaves = entries.filter((e) => e.type === "blob" || e.type === "exec" || e.type === "symlink");
  const data = await Promise.all(leaves.map((e) => r.blob(e.hash)));
  for (let i = 0; i < leaves.length; i++) {
    const e = leaves[i], bytes = data[i];
    if (!bytes) throw new Error(`blob ${e.hash} for ${prefix}${e.name} not found`);
    const entry: TarEntry = e.type === "symlink"
      ? { path: prefix + e.name, mode: MODES.symlink, kind: "symlink", target: new TextDecoder().decode(bytes) }
      : { path: prefix + e.name, mode: MODES[e.type], kind: "file", data: bytes };
    for (const chunk of entryBytes(entry)) if (chunk.length) await write(chunk);
    files++;
  }
  for (const e of entries.filter((x) => x.type === "tree")) files += await writeTree(r, e.hash, write, `${prefix}${e.name}/`);
  return files;
}

