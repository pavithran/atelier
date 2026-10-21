import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { MANIFEST_PATH, mergeRecords, parseManifest } from "../cli/merge-driver.mjs";
import { atelierGitDir, describeConflicts, indexBeyond, installMergeConfig, mergeConfigProblems, mergeThrough, previewMerge, stableNode, verifyAccepted, withProvenance } from "../cli/merge-pipeline.mjs";
import { conflictsSection, pipelineMerge } from "../cli/runner.mjs";

// t463: generated outputs and record files merge through one pipeline. The
// fixture is a project whose command entries live one per file under
// cmds/, whose generator writes out/index.txt from them, and whose
// routes.tsv is a record file keyed by its first word.

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
const gitFails = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8" });

// The generator: one line per command entry, from each entry's name line,
// sorted. It depends on the entries' names only, so editing an entry's
// description leaves the output's bytes as they were.
const GENERATOR = `import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
const names = readdirSync("cmds").sort().map((f) => /^name: (\\S+)/m.exec(readFileSync("cmds/" + f, "utf8"))[1]);
mkdirSync("out", { recursive: true });
writeFileSync("out/index.txt", names.map((n) => n + "\\n").join(""));
`;
const MANIFEST = {
  version: 1,
  generators: [{ name: "index", command: [process.execPath, "gen.mjs"], inputs: ["cmds/**", "gen.mjs"], outputs: ["out/index.txt"] }],
  records: [{ path: "routes.tsv", key: "^(\\S+)\\t" }],
  registries: [{ name: "commands", dir: "cmds", key: "^name: (\\S+)" }],
};
const ATTRIBUTES = "out/index.txt merge=atelier-generated\nroutes.tsv merge=atelier-records\n";

