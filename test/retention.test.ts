import { test } from "node:test";
import assert from "node:assert/strict";
import { readRetention, regeneratedOutputs } from "../src/retention.ts";
import { retentionVerdict, type RetentionRead } from "../src/rules.ts";
import { MANIFEST_PATH } from "../src/merge-declarations.ts";
import { world } from "./helpers/retention-world.ts";

// The reading of a merge of main into an approved head (src/retention.ts),
// against a stand-in for the two Artifacts repositories: a content-addressed
// store of trees and blobs and a graph of commits, each repository seeing the
// commits it was given heads for. The finding these would have caught is the
// one src/refresh/review.ts named: every merge of main asked a second review,
// and a rule that read only file names, or trusted a path under test/fixtures,
// would have carried an approval over a merge that rewrote what was read.

const FILES = { "src/a.ts": "a\n", "src/b.ts": "b\n", "src/c.ts": "c\n", "test/fixtures/x.txt": "x\n", "docs/readme.md": "r\n" };
const MANIFEST = JSON.stringify({ version: 1, generators: [{ name: "command-indexes", command: ["node", "cli/regenerate.mjs"], inputs: ["src/**"], outputs: ["test/fixtures/help.txt", "test/fixtures/usage.json"] }] });
const generated = (text: string) => ({ "test/fixtures/help.txt": text, "test/fixtures/usage.json": `${text}\n` });
const who = { resolver: null, outsiders: false };

// main: B0 then M (edited by `main`); the task: O off B0 (edited by `task`); the merge: N of O and M.
function merge(opts: { base?: Record<string, string>; main: Record<string, string>; task: Record<string, string>; merged: (b: Record<string, string>, o: Record<string, string>, m: Record<string, string>) => Record<string, string>; message?: string; inMain?: boolean }) {
  const w = world();
  const base = { ...FILES, [MANIFEST_PATH]: MANIFEST, ...generated("help v0"), ...opts.base };
  const b0 = w.commit("b0", base);
  const mainFiles = { ...base, ...opts.main }, taskFiles = { ...base, ...opts.task };
  for (const files of [mainFiles, taskFiles]) for (const [path, text] of Object.entries(files)) if (text === null) delete files[path];
  const m = w.commit("m", mainFiles, [b0]);
  const o = w.commit("o", taskFiles, [b0]);
  const n = w.commit("n", opts.merged(base, taskFiles, mainFiles), [o, m], opts.message ?? "Merge main\n\nAgent: atelier/integrator");
  return { w, b0, m, o, n, fork: w.repo(n), baseline: w.repo(opts.inMain === false ? b0 : m) };
}
const clean = (b: Record<string, string>, o: Record<string, string>, m: Record<string, string>) => {
  const out: Record<string, string> = {};
  for (const path of new Set([...Object.keys(b), ...Object.keys(o), ...Object.keys(m)])) {
    const pick = o[path] === b[path] ? m[path] : m[path] === b[path] ? o[path] : o[path] === m[path] ? o[path] : "CONFLICT";
    assert.notEqual(pick, "CONFLICT", `${path} changed differently on both sides`);
    if (pick !== undefined) out[path] = pick;
  }
  return out;
};
const read = (s: ReturnType<typeof merge>) => readRetention(s.fork, s.baseline, s.o, s.n);
const facts = (r: RetentionRead) => { assert.ok(!("unread" in r), `unread: ${"unread" in r ? r.unread : ""}`); return r; };

test("a merge of main into the approved head that touches none of the task's files is read as disjoint, and kept", async () => {
  const s = merge({ main: { "src/b.ts": "b changed\n", "docs/new.md": "n\n" }, task: { "src/a.ts": "a changed\n", "test/a.test.ts": "t\n" }, merged: clean });
  const r = facts(await read(s));
  assert.deepEqual(r.parents, [s.o, s.m]);
  assert.equal(r.base, s.b0);
  assert.deepEqual(r.task, ["src/a.ts", "test/a.test.ts"]);
  assert.deepEqual(r.incoming, ["docs/new.md", "src/b.ts"]);
  assert.deepEqual(r.moved, ["docs/new.md", "src/b.ts"]);
  assert.equal(retentionVerdict(r, who).retain, true, retentionVerdict(r, who).why);
});

