import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import type { Evidence, Item } from "../src/rules.ts";

// The push scan over every kind of change a tree can make to a path (t332):
// what the base side was and what the head side became. Each row pushes one
// commit whose tree differs from main's in one path and asserts what the
// scan recorded through the Worker's push route, and whether the gate is
// ready. The scan is fail closed by construction: a head side that is text
// is scanned (its added lines against a text base, or whole), and one that
// is not (binary content, a submodule, an oversized blob) stands as a
// blocking unscanned flag until the owner clears it. The key in each fixture
// is built at runtime from obviously fake parts, and no record ever holds it.
//
// Before this scan read the trees itself, it took the display diff's word
// for each file, and the display diff shows nothing for a file it reads as
// binary or a submodule on either side: the binary→text and submodule→text
// rows passed clean at 89e78e09, with gate.ready true. They are the proof
// this file exists for.

const TOKEN = "secret-transitions-owner";
const A = "claude-code/opus-5.5";
const H0 = "0".repeat(40), H1 = "1".repeat(40);
const T0 = "a".repeat(40), T1 = "b".repeat(40);
const FAKE_KEY = ["sk", "proj", "y".repeat(24)].join("-");
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;

const text = (s: string) => new TextEncoder().encode(s);
const KEYED = text(`export const a = 1;\nexport const key = "${FAKE_KEY}";\n`);
const CLEAN = text("export const a = 1;\n");
const BINARY = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
// Over the scan's blob limit (SCAN_BYTES in src/secret-scan.ts): text the
// scan refuses to decode, and a key behind it that it therefore cannot see.
const OVERSIZED = (() => {
  const b = new Uint8Array(8 * 1024 * 1024 + 64).fill(0x78);
  b.set(text(`\nexport const key = "${FAKE_KEY}";\n`), 8 * 1024 * 1024);
  return b;
})();

// One side of a path: a blob with its mode, a submodule (a commit, nothing to
// read), or absent.
type Side = { bytes: Uint8Array; mode?: string } | { submodule: true } | null;
type Row = {
  name: string;
  base: Record<string, Side>;
  head: Record<string, Side>;
  // What the scan records: a hit at file and line, an unscanned flag naming
  // the file with its reason, or nothing.
  expect: { hit: { file: string; line: number } } | { unscanned: { file: string; reason: RegExp } } | { clean: true };
  ready: boolean;
};

const rows: Row[] = [
  { name: "text→text, key added", base: { "a.ts": { bytes: CLEAN } }, head: { "a.ts": { bytes: KEYED } }, expect: { hit: { file: "a.ts", line: 2 } }, ready: false },
  { name: "text→text, no key pattern", base: { "a.ts": { bytes: CLEAN } }, head: { "a.ts": { bytes: text("export const a = 2;\n") } }, expect: { clean: true }, ready: true },
  { name: "binary→text holding a key", base: { "a.ts": { bytes: BINARY } }, head: { "a.ts": { bytes: KEYED } }, expect: { hit: { file: "a.ts", line: 2 } }, ready: false },
  { name: "submodule→text holding a key", base: { "a.ts": { submodule: true } }, head: { "a.ts": { bytes: KEYED } }, expect: { hit: { file: "a.ts", line: 2 } }, ready: false },
  { name: "text→binary", base: { "a.ts": { bytes: CLEAN } }, head: { "a.ts": { bytes: BINARY } }, expect: { unscanned: { file: "a.ts", reason: /binary content/ } }, ready: false },
  { name: "absent→binary", base: {}, head: { "logo.png": { bytes: BINARY } }, expect: { unscanned: { file: "logo.png", reason: /binary content/ } }, ready: false },
  { name: "text→submodule", base: { "lib": { bytes: CLEAN } }, head: { "lib": { submodule: true } }, expect: { unscanned: { file: "lib", reason: /submodule/ } }, ready: false },
  { name: "symlink added, its target scanned as text", base: {}, head: { "link": { bytes: text(`../${FAKE_KEY}`), mode: "120000" } }, expect: { hit: { file: "link", line: 1 } }, ready: false },
  { name: "symlink→text holding a key", base: { "a.ts": { bytes: text("target"), mode: "120000" } }, head: { "a.ts": { bytes: KEYED } }, expect: { hit: { file: "a.ts", line: 2 } }, ready: false },
  { name: "absent→text holding a key", base: {}, head: { "a.ts": { bytes: KEYED } }, expect: { hit: { file: "a.ts", line: 2 } }, ready: false },
  { name: "text→absent", base: { "a.ts": { bytes: KEYED } }, head: {}, expect: { clean: true }, ready: true },
  { name: "mode-only change of a file main already holds", base: { "a.ts": { bytes: KEYED } }, head: { "a.ts": { bytes: KEYED, mode: "100755" } }, expect: { clean: true }, ready: true },
  { name: "rename with an edit that adds a key", base: { "a.ts": { bytes: CLEAN } }, head: { "b.ts": { bytes: KEYED } }, expect: { hit: { file: "b.ts", line: 2 } }, ready: false },
  { name: "oversized text", base: { "a.ts": { bytes: CLEAN } }, head: { "a.ts": { bytes: OVERSIZED } }, expect: { unscanned: { file: "a.ts", reason: /bytes, over the/ } }, ready: false },
  { name: "oversized→text holding a key, scanned whole", base: { "a.ts": { bytes: OVERSIZED } }, head: { "a.ts": { bytes: KEYED } }, expect: { hit: { file: "a.ts", line: 2 } }, ready: false },
  { name: "text→text in a subdirectory", base: { "src/a.ts": { bytes: CLEAN } }, head: { "src/a.ts": { bytes: KEYED } }, expect: { hit: { file: "src/a.ts", line: 2 } }, ready: false },
];