function write(dir, files) {
  for (const [path, text] of Object.entries(files)) {
    if (text === null) { unlinkSync(join(dir, path)); continue; }
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}
const regen = (dir) => { const r = spawnSync(process.execPath, ["gen.mjs"], { cwd: dir }); assert.equal(r.status, 0, String(r.stderr)); };
function commit(dir, files, message, { regenerate = true } = {}) {
  write(dir, files);
  if (regenerate) regen(dir);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

// A repository at a base commit with branch `theirs` checked out from it:
// the test commits each side, checks out main and merges theirs.
function fixture(t, { manifest = MANIFEST, attributes = ATTRIBUTES, extra = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "atelier-merge-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "repo");
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "t"); git(dir, "config", "user.email", "t@x"); git(dir, "config", "commit.gpgsign", "false");
  commit(dir, {
    "gen.mjs": GENERATOR, [MANIFEST_PATH]: JSON.stringify(manifest, null, 2), ".gitattributes": attributes,
    "cmds/help.txt": "name: help\ndescription: help\n", "routes.tsv": "/a\tA\n/b\tB\n", ...extra,
  }, "base");
  return { root, dir };
}
// Both sides branch from the base: theirs first, then main.
function sides(f, theirs, ours, opts = {}) {
  const base = git(f.dir, "rev-parse", "main");
  git(f.dir, "checkout", "-q", "-b", "theirs", base);
  const t = commit(f.dir, theirs, "theirs", opts.theirs);
  git(f.dir, "checkout", "-q", "main");
  const o = commit(f.dir, ours, "ours", opts.ours);
  return { base, ours: o, theirs: t };
}
const counting = () => {
  const calls = [];
  const run = (argv, { cwd, env }) => { calls.push(argv); const r = spawnSync(argv[0], argv.slice(1), { cwd, env, encoding: "utf8" }); return Promise.resolve({ status: r.status, stdout: r.stdout, stderr: r.stderr, error: r.error }); };
  return { run, calls };
};
const merging = (dir) => existsSync(join(dir, ".git", "MERGE_HEAD"));

test("independent command additions merge: the conflicting generated index is regenerated from both sides' entries", async (t) => {
  const f = fixture(t);
  const s = sides(f, { "cmds/push.txt": "name: push\n" }, { "cmds/land.txt": "name: land\n" });
  // A plain text merge of the index would conflict: each side added a line at one place.
  const preview = previewMerge(f.dir, "HEAD", "theirs");
  assert.deepEqual({ source: preview.source, generated: preview.generated, clean: preview.clean, regenerate: preview.regenerate }, { source: [], generated: ["out/index.txt"], clean: true, regenerate: ["index"] });
  const { run, calls } = counting();
  const r = await mergeThrough(f.dir, "theirs", { message: "Merge theirs\n\nAgent: test/model", run });
  assert.equal(r.state, "merged", JSON.stringify(r));
  assert.equal(calls.length, 2, "the generator runs twice, the second time proving it idempotent");
  assert.equal(readFileSync(join(f.dir, "out/index.txt"), "utf8"), "help\nland\npush\n");
  assert.equal(git(f.dir, "status", "--porcelain"), "");
  assert.deepEqual(git(f.dir, "rev-list", "--parents", "-n", "1", "HEAD").split(" ").slice(1), [s.ours, s.theirs]);
  // Provenance: in the commit, ahead of the closing Agent line, and the log kept.
  const message = git(f.dir, "log", "-1", "--format=%B");
  assert.match(message, /Atelier-Regenerated: index \(.+ gen\.mjs\): out\/index\.txt matches neither side; log sha256 [0-9a-f]{64}\nAgent: test\/model$/);
  assert.ok(existsSync(r.regenerated[0].log));
  assert.match(readFileSync(r.regenerated[0].log, "utf8"), /--- run 1: exit 0[\s\S]*--- run 2: exit 0/);
});

test("duplicate registry keys stop the merge before anything is generated", async (t) => {
  const f = fixture(t);
  sides(f, { "cmds/push.txt": "name: ship\n" }, { "cmds/ship.txt": "name: ship\n" });
  const { run, calls } = counting();
  const r = await mergeThrough(f.dir, "theirs", { message: "m", run });
  assert.equal(r.state, "conflicts");
  assert.deepEqual(r.problems, ["the commands registry key ship is declared by both cmds/push.txt and cmds/ship.txt"]);
  assert.equal(calls.length, 0);
  assert.equal(merging(f.dir), false, "the merge is aborted unless asked to leave it");
  assert.equal(previewMerge(f.dir, "HEAD", "theirs").clean, false);
});

test("records: independent additions unite by key; a key added twice, an edit against a deletion and conflicting edits need resolving", async (t) => {
  const key = /^(\S+)\t/;
  const base = "/a\tA\n/b\tB\n";
  assert.deepEqual(mergeRecords(base, "/a\tA\n/b\tB\n/c\tC\n", "/0\tZ\n/a\tA\n/b\tB\n", key), { text: "/0\tZ\n/a\tA\n/b\tB\n/c\tC\n", conflicts: [], problems: [] });
  // The same either way round.
  assert.equal(mergeRecords(base, "/0\tZ\n/a\tA\n/b\tB\n", "/a\tA\n/b\tB\n/c\tC\n", key).text, "/0\tZ\n/a\tA\n/b\tB\n/c\tC\n");
  // A one-sided deletion and a one-sided edit apply.
  assert.deepEqual(mergeRecords(base, "/a\tA\n", "/a\tA\n/b\tB2\n", key).conflicts, ["/b: deleted on one side and edited on the other"]);
  assert.deepEqual(mergeRecords(base, "/a\tA\n", "/a\tA2\n/b\tB\n", key), { text: "/a\tA2\n", conflicts: [], problems: [] });
  assert.deepEqual(mergeRecords(base, base + "/c\tC1\n", base + "/c\tC2\n", key).conflicts, ["/c: added by both sides with different records"]);
  assert.deepEqual(mergeRecords(base, "/a\tA1\n/b\tB\n", "/a\tA2\n/b\tB\n", key).conflicts, ["/a: edited differently on both sides"]);
  assert.deepEqual(mergeRecords(base, base + "/a\tAgain\n", base, key).problems, ["ours: the key /a appears twice (lines 1 and 3)"]);

  const f = fixture(t);
  sides(f, { "routes.tsv": "/a\tA\n/b\tB\n/c\tC\n" }, { "routes.tsv": "/0\tZ\n/a\tA\n/b\tB\n" });
  const r = await mergeThrough(f.dir, "theirs", { message: "m" });
  assert.equal(r.state, "merged", JSON.stringify(r));
  assert.equal(readFileSync(join(f.dir, "routes.tsv"), "utf8"), "/0\tZ\n/a\tA\n/b\tB\n/c\tC\n");
  assert.match(git(f.dir, "log", "-1", "--format=%B"), /Atelier-Records-Merged: routes\.tsv, united by key/);
});

// A framed record file: one-line entries between a fixed header and
// footer, as src/capability-declarations.ts holds its capabilities.
const CAPS_KEY = /^  \{ name: "([^"]+)",/;
const caps = (...names) => `// header\nexport const CAPS = [\n${names.map((n) => `  { name: "${n}", summary: "${n}" },\n`).join("")}] as const;\n`;

test("framed records: independent additions unite between the unchanged frame in either order; duplicate, conflicting and deleted-against-edited keys need resolving", async (t) => {
  const base = caps("b.one.v1", "a.two.v1");
  const merged = mergeRecords(base, caps("b.one.v1", "a.two.v1", "z.ours.v1"), caps("b.one.v1", "a.two.v1", "c.theirs.v1"), CAPS_KEY, true);
  // The base keeps its order; the additions follow it, in key order.
  assert.deepEqual(merged, { text: caps("b.one.v1", "a.two.v1", "c.theirs.v1", "z.ours.v1"), conflicts: [], problems: [] });
  assert.equal(mergeRecords(base, caps("b.one.v1", "a.two.v1", "c.theirs.v1"), caps("b.one.v1", "a.two.v1", "z.ours.v1"), CAPS_KEY, true).text, merged.text);
  // One side's change to the frame is taken; both changing it differently is a conflict.
  const renamed = (text) => text.replace("CAPS =", "CAPABILITIES =");
  assert.equal(mergeRecords(base, renamed(base), caps("b.one.v1", "a.two.v1", "c.new.v1"), CAPS_KEY, true).text, renamed(caps("b.one.v1", "a.two.v1", "c.new.v1")));
  assert.deepEqual(mergeRecords(base, renamed(base), base.replace("CAPS =", "OTHER ="), CAPS_KEY, true).conflicts, ["the frame's opening lines: edited differently on both sides"]);
  assert.deepEqual(mergeRecords(base, caps("b.one.v1", "a.two.v1", "c.x.v1"), base.replace("] as const;\n", '  { name: "c.x.v1", summary: "other" },\n] as const;\n'), CAPS_KEY, true).conflicts, ["c.x.v1: added by both sides with different records"]);
  assert.deepEqual(mergeRecords(base, caps("b.one.v1"), base.replace('summary: "a.two.v1"', 'summary: "edited"'), CAPS_KEY, true).conflicts, ["a.two.v1: deleted on one side and edited on the other"]);
  assert.deepEqual(mergeRecords(base, caps("b.one.v1", "a.two.v1", "b.one.v1"), base, CAPS_KEY, true).problems, ["ours: the key b.one.v1 appears twice (lines 3 and 5)"]);
  assert.deepEqual(mergeRecords(base, base.replace("] as const;\n", '] as const;\n  { name: "late.one.v1", summary: "x" },\n'), base, CAPS_KEY, true).problems, ["ours: line 6 is a record after the frame's closing lines"]);

  // Through Git: the records driver unites a TypeScript file declared framed.
  const manifest = { ...MANIFEST, records: [...MANIFEST.records, { path: "caps.ts", framed: true, key: CAPS_KEY.source }] };
  const f = fixture(t, { manifest, attributes: `${ATTRIBUTES}caps.ts merge=atelier-records\n`, extra: { "caps.ts": base } });
  sides(f, { "caps.ts": caps("b.one.v1", "a.two.v1", "c.theirs.v1") }, { "caps.ts": caps("b.one.v1", "a.two.v1", "z.ours.v1") });
  const r = await mergeThrough(f.dir, "theirs", { message: "m" });
  assert.equal(r.state, "merged", JSON.stringify(r));
  assert.equal(readFileSync(join(f.dir, "caps.ts"), "utf8"), merged.text);
  assert.match(git(f.dir, "log", "-1", "--format=%B"), /Atelier-Records-Merged: caps\.ts, united by key/);
});

test("framed records: a side emptied of every record keeps the frame whole, and the other side's addition lands between its lines", async (t) => {
  // base [a], ours [], theirs [a, b]: ours deleted a, theirs added b.
  const emptied = mergeRecords(caps("a.one.v1"), caps(), caps("a.one.v1", "b.two.v1"), CAPS_KEY, true);
  assert.deepEqual(emptied, { text: caps("b.two.v1"), conflicts: [], problems: [] });
  assert.equal(mergeRecords(caps("a.one.v1"), caps("a.one.v1", "b.two.v1"), caps(), CAPS_KEY, true).text, caps("b.two.v1"));
  // Both sides emptied, and an empty base whose frame one side renamed.
  assert.deepEqual(mergeRecords(caps("a.one.v1"), caps(), caps(), CAPS_KEY, true), { text: caps(), conflicts: [], problems: [] });
  assert.equal(mergeRecords(caps(), caps("a.one.v1"), caps().replace("CAPS =", "OTHER ="), CAPS_KEY, true).text, caps("a.one.v1").replace("CAPS =", "OTHER ="));
  // An emptied side whose frame matches no other side's is not guessed at.
  assert.deepEqual(mergeRecords(caps("a.one.v1"), "// new\n];\n", caps("a.one.v1", "b.two.v1"), CAPS_KEY, true).problems, ["ours: it holds no records, and its frame cannot be told apart into the opening and closing lines the other sides hold"]);

  // Through Git, as the reviewer found it.
  const manifest = { ...MANIFEST, records: [{ path: "caps.ts", framed: true, key: CAPS_KEY.source }] };
  const f = fixture(t, { manifest, attributes: "out/index.txt merge=atelier-generated\ncaps.ts merge=atelier-records\n", extra: { "caps.ts": caps("a.one.v1") } });
  sides(f, { "caps.ts": caps("a.one.v1", "b.two.v1") }, { "caps.ts": caps() });
  const r = await mergeThrough(f.dir, "theirs", { message: "m" });
  assert.equal(r.state, "merged", JSON.stringify(r));
  assert.equal(readFileSync(join(f.dir, "caps.ts"), "utf8"), caps("b.two.v1"));
});

test("framed records: a name both sides add differently stops the merge for resolution", async (t) => {
  const manifest = { ...MANIFEST, records: [{ path: "caps.ts", framed: true, key: CAPS_KEY.source }] };
  const f = fixture(t, { manifest, attributes: "out/index.txt merge=atelier-generated\ncaps.ts merge=atelier-records\n", extra: { "caps.ts": caps("a.one.v1") } });
  sides(f, { "caps.ts": caps("a.one.v1").replace("] as const;", '  { name: "b.new.v1", summary: "theirs" },\n] as const;') }, { "caps.ts": caps("a.one.v1", "b.new.v1") });
  const r = await mergeThrough(f.dir, "theirs", { message: "m", leave: true });
  assert.equal(r.state, "conflicts");
  assert.deepEqual(r.records, ["caps.ts"]);
  assert.match(readFileSync(join(f.dir, "caps.ts"), "utf8"), /^<{7} ours\n  \{ name: "b\.new\.v1", summary: "b\.new\.v1" \},\n={7}\n.*theirs.*\n>{7} theirs\n\] as const;\n$/m);
});