test("main changing a file the task changed asks for review, in the same lines or others", async () => {
  const s = merge({ main: { "src/a.ts": "a\nmain's line\n" }, task: { "src/a.ts": "task's line\na\n" }, merged: () => ({ ...FILES, [MANIFEST_PATH]: MANIFEST, ...generated("help v0"), "src/a.ts": "task's line\na\nmain's line\n" }) });
  const v = retentionVerdict(facts(await read(s)), who);
  assert.equal(v.retain, false);
  assert.match(v.why, /main changed src\/a\.ts, which the task also changes/);
});

test("a rename by the task is an overlap with main's edit of either end, and a deletion by main of a task file likewise", async () => {
  const renamed = merge({ main: { "src/a.ts": "a edited by main\n" }, task: { "src/a.ts": null as unknown as string, "src/a-new.ts": "a\n" }, merged: (_b, o) => ({ ...o, "src/a-new.ts": "a edited by main\n" }) });
  // The merge here follows the rename; either way the paths overlap before the result is looked at.
  const rv = retentionVerdict(facts(await read(renamed)), who);
  assert.equal(rv.retain, false);
  assert.match(rv.why, /main changed src\/a\.ts/);
  const deleted = merge({ main: { "src/c.ts": null as unknown as string }, task: { "src/c.ts": "c edited\n" }, merged: (_b, o) => o });
  assert.match(retentionVerdict(facts(await read(deleted)), who).why, /main changed src\/c\.ts/);
  const taskDeleted = merge({ main: { "src/c.ts": "c edited by main\n" }, task: { "src/c.ts": null as unknown as string }, merged: (_b, _o, m) => m });
  assert.match(retentionVerdict(facts(await read(taskDeleted)), who).why, /main changed src\/c\.ts/);
});