// A content-addressed store behind the Artifacts binding: the baseline at H0
// with tree T0 (`base`), the fork at H1 on H0 with tree T1 (`head`). Paths
// with directories become subtrees. A missing hash answers null, as the real
// binding does.
function fakeArtifacts(name: string, base: Record<string, Side>, head: Record<string, Side>, missing = new Set<string>()) {
  const trees = new Map<string, { name: string; mode: string; hash: string; type: string }[]>();
  const blobs = new Map<string, Uint8Array>();
  let n = 0;
  const hashOf = (bytes: Uint8Array) => {
    // Content addressed: equal bytes name one object, so a mode-only change
    // keeps its hash.
    for (const [h, b] of blobs) if (b.length === bytes.length && b.every((x, i) => x === bytes[i])) return h;
    const h = `blob${n++}`.padEnd(40, "0");
    blobs.set(h, bytes);
    return h;
  };
  const build = (entries: Record<string, Side>, hash: string): string => {
    const dirs = new Map<string, Record<string, Side>>();
    const out: { name: string; mode: string; hash: string; type: string }[] = [];
    for (const [path, side] of Object.entries(entries)) {
      const slash = path.indexOf("/");
      if (slash >= 0) {
        const dir = path.slice(0, slash);
        dirs.set(dir, { ...(dirs.get(dir) ?? {}), [path.slice(slash + 1)]: side });
        continue;
      }
      if (!side) continue;
      if ("submodule" in side) out.push({ name: path, mode: "160000", hash: "c".repeat(40), type: "commit" });
      else out.push({ name: path, mode: side.mode ?? "100644", hash: hashOf(side.bytes), type: "blob" });
    }
    for (const [dir, inner] of dirs) out.push({ name: dir, mode: "40000", hash: build(inner, `tree${n++}`.padEnd(40, "0")), type: "tree" });
    trees.set(hash, out);
    return hash;
  };
  build(base, T0);
  build(head, T1);
  const commits = {
    [H0]: { hash: H0, parents: [], treeHash: T0 },
    [H1]: { hash: H1, parents: [H0], treeHash: T1 },
  } as Record<string, { hash: string; parents: string[]; treeHash: string }>;
  const binding = {
    get: async (repo: string) => ({
      info: async () => ({ remote: `https://git.test/${repo}.git`, defaultBranch: "main" }),
      log: async ({ ref, limit }: { ref?: string; limit?: number } = {}) => {
        const from = repo === name ? H0 : ref ?? H1;
        const out = [];
        for (let h: string | undefined = from; h && commits[h]; h = commits[h].parents[0]) out.push(commits[h]);
        return out.slice(0, limit ?? 50);
      },
      readCommit: async (h: string) => commits[h] ?? null,
      readTree: async (h: string) => (missing.has(h) ? null : trees.get(h) ?? null),
      readBlob: async (h: string) => (missing.has(h) || !blobs.has(h) ? null : new Blob([blobs.get(h)!])),
      [Symbol.dispose]() {},
    }),
  } as unknown as Artifacts;
  return { binding, blobs };
}

async function setup(name: string) {
  const record = { name, repo: name, policy: { checks: [], protected: [] }, createdAt: new Date().toISOString() };
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.setProject(record as never, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record as never);
  await L.newItem("Change one path", [], "owner");
  await L.claim("t1", A);
  await L.setFork("t1", `${name}--t1`, H0, A);
  return L;
}

const api = (bindings: typeof env) => (method: string, path: string, actor: string, body?: unknown) => worker.fetch(new Request(`https://atelier.test/api${path}`, {
  method, headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": actor, "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
}), bindings);

type Detail = { item: Item; gate: { ready: boolean; blockers: string[] } };