test("a record key both sides add differently is a conflict left for resolution", async (t) => {
  const f = fixture(t);
  sides(f, { "routes.tsv": "/a\tA\n/b\tB\n/c\ttheirs\n" }, { "routes.tsv": "/a\tA\n/b\tB\n/c\tours\n" });
  const r = await mergeThrough(f.dir, "theirs", { message: "m", leave: true });
  assert.equal(r.state, "conflicts");
  assert.deepEqual(r.records, ["routes.tsv"]);
  assert.ok(merging(f.dir));
  assert.match(readFileSync(join(f.dir, "routes.tsv"), "utf8"), /<<<<<<< ours\n\/c\tours\n=======\n\/c\ttheirs\n>>>>>>> theirs/);
});

test("deletions: a record deleted on one side and edited on the other stops; a command deleted on one side is gone from the regenerated index", async (t) => {
  const f = fixture(t);
  sides(f, { "routes.tsv": "/a\tA\n" }, { "routes.tsv": "/a\tA\n/b\tB-edited\n" });
  const r = await mergeThrough(f.dir, "theirs", { message: "m" });
  assert.equal(r.state, "conflicts");
  assert.deepEqual(r.records, ["routes.tsv"]);
  assert.equal(merging(f.dir), false);

  const g = fixture(t, { extra: { "cmds/old.txt": "name: old\n" } });
  sides(g, { "cmds/old.txt": null }, { "cmds/new.txt": "name: new\n" });
  const m = await mergeThrough(g.dir, "theirs", { message: "m" });
  assert.equal(m.state, "merged", JSON.stringify(m));
  assert.equal(readFileSync(join(g.dir, "out/index.txt"), "utf8"), "help\nnew\n");
});