test("a merge whose result is not exactly main's changes beside the task's is not kept", async () => {
  const extra = merge({ main: { "src/b.ts": "b changed\n" }, task: { "src/a.ts": "a changed\n" }, merged: (b, o, m) => ({ ...clean(b, o, m), "src/sneaked.ts": "x\n" }) });
  const e = retentionVerdict(facts(await read(extra)), who);
  assert.match(e.why, /the merge changed src\/sneaked\.ts, which main did not/);
  const edited = merge({ main: { "src/b.ts": "b changed\n" }, task: { "src/a.ts": "a changed\n" }, merged: (b, o, m) => ({ ...clean(b, o, m), "src/b.ts": "b edited by the merger\n" }) });
  assert.match(retentionVerdict(facts(await read(edited)), who).why, /did not take main's content of src\/b\.ts/);
  const dropped = merge({ main: { "src/b.ts": "b changed\n" }, task: { "src/a.ts": "a changed\n" }, merged: (_b, o) => o });
  assert.match(retentionVerdict(facts(await read(dropped)), who).why, /did not take main's content of src\/b\.ts/);
});

test("a regenerated declared output is exempt only with the merge's provenance; a fixture path alone earns nothing", async () => {
  const both = { main: { "src/b.ts": "b changed\n", ...generated("help v1") }, task: { "src/a.ts": "a changed\n", ...generated("help v2") } };
  const merged = (b: Record<string, string>, o: Record<string, string>, m: Record<string, string>) => ({ ...clean(b, { ...o, ...generated("help v0") }, { ...m, ...generated("help v0") }), ...generated("help v3") });
  const line = "Atelier-Regenerated: command-indexes (node cli/regenerate.mjs): test/fixtures/help.txt matches neither side; test/fixtures/usage.json matches neither side; log sha256 abc";
  const proven = merge({ ...both, merged, message: `Merge main\n\n${line}\nAgent: atelier/integrator` });
  const r = facts(await read(proven));
  assert.deepEqual(r.outputs, ["test/fixtures/help.txt", "test/fixtures/usage.json"]);
  assert.equal(retentionVerdict(r, who).retain, true, retentionVerdict(r, who).why);
  // The same merge with no provenance line, or one for a command the manifest does not declare, is an overlap.
  for (const message of ["Merge main\n\nAgent: atelier/integrator", `Merge main\n\n${line.replace("regenerate.mjs", "other.mjs")}\nAgent: atelier/integrator`]) {
    const unproven = merge({ ...both, merged, message });
    const u = facts(await read(unproven));
    assert.deepEqual(u.outputs, []);
    assert.match(retentionVerdict(u, who).why, /main changed test\/fixtures\/help\.txt/);
  }
  // Fixtures not in the manifest earn nothing, with or without the line.
  const fixtures = merge({ main: { "test/fixtures/x.txt": "main's\n" }, task: { "test/fixtures/x.txt": "task's\n" }, merged: () => ({ ...FILES, [MANIFEST_PATH]: MANIFEST, ...generated("help v0"), "test/fixtures/x.txt": "both\n" }), message: `Merge main\n\n${line}\nAgent: atelier/integrator` });
  assert.match(retentionVerdict(facts(await read(fixtures)), who).why, /main changed test\/fixtures\/x\.txt/);
});

test("a manifest main does not hold, or one that does not parse, exempts nothing", async () => {
  const w = world();
  const line = "Atelier-Regenerated: command-indexes (node cli/regenerate.mjs): test/fixtures/help.txt matches neither side; log sha256 abc";
  const none = w.commit("none", { "src/a.ts": "a\n" });
  const bad = w.commit("bad", { [MANIFEST_PATH]: "{ not json" });
  const dir = w.commit("dir", { [`${MANIFEST_PATH}/x`]: "x" });
  const repo = w.repo(none);
  for (const tree of [none, bad, dir]) {
    const treeHash = (await w.repo(tree).log({}))[0].treeHash;
    assert.deepEqual(await regeneratedOutputs({ tree: (h) => repo.readTree(h), blob: async (h) => { const b = await repo.readBlob(h); return b ? new Uint8Array(await b.arrayBuffer()) : null; } }, treeHash, line), []);
  }
});

test("a head that is not a merge of the approved head and a commit of main is read with its parents, and carries nothing", async () => {
  const s = merge({ main: { "src/b.ts": "b changed\n" }, task: { "src/a.ts": "a changed\n" }, merged: clean });
  const plain = await readRetention(s.fork, s.baseline, s.b0, s.n);
  assert.deepEqual(facts(plain).parents, [s.o, s.m]);
  const v = retentionVerdict(plain, who);
  assert.match(v.why, /not a merge of main into the approved head/);
  const single = world();
  const c0 = single.commit("c0", FILES), c1 = single.commit("c1", { ...FILES, "src/a.ts": "changed\n" }, [c0]);
  const one = await readRetention(single.repo(c1), single.repo(c0), c0, c1);
  assert.match(retentionVerdict(one, who).why, /not a merge of main into the approved head/);
});

test("evidence that cannot be read asks for review: a second parent not on main, a failing repository, no common commit", async () => {
  const offMain = merge({ main: { "src/b.ts": "b changed\n" }, task: { "src/a.ts": "a changed\n" }, merged: clean, inMain: false });
  const a = await read(offMain);
  assert.ok("unread" in a && /main's commit is not in the baseline/.test(a.unread), JSON.stringify(a));
  assert.match(retentionVerdict(a, who).why, /could not be read/);
  const s = merge({ main: { "src/b.ts": "b changed\n" }, task: { "src/a.ts": "a changed\n" }, merged: clean });
  const down = await readRetention(s.w.repo(s.n, "log"), s.baseline, s.o, s.n);
  assert.ok("unread" in down && /Artifacts is down/.test(down.unread));
  // A new head the fork does not hold at all.
  const missing = await readRetention(s.fork, s.baseline, s.o, "f".repeat(40));
  assert.ok("unread" in missing && /commit could not be read/.test(missing.unread));
  // A task whose history shares no commit with main's.
  const w = world();
  const x = w.commit("x", FILES), y = w.commit("y", { ...FILES, "src/a.ts": "y\n" }), m = w.commit("m", { ...FILES, "src/b.ts": "m\n" });
  const o = w.commit("o", { ...FILES, "src/a.ts": "o\n" }, [x]), n = w.commit("n", { ...FILES, "src/a.ts": "o\n", "src/b.ts": "m\n" }, [o, m]);
  void y;
  const nobase = await readRetention(w.repo(n), w.repo(m), o, n);
  assert.ok("unread" in nobase && /no commit of main's history is held/.test(nobase.unread), JSON.stringify(nobase));
  // Past the cap of changed paths the lists are not read.
  const big = world();
  const many = Object.fromEntries(Array.from({ length: 5001 }, (_, i) => [`gen/f${i}.txt`, "x"]));
  const b0 = big.commit("b0", FILES), m1 = big.commit("m1", { ...FILES, ...many }, [b0]), o1 = big.commit("o1", { ...FILES, "src/a.ts": "t\n" }, [b0]);
  const n1 = big.commit("n1", { ...FILES, ...many, "src/a.ts": "t\n" }, [o1, m1]);
  const huge = await readRetention(big.repo(n1), big.repo(m1), o1, n1);
  assert.ok("unread" in huge && /more than 5000 changed paths/.test(huge.unread), JSON.stringify(huge));
});
