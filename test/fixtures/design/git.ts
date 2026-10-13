// An in-memory stand-in for the Artifacts binding, for the design captures
// (t499). The pages read repositories only through log, readCommit, readTree,
// readBlob and info (src/browse/repo.ts, src/diff.ts), so this store answers
// those from content-addressed objects it builds itself: the baseline's main
// line, one commit per merged task, and a fork per task with work on it. A
// repository named in `broken` throws on every read, which is how the task
// page's "unavailable" diff is drawn. Nothing here touches the network.

type Entry = { name: string; mode: string; hash: string; type: "tree" | "blob" };
export interface FakeCommit { hash: string; treeHash: string; message: string; author: { name: string; email: string }; parents: string[]; authoredAt: number }

// A deterministic 40-hex id: FNV-1a over the text, stretched to 160 bits.
export function fakeHash(text: string): string {
  let out = "";
  for (let round = 0; out.length < 40; round++) {
    let h = 0x811c9dc5 ^ round;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    out += h.toString(16).padStart(8, "0");
  }
  return out.slice(0, 40);
}

export class FakeGit {
  readonly blobs = new Map<string, Uint8Array>();
  readonly trees = new Map<string, Entry[]>();
  readonly commits = new Map<string, FakeCommit>();
  // Each repository's head, newest commit first along its first parents.
  readonly heads = new Map<string, string>();
  readonly broken = new Set<string>();

  blob(content: string): string {
    const hash = fakeHash(`blob\0${content}`);
    this.blobs.set(hash, new TextEncoder().encode(content));
    return hash;
  }

  // A tree from a map of paths to file contents.
  tree(files: Map<string, string>): string {
    const here = new Map<string, Map<string, string> | string>();
    for (const [path, content] of files) {
      const [first, ...rest] = path.split("/");
      if (!rest.length) here.set(first, content);
      else {
        const sub = (here.get(first) as Map<string, string> | undefined) ?? new Map<string, string>();
        sub.set(rest.join("/"), content);
        here.set(first, sub);
      }
    }
    const entries: Entry[] = [...here].sort(([a], [b]) => a.localeCompare(b)).map(([name, v]) =>
      typeof v === "string" ? { name, mode: "100644", hash: this.blob(v), type: "blob" } : { name, mode: "40000", hash: this.tree(v), type: "tree" });
    const hash = fakeHash(`tree\0${entries.map((e) => `${e.mode} ${e.name} ${e.hash}`).join("\n")}`);
    this.trees.set(hash, entries);
    return hash;
  }

  commit(repo: string, c: Omit<FakeCommit, "hash">): string {
    const hash = fakeHash(`commit\0${c.treeHash}\0${c.parents.join(",")}\0${c.message}\0${c.authoredAt}`);
    this.commits.set(hash, { ...c, hash });
    this.heads.set(repo, hash);
    return hash;
  }

  log(repo: string, ref?: string): FakeCommit[] {
    const out: FakeCommit[] = [];
    let at = ref && this.commits.has(ref) ? ref : this.heads.get(repo);
    while (at) {
      const c = this.commits.get(at);
      if (!c) break;
      out.push(c);
      at = c.parents[0];
    }
    return out;
  }

  // The binding: get(name) answers a repository handle the pages can read.
  binding(): Artifacts {
    const git = this;
    return {
      get: async (name: string) => {
        if (git.broken.has(name)) throw new Error(`Artifacts read of ${name} failed (design fixture: unavailable)`);
        return {
          info: async () => ({ remote: `https://git.test/${name}.git`, defaultBranch: "main" }),
          createToken: async () => ({ plaintext: "design-token", id: "design", expiresAt: "2026-10-11T12:00:00Z" }),
          log: async (o: { ref?: string; limit?: number; offset?: number } = {}) => {
            const all = git.log(name, o.ref);
            const from = o.offset ?? 0;
            // Artifacts answers each commit's commit time too; here it is the author time.
            return all.slice(from, o.limit === undefined ? undefined : from + o.limit).map((c) => ({ ...c, committedAt: c.authoredAt }));
          },
          readCommit: async (h: string) => git.commits.get(h) ?? null,
          readTree: async (h: string) => git.trees.get(h) ?? null,
          readBlob: async (h: string) => { const b = git.blobs.get(h); return b ? new Blob([b]) : null; },
          [Symbol.dispose]() {},
        };
      },
      create: async () => ({}),
    } as unknown as Artifacts;
  }
}