test("a source conflict stops generation: the output stays unmerged and no generator runs", async (t) => {
  const f = fixture(t);
  sides(f, { "cmds/help.txt": "name: help\ndescription: theirs\n", "cmds/a.txt": "name: a\n" }, { "cmds/help.txt": "name: help\ndescription: ours\n", "cmds/b.txt": "name: b\n" });
  const { run, calls } = counting();
  const r = await mergeThrough(f.dir, "theirs", { message: "m", leave: true, run });
  assert.equal(r.state, "conflicts");
  assert.deepEqual([r.source, r.generated], [["cmds/help.txt"], ["out/index.txt"]]);
  assert.equal(calls.length, 0);
  // The output is not made to look resolved: it is still unmerged in the index.
  assert.deepEqual(git(f.dir, "diff", "--name-only", "--diff-filter=U").split("\n").sort(), ["cmds/help.txt", "out/index.txt"]);
  const text = describeConflicts(r, r.manifest);
  assert.match(text, /Source conflicts to resolve:\n  cmds\/help\.txt/);
  assert.match(text, /Regenerable outputs, not to be edited by hand[^\n]*\n  out\/index\.txt \(.+ gen\.mjs\)/);
  // The preview says the same without touching the merge in progress.
  git(f.dir, "merge", "--abort");
  const preview = previewMerge(f.dir, "HEAD", "theirs");
  assert.deepEqual([preview.source, preview.generated, preview.clean], [["cmds/help.txt"], ["out/index.txt"], false]);
});