// Push H1 for the row and read the item and its gate back.
async function pushed(row: Row, i: number, missing?: Set<string>) {
  const name = `secret-transition-${i}`;
  const L = await setup(name);
  const { binding, blobs } = fakeArtifacts(name, row.base, row.head, missing);
  const bindings = { ...testEnv, ARTIFACTS: binding } as typeof env;
  const call = api(bindings);
  const res = await call("POST", `/projects/${name}/items/t1/push`, A, { head: H1 });
  expect(res.status).toBe(200);
  const item = (await res.json()) as Item;
  // With its checks observed and the item submitted, only the scan's
  // findings stand between the item and the gate.
  const evidence: Evidence = { itemId: "t1", claim: "npm test", grade: "observed", head: H1, passed: true, by: "owner", at: new Date().toISOString(), changedPaths: Object.keys({ ...row.base, ...row.head }) };
  await L.addEvidence(evidence);
  if (!missing) await L.submit("t1", A);
  const d = (await (await call("GET", `/projects/${name}/items/t1`, "owner")).json()) as Detail;
  const events = await L.events("t1");
  return { item, d, events, blobs, call, name };
}

for (const [i, row] of rows.entries()) {
  it(`${row.name}: ${"hit" in row.expect ? `flags ${row.expect.hit.file}:${row.expect.hit.line}` : "unscanned" in row.expect ? `stands unscanned at ${row.expect.unscanned.file}` : "records no flag"}, gate ${row.ready ? "ready" : "refused"}`, async () => {
    const { item, d, events } = await pushed(row, i);
    // The scan completed for this head: nothing is pending.
    expect(item.head).toBe(H1);
    expect(item.secretScan).toBeUndefined();
    const standing = (item.secret ?? []).filter((f) => f.head === H1 && !f.cleared);
    if ("hit" in row.expect) {
      expect(standing).toEqual([expect.objectContaining({ file: row.expect.hit.file, line: row.expect.hit.line })]);
      expect(standing[0].unscanned).toBeUndefined();
      expect(d.gate.blockers).toContain(`secret flagged in ${row.expect.hit.file}:${row.expect.hit.line}; clear it with a reason or push a revision that removes the line`);
    } else if ("unscanned" in row.expect) {
      expect(standing).toEqual([expect.objectContaining({ file: row.expect.unscanned.file, line: 0, unscanned: true })]);
      expect(standing[0].reason).toMatch(row.expect.unscanned.reason);
      expect(d.gate.blockers).toContainEqual(expect.stringMatching(new RegExp(`^secret scan could not read ${row.expect.unscanned.file.replace(".", "\\.")} in full \\(`)));
    } else {
      expect(standing).toEqual([]);
      expect(d.gate.blockers.some((b) => b.startsWith("secret"))).toBe(false);
    }
    expect(d.gate.ready).toBe(row.ready);
    // Neither the record nor its events hold the value, whichever row.
    const serialized = JSON.stringify([item, d, events]);
    expect(serialized).not.toContain(FAKE_KEY);
    expect(serialized).not.toContain("sk-proj");
  });
}

it("an unscanned flag is cleared by the owner with a reason, and a changed object at the path blocks again", async () => {
  const row = rows.find((r) => r.name === "text→binary")!;
  const { d, call, name } = await pushed(row, rows.length);
  expect(d.gate.ready).toBe(false);
  const clear = await call("POST", `/projects/${name}/items/t1/clear-secret`, "owner", { reason: "a PNG icon, checked by hand" });
  expect(clear.status).toBe(200);
  const cleared = (await clear.json()) as Item;
  expect(cleared.secret).toMatchObject([{ file: "a.ts", unscanned: true, cleared: true }]);
  expect(cleared.secretClearances).toMatchObject([{ file: "a.ts", reason: "a PNG icon, checked by hand" }]);
  const after = (await (await call("GET", `/projects/${name}/items/t1`, "owner")).json()) as Detail;
  expect(after.gate.ready).toBe(true);
  expect(after.item.secretClearances![0].fingerprint).toBe(cleared.secret![0].fingerprint);
});

it("a head-side object the repositories do not hold leaves the scan pending, so the gate refuses", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const row = rows.find((r) => r.name === "absent→text holding a key")!;
  // The head's only blob is missing from both repositories.
  const { item, d } = await pushed(row, rows.length + 1, new Set(["blob0".padEnd(40, "0")]));
  expect(item).toMatchObject({ head: H1, secretScan: H1 });
  expect(item.secret).toBeUndefined();
  expect(d.gate.ready).toBe(false);
  expect(d.gate.blockers).toContainEqual(expect.stringMatching(/^secret scan pending for 11111111/));
  vi.restoreAllMocks();
});
