// A stand-in for the two Artifacts repositories a merge of main is read from
// (src/retention.ts): a content-addressed store of trees and blobs and a graph
// of commits, each repository seeing the commits reachable from the head it
// was given. Hashes come from a small mixing function, not node:crypto, so the
// same helper runs in workerd.
import type { Entry } from "../../src/diff.ts";

export type Commit = { hash: string; parents: string[]; treeHash: string; message: string };
export function sha(text: string): string {
  let out = "";
  for (let seed = 0; seed < 5; seed++) {
    let h = 0x811c9dc5 ^ (seed * 0x9e3779b1);
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
    out += (h >>> 0).toString(16).padStart(8, "0");
  }
  return out;
}

export function world() {
  const trees = new Map<string, Entry[]>();
  const blobs = new Map<string, Uint8Array>();
  const commits = new Map<string, Commit>();
  const treeOf = (files: Record<string, string>): string => {
    const dirs = new Map<string, Record<string, string>>();
    const here: Entry[] = [];
    for (const [path, text] of Object.entries(files)) {
      const slash = path.indexOf("/");
      if (slash < 0) {
        const hash = sha(`blob ${text}`);
        blobs.set(hash, new TextEncoder().encode(text));
        here.push({ name: path, mode: "100644", hash, type: "blob" });
      } else dirs.set(path.slice(0, slash), { ...dirs.get(path.slice(0, slash)), [path.slice(slash + 1)]: text });
    }
    for (const [name, inner] of dirs) here.push({ name, mode: "40000", hash: treeOf(inner), type: "tree" });
    here.sort((a, b) => a.name.localeCompare(b.name));
    const hash = sha(`tree ${JSON.stringify(here)}`);
    trees.set(hash, here);
    return hash;
  };
  const commit = (label: string, files: Record<string, string>, parents: string[] = [], message = label): string => {
    const treeHash = treeOf(files);
    const hash = sha(`commit ${label} ${parents.join()} ${treeHash} ${message}`);
    commits.set(hash, { hash, parents, treeHash, message });
    return hash;
  };
  // A repository whose history is every commit reachable from `head`, newest
  // first in breadth order; a commit it was not given is unknown to it.
  const repo = (head: string, fail?: string) => {
    const reachable = (from: string): Commit[] => {
      const out: Commit[] = [], seen = new Set<string>(), queue = [from];
      while (queue.length) {
        const h = queue.shift()!;
        const c = commits.get(h);
        if (!c || seen.has(h)) continue;
        seen.add(h);
        out.push(c);
        queue.push(...c.parents);
      }
      return out;
    };
    const known = new Set(reachable(head).map((c) => c.hash));
    return {
      log: async ({ ref, limit = 50 }: { ref?: string; limit?: number } = {}) => {
        if (fail === "log") throw new Error("Artifacts is down");
        const from = ref ?? head;
        return known.has(from) ? reachable(from).slice(0, Math.min(limit, 1000)) : [];
      },
      readTree: async (h: string) => trees.get(h) ?? null,
      readBlob: async (h: string) => { const b = blobs.get(h); return b ? { arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) } : null; },
    } as unknown as ArtifactsRepo;
  };
  return { commit, repo };
}