test("generated bytes both sides left unchanged are valid: regeneration matching a side merges", async (t) => {
  const f = fixture(t, { extra: { "cmds/a.txt": "name: a\ndescription: one\n" } });
  sides(f, { "cmds/a.txt": "name: a\ndescription: two\n" }, { "cmds/help.txt": "name: help\ndescription: three\n" });
  const r = await mergeThrough(f.dir, "theirs", { message: "m" });
  assert.equal(r.state, "merged", JSON.stringify(r));
  assert.deepEqual(r.regenerated[0].outputs, [{ path: "out/index.txt", matches: "ours" }]);
  assert.equal(git(f.dir, "diff", "HEAD^1", "HEAD", "--", "out/index.txt"), "");
});

test("a generator that writes an ignored file, new or already there, writes outside its outputs and stops the merge", async (t) => {
  const cases = [
    [`${GENERATOR}writeFileSync("cache/new.log", "x");\n`, /wrote outside its declared outputs: cache\/new\.log/],
    [`${GENERATOR}import { appendFileSync } from "node:fs"; appendFileSync("kept.log", "more");\n`, /wrote outside its declared outputs: kept\.log/],
  ];
  for (const [generator, why] of cases) {
    const f = fixture(t, { extra: { ".gitignore": "*.log\n" } });
    mkdirSync(join(f.dir, "cache"));
    writeFileSync(join(f.dir, "kept.log"), "there before the merge\n");
    sides(f, { "cmds/push.txt": "name: push\n" }, { "cmds/land.txt": "name: land\n" });
    writeFileSync(join(f.dir, "gen.mjs"), generator);
    git(f.dir, "commit", "-q", "-am", "the generator writes an ignored file");
    const r = await mergeThrough(f.dir, "theirs", { message: "m" });
    assert.equal(r.state, "stopped", generator);
    assert.match(r.reason, why);
    assert.equal(r.regenerated.length, 1);
    assert.equal(r.regenerated[0].name, "index");
    assert.equal(r.regenerated[0].stop, r.reason);
    assert.ok(existsSync(r.regenerated[0].log));
    assert.equal(merging(f.dir), false);
  }
});

test("a generator that fails, writes outside its outputs, leaves an output out or is not deterministic stops and aborts the merge", async (t) => {
  const cases = [
    ["process.exit(3);\n", /failed on run 1 \(exit 3\)/],
    [`${GENERATOR}writeFileSync("stray.txt", "x");\n`, /wrote outside its declared outputs: stray\.txt/],
    [`${GENERATOR}import { rmSync } from "node:fs"; rmSync("out/index.txt");\n`, /did not leave its declared outputs out\/index\.txt/],
    [`${GENERATOR}import { appendFileSync } from "node:fs"; appendFileSync("out/index.txt", String(process.hrtime.bigint()) + "\\n");\n`, /is not deterministic: run again on its own output it changed out\/index\.txt/],
  ];
  for (const [generator, why] of cases) {
    const f = fixture(t);
    const s = sides(f, { "cmds/push.txt": "name: push\n" }, { "cmds/land.txt": "name: land\n" });
    // The broken generator arrives with ours, after both sides generated their own index.
    git(f.dir, "checkout", "-q", "main");
    writeFileSync(join(f.dir, "gen.mjs"), generator);
    git(f.dir, "commit", "-q", "-am", "break the generator");
    const head = git(f.dir, "rev-parse", "HEAD");
    const r = await mergeThrough(f.dir, "theirs", { message: "m" });
    assert.equal(r.state, "stopped", generator);
    assert.match(r.reason, why);
    assert.equal(r.regenerated.length, 1);
    assert.equal(r.regenerated[0].name, "index");
    assert.equal(r.regenerated[0].stop, r.reason);
    assert.ok(existsSync(r.regenerated[0].log));
    assert.equal(merging(f.dir), false);
    assert.equal(git(f.dir, "rev-parse", "HEAD"), head);
    assert.ok(s.theirs);
  }
});

test("a fresh clone lacking the merge configuration has it installed before its first merge", async (t) => {
  const f = fixture(t);
  // Each side adds the key /0 with its own record, at opposite ends of the file.
  sides(f, { "routes.tsv": "/a\tA\n/b\tB\n/0\ttheirs\n" }, { "routes.tsv": "/0\tours\n/a\tA\n/b\tB\n" });
  const clone = join(f.root, "clone");
  git(f.root, "clone", "-q", f.dir, clone);
  git(clone, "config", "user.name", "t"); git(clone, "config", "user.email", "t@x");
  git(clone, "fetch", "-q", "origin", "theirs");
  assert.ok(mergeConfigProblems(clone).length >= 4, "a fresh clone has none of it");
  // Without it Git falls back to a text merge, which takes both lines and
  // reports success with the key twice.
  const plain = gitFails(clone, "merge", "--no-ff", "--no-edit", "FETCH_HEAD");
  assert.equal(plain.status, 0);
  assert.equal(readFileSync(join(clone, "routes.tsv"), "utf8"), "/0\tours\n/a\tA\n/b\tB\n/0\ttheirs\n");
  git(clone, "reset", "-q", "--hard", "HEAD^1");
  const r = await mergeThrough(clone, "FETCH_HEAD", { message: "m" });
  assert.equal(r.state, "conflicts", JSON.stringify(r));
  assert.deepEqual(r.records, ["routes.tsv"]);
  assert.deepEqual(mergeConfigProblems(clone), []);
  assert.deepEqual(installMergeConfig(clone), [], "installing again changes nothing");
  // The driver it runs is the copy in the clone's Git directory, not a work-tree file.
  assert.match(git(clone, "config", "merge.atelier-records.driver"), /\.git\/atelier\/merge-driver\.mjs' records %O %A %B %P$/);
});

test("a Homebrew Cellar node is never written, with the stable link present or absent", (t) => {
  const f = fixture(t);
  const prefix = join(f.root, "brew");
  const cellar = join(prefix, "Cellar", "node", "26.9.0", "bin", "node");
  const other = join(f.root, "usr-bin"), cellarOnPath = join(prefix, "Cellar", "node", "26.9.0", "bin");
  for (const p of [cellar, join(other, "node")]) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, ""); }
  const written = (clone) => ["generated", "records"].map((k) => git(clone, "config", `merge.atelier-${k}.driver`)).join("\n");
  const cloneOf = (name) => { const c = join(f.root, name); git(f.root, "clone", "-q", f.dir, c); return c; };
  // Link present: the prefix's bin/node is named.
  mkdirSync(join(prefix, "bin"), { recursive: true }); writeFileSync(join(prefix, "bin", "node"), "");
  let clone = cloneOf("c1");
  installMergeConfig(clone, { node: stableNode(cellar, existsSync, [cellarOnPath, other]) });
  assert.ok(!written(clone).includes("/Cellar/"), written(clone));
  assert.ok(written(clone).includes(join(prefix, "bin", "node")));
  assert.deepEqual(mergeConfigProblems(clone, { node: stableNode(cellar, existsSync, [cellarOnPath, other]) }), []);
  // Link absent: a node on PATH outside the Cellar, else the bare command.
  unlinkSync(join(prefix, "bin", "node"));
  clone = cloneOf("c2");
  installMergeConfig(clone, { node: stableNode(cellar, existsSync, [cellarOnPath, other]) });
  assert.ok(!written(clone).includes("/Cellar/"), written(clone));
  assert.ok(written(clone).includes(join(other, "node")));
  clone = cloneOf("c3");
  const bare = stableNode(cellar, existsSync, [cellarOnPath]);
  assert.equal(bare, "node");
  installMergeConfig(clone, { node: bare });
  assert.ok(!written(clone).includes("/Cellar/"), written(clone));
  assert.match(written(clone), /^'node' /);
  assert.deepEqual(mergeConfigProblems(clone, { node: bare }), [], "a bare command is not reported missing");
  assert.equal(stableNode("/usr/local/bin/node", () => true), "/usr/local/bin/node");
});

test("a driver naming a node that no longer exists is reported and rewritten", (t) => {
  const f = fixture(t);
  const clone = join(f.root, "clone");
  git(f.root, "clone", "-q", f.dir, clone);
  installMergeConfig(clone);
  assert.deepEqual(mergeConfigProblems(clone), []);
  const gone = join(f.root, "Cellar", "node", "1.0.0", "bin", "node");
  for (const kind of ["generated", "records"]) {
    git(clone, "config", "--local", `merge.atelier-${kind}.driver`, `'${gone}' '${join(atelierGitDir(clone), "merge-driver.mjs")}' ${kind} %O %A %B %P`);
  }
  assert.ok(mergeConfigProblems(clone, { node: gone }).length >= 2, "the missing node is a problem");
  const changed = installMergeConfig(clone);
  assert.deepEqual(changed.sort(), ["merge.atelier-generated.driver", "merge.atelier-records.driver"]);
  assert.ok(!git(clone, "config", "merge.atelier-records.driver").includes(gone));
  assert.deepEqual(mergeConfigProblems(clone), []);
});

test("a declared path .gitattributes does not route to its driver stops the merge", async (t) => {
  const f = fixture(t, { attributes: "routes.tsv merge=atelier-records\n" });
  sides(f, { "cmds/push.txt": "name: push\n" }, { "cmds/land.txt": "name: land\n" });
  const r = await mergeThrough(f.dir, "theirs", { message: "m" });
  assert.equal(r.state, "stopped");
  assert.match(r.reason, /out\/index\.txt is declared in bin\/merge-manifest\.json but \.gitattributes routes it to merge=unspecified, not merge=atelier-generated/);
  assert.equal(merging(f.dir), false);
});

test("the manifest is checked whole: structured record files, outputs declared twice and keys without a capture group are refused", () => {
  assert.throws(() => parseManifest(JSON.stringify({ version: 1, records: [{ path: "routes.json" }] })), /routes\.json is a structured file; .*declare it as a registry of one file per entry/);
  // A structured file is a record file only when declared framed.
  assert.equal(parseManifest(JSON.stringify({ version: 1, records: [{ path: "routes.json", framed: true, key: "^  \"(\\S+)\"" }] })).records[0].framed, true);
  assert.throws(() => parseManifest(JSON.stringify({ version: 1, records: [{ path: "routes.tsv", framed: "yes" }] })), /framed must be true or false/);
  assert.throws(() => parseManifest(JSON.stringify({ version: 1, generators: [{ name: "a", command: ["x"], inputs: ["s/**"], outputs: ["o"] }, { name: "b", command: ["y"], inputs: ["s/**"], outputs: ["o"] }] })), /o is declared by both generator a and generator b/);
  assert.throws(() => parseManifest(JSON.stringify({ version: 1, registries: [{ name: "r", dir: "d", key: "name" }] })), /has no capture group/);
  assert.throws(() => parseManifest(JSON.stringify({ version: 1, generators: [{ name: "a", command: "make", inputs: [], outputs: ["o/*"] }] })), /command as a list of words[\s\S]*source inputs[\s\S]*not one plain file path/);
});

test("provenance goes before a closing Agent line, or in a block of its own", () => {
  assert.equal(withProvenance("Merge x\n\nAgent: a/b", ["P: 1"]), "Merge x\n\nP: 1\nAgent: a/b");
  assert.equal(withProvenance("Merge x", ["P: 1"]), "Merge x\n\nP: 1");
  assert.equal(withProvenance("Merge x", []), "Merge x");
});

test("a runner's merge goes through the same pipeline: generated conflicts regenerate, and a source conflict is left in progress with the outputs told apart in the brief", async (t) => {
  const f = fixture(t);
  sides(f, { "cmds/push.txt": "name: push\n" }, { "cmds/land.txt": "name: land\n" });
  const clean = await pipelineMerge(f.dir, "theirs", "Merge main at 12345678 into t1\n\nAgent: test/model");
  assert.equal(clean.code, 0, clean.output);
  assert.match(clean.output, /^Atelier-Regenerated: index/);
  assert.equal(readFileSync(join(f.dir, "out/index.txt"), "utf8"), "help\nland\npush\n");
  assert.match(git(f.dir, "log", "-1", "--format=%B"), /Atelier-Regenerated: [^\n]+\nAgent: test\/model$/);

  const g = fixture(t);
  sides(g, { "cmds/help.txt": "name: help\ndescription: theirs\n", "cmds/a.txt": "name: a\n" }, { "cmds/help.txt": "name: help\ndescription: ours\n", "cmds/b.txt": "name: b\n" });
  const stopped = await pipelineMerge(g.dir, "theirs", "m");
  assert.equal(stopped.code, 1);
  assert.deepEqual([stopped.source, stopped.generated], [["cmds/help.txt"], ["out/index.txt"]]);
  assert.ok(merging(g.dir), "left in progress for the builder");
  const brief = conflictsSection({ state: "conflicts", files: ["cmds/help.txt", "out/index.txt"], generated: stopped.generated, mainHead: "12345678abcdef" });
  assert.match(brief, /Of these, this is a generated output, declared in bin\/merge-manifest\.json: out\/index\.txt\. Do not edit it by hand\. Resolve the other files first, then run its declared generator command and git add it\./);
});

test("this repository declares its generated CLI fixtures and routes them to the generated driver", () => {
  const manifest = parseManifest(readFileSync(MANIFEST_PATH, "utf8"));
  const outputs = manifest.generators.flatMap((g) => g.outputs);
  assert.ok(outputs.includes("test/fixtures/cli/help.txt") && outputs.includes("test/fixtures/cli/usage.json"));
  const r = spawnSync("git", ["check-attr", "merge", "--", ...outputs], { encoding: "utf8" });
  for (const path of outputs) assert.match(r.stdout, new RegExp(`${path.replace(/[.]/g, "\\.")}: merge: atelier-generated`));
});

// t39: verifyAccepted and the adopt option. A merge that would regenerate an
// output is checked in a clone first; the finding it would have caught is
// t686's refusal of outputs that were the accepted revision's own.
test("verifyAccepted passes outputs equal to the accepted revision's and an adopting merge takes them without running the generator", async (t) => {
  const f = fixture(t, { extra: { "cmds/a.txt": "name: a\ndescription: one\n" } });
  const s = sides(f, { "cmds/a.txt": "name: a\ndescription: two\n" }, { "cmds/help.txt": "name: help\ndescription: three\n" });
  const v = await verifyAccepted(f.dir, s.ours, s.theirs);
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.deepEqual(v.regenerated[0].outputs, [{ path: "out/index.txt", matches: "the accepted revision" }]);
  assert.equal(merging(f.dir), false, "the checkout is untouched");
  const { run, calls } = counting();
  const r = await mergeThrough(f.dir, "theirs", { message: "m", generate: false, adopt: { tree: v.tree, regenerated: v.regenerated }, run });
  assert.equal(r.state, "merged", JSON.stringify(r));
  assert.equal(calls.length, 0, "no generator runs in the checkout");
  assert.equal(git(f.dir, "rev-parse", "HEAD^{tree}"), v.tree);
  assert.match(git(f.dir, "log", "-1", "--format=%B"), /Atelier-Regenerated: index .*: out\/index\.txt matches the accepted revision; log sha256 [0-9a-f]{64}/);
});

test("verifyAccepted refuses outputs that are not the accepted revision's, keeps the comparison and log, and leaves the checkout alone", async (t) => {
  const f = fixture(t);
  // The accepted revision left its index stale; regeneration would write another.
  const s = sides(f, { "cmds/push.txt": "name: push\n" }, { "cmds/land.txt": "name: land\n" }, { theirs: { regenerate: false } });
  const v = await verifyAccepted(f.dir, s.ours, s.theirs);
  assert.equal(v.ok, false);
  assert.match(v.reason, /regenerated outputs differ from the accepted revision's: out\/index\.txt/);
  assert.equal(merging(f.dir), false);
  assert.equal(git(f.dir, "status", "--porcelain"), "");
  assert.match(readFileSync(v.comparison, "utf8"), /verdict: refused, regenerated outputs differ/);
  assert.ok(existsSync(v.kept));
});

test("a merge that adopts a compared tree stops, aborted, when the tree it leaves is another (the head moved after the comparison)", async (t) => {
  const f = fixture(t, { extra: { "cmds/a.txt": "name: a\ndescription: one\n" } });
  const s = sides(f, { "cmds/a.txt": "name: a\ndescription: two\n" }, { "cmds/help.txt": "name: help\ndescription: three\n" });
  const v = await verifyAccepted(f.dir, s.ours, s.theirs);
  const other = commit(f.dir, { "cmds/help.txt": "name: help\ndescription: four\n", "extra.txt": "x\n" }, "main moves on");
  const r = await mergeThrough(f.dir, "theirs", { message: "m", generate: false, adopt: { tree: v.tree, regenerated: v.regenerated } });
  assert.equal(r.state, "stopped");
  assert.match(r.reason, /a tree other than the one whose regenerated outputs were compared/);
  assert.equal(merging(f.dir), false);
  assert.equal(git(f.dir, "rev-parse", "HEAD"), other);
});

test("a merge that adopts takes outputs from the accepted revision, and stops when it holds none", async (t) => {
  const f = fixture(t, { extra: { "cmds/a.txt": "name: a\ndescription: one\n" } });
  const s = sides(f, { "cmds/a.txt": "name: a\ndescription: two\n", "out/index.txt": null }, { "cmds/help.txt": "name: help\ndescription: three\n" }, { theirs: { regenerate: false } });
  const r = await mergeThrough(f.dir, "theirs", { message: "m", generate: false, adopt: { tree: "0".repeat(40), regenerated: [] } });
  assert.equal(r.state, "stopped");
  assert.match(r.reason, /the accepted revision does not hold every output of index/);
  assert.equal(merging(f.dir), false);
  assert.equal(git(f.dir, "rev-parse", "HEAD"), s.ours);
});

// t150: merge allowed one added file in the index, the landing receipt, on top
// of the compared tree. It allows none now: any path the index holds beyond the
// tree refuses the merge, a file under the receipts folder included. The
// finding it would have caught: a file other than the receipt, put at the
// receipt's path, passed the exception.
test("indexBeyond names every path the index holds beyond the tree, with no exception for a landing receipt", (t) => {
  const f = fixture(t);
  const tree = git(f.dir, "rev-parse", "HEAD^{tree}");
  assert.deepEqual(indexBeyond(f.dir, tree), []);
  write(f.dir, { "docs/control-plane/landing-receipts/2026-10-20-atelier-t1-abcdef12.json": "{}\n", "extra.txt": "x\n" });
  git(f.dir, "add", "-A");
  assert.deepEqual(indexBeyond(f.dir, tree).sort(), ["docs/control-plane/landing-receipts/2026-10-20-atelier-t1-abcdef12.json", "extra.txt"]);
  git(f.dir, "rm", "-q", "--cached", "extra.txt");
  assert.deepEqual(indexBeyond(f.dir, tree), ["docs/control-plane/landing-receipts/2026-10-20-atelier-t1-abcdef12.json"]);
});
