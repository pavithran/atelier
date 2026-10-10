import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { ROUTE_LEVEL } from "../src/route-level.ts";
import { detectMovedEdits, describeFinding, findingKey, parseHunks, parseRawZ, showPath, MIN_MATCH_LINES } from "../src/moved-code.ts";
import { readMovedCodeRecords } from "../cli/landing.mjs";

// The landing's poll is read when cli/land.mjs loads, so it is set first.
process.env.ATELIER_LAND_POLL_MS = "20";
const { runLand } = await import("../cli/land.mjs");

// Edits that main moved to another file (t471): the detector against real
// repositories — the t437-after-t426 regression that Git merges cleanly, a
// changed line, insertions, duplicate destinations, whitespace, the
// exclusions and unusual paths — and both landings through runLand with a
// stand-in server: a stop before the merge with Git unchanged, port and
// retry, --moved-ok's recorded approval, its refusal by the ledger and its
// invalidation at other revisions, and the comparison's own failures.

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const read = (cwd) => (args) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] });
const identity = (dir) => { git(dir, "config", "user.name", "Fixture"); git(dir, "config", "user.email", "fixture@example.invalid"); };
function root(t) { const p = mkdtempSync(join(tmpdir(), "atelier-moved-")); t.after(() => rmSync(p, { recursive: true, force: true })); return p; }
// Writes each file (null removes it), creating its folders.
function apply(dir, files = {}) {
  for (const [path, text] of Object.entries(files)) {
    if (text === null) { rmSync(join(dir, path), { force: true }); continue; }
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

// A merge base, the task's commit and main's commit in one repository;
// `moves` are main's `git mv`s, made before its files are written.
function scenario(t, { base, task = {}, main = {}, moves = [] }) {
  const dir = root(t);
  git(dir, "init", "-q", "-b", "main"); identity(dir);
  apply(dir, base); git(dir, "add", "-A"); git(dir, "commit", "-qm", "base");
  const mergeBase = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-qb", "task"); apply(dir, task); git(dir, "add", "-A"); git(dir, "commit", "-q", "--allow-empty", "-m", "task");
  const taskHead = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "main");
  for (const [from, to] of moves) { mkdirSync(dirname(join(dir, to)), { recursive: true }); git(dir, "mv", from, to); }
  apply(dir, main); git(dir, "add", "-A"); git(dir, "commit", "-q", "--allow-empty", "-m", "main");
  const revs = { task: taskHead, main: git(dir, "rev-parse", "HEAD"), mergeBase };
  return { dir, revs, detect: () => detectMovedEdits(read(dir), revs) };
}

// ── the regression: t437's handler edit after t426 moved the handlers ─────

// cli/atelier.mjs held the handlers; t426 (5e46dc6) moved each to
// cli/commands/ and left a loader in its place, whose `}` and blank line Git
// matches to the handler's own. t437 inserted a line between those two.
const ATELIER = `const commands = {
  async status() {
    console.log("status");
  },
  async report() {
    const r = await call("POST", "/evidence", { claim: args._[2] });
    if (r.refused) {
      console.log("refused");
    }

    console.log("reported");
  },
  async show() {
    console.log("show");
  },
};
`;
const T437 = ATELIER.replace('    }\n\n    console.log("reported");', '    }\n    if (r.stale) process.exitCode = 1;\n\n    console.log("reported");');
const T426 = `const loaded = {};
const commands = {
  async status() {
    console.log("status");
  },
  async report() {
    if (!loaded.report) {
      loaded.report = await import("./commands/report.mjs");
    }

    return loaded.report.default();
  },
  async show() {
    console.log("show");
  },
};
`;
const REPORT = `export default async function report() {
  const r = await call("POST", "/evidence", { claim: args._[2] });
  if (r.refused) {
    console.log("refused");
  }

  console.log("reported");
}
`;
const regression = { base: { "cli/atelier.mjs": ATELIER }, task: { "cli/atelier.mjs": T437 }, main: { "cli/atelier.mjs": T426, "cli/commands/report.mjs": REPORT } };

test("t437 after t426: Git merges the handler edit cleanly into the loader, and the comparison finds it moved to cli/commands/report.mjs", (t) => {
  const s = scenario(t, regression);
  // The regression itself: Git's merge is clean and leaves the edit in the
  // loader, while the moved handler never gets it.
  git(s.dir, "checkout", "-q", "task");
  git(s.dir, "merge", "-q", "--no-edit", "main");
  assert.match(git(s.dir, "show", "HEAD:cli/atelier.mjs"), /loaded\.report = await import\("\.\/commands\/report\.mjs"\);\n    }\n    if \(r\.stale\) process\.exitCode = 1;\n\n    return loaded\.report\.default\(\);/);
  assert.doesNotMatch(git(s.dir, "show", "HEAD:cli/commands/report.mjs"), /r\.stale/);
  // The comparison finds it, before any merge.
  const report = s.detect();
  assert.deepEqual(report.ambiguous, []);
  assert.equal(report.findings.length, 1);
  const [f] = report.findings;
  assert.deepEqual(f.source, { path: "cli/atelier.mjs", start: 6, end: 11 });
  assert.deepEqual(f.destination, { path: "cli/commands/report.mjs", start: 2, end: 7 });
  assert.deepEqual(f.edit, { kind: "insert", start: 9, end: 10, taskStart: 10, taskEnd: 10 });
  assert.equal(f.lines, 6);
  assert.equal(f.sample[0], 'const r = await call("POST", "/evidence", { claim: args._[2] });');
  assert.match(describeFinding(f), /^cli\/atelier\.mjs lines 6-11 moved to cli\/commands\/report\.mjs lines 2-7: the task inserted 1 line between base lines 9 and 10 there \(its line 10 at the task's head\); 6 lines match, whitespace aside/);
  assert.deepEqual({ task: report.task, main: report.main, mergeBase: report.mergeBase }, s.revs);
});

test("the repository's diff configuration changes nothing: with interHunkContext and context raised, the same findings come back", (t) => {
  // A second task edit six lines above the moved one, in a handler main kept
  // in place: with interHunkContext the two hunks merge into one carrying
  // context lines, as t437's real history did.
  const task = { "cli/atelier.mjs": T437.replace('console.log("status");', 'console.log("status!");') };
  const s = scenario(t, { ...regression, task });
  const plain = s.detect();
  assert.equal(plain.findings.length, 1);
  git(s.dir, "config", "diff.interHunkContext", "10");
  git(s.dir, "config", "diff.context", "20");
  git(s.dir, "config", "diff.algorithm", "patience");
  assert.deepEqual(s.detect().findings, plain.findings);
});

test("GIT_DIFF_OPTS cannot hide a move: context Git adds is never read as changed lines", (t) => {
  const task = { "cli/atelier.mjs": T437.replace('console.log("status");', 'console.log("status!");') };
  const s = scenario(t, { ...regression, task });
  const plain = s.detect();
  assert.equal(plain.findings.length, 1);
  // Without DETECTOR_ENV, so the parser alone must cope with the context.
  const withOpts = (args) => execFileSync("git", args, { cwd: s.dir, encoding: "utf8", maxBuffer: 1 << 28, env: { ...process.env, GIT_DIFF_OPTS: "-u50" }, stdio: ["ignore", "pipe", "pipe"] });
  assert.deepEqual(detectMovedEdits(withOpts, s.revs).findings, plain.findings);
});

test("parseHunks reads a hunk with context lines to its end, counting each on both sides", () => {
  const out = ["@@ -1,4 +1,5 @@", " keep", "-gone", "+came", "+also", " keep2", " keep3", "@@ -9 +10 @@", "-x", "+y", ""].join("\n");
  const hunks = parseHunks(out);
  assert.equal(hunks.length, 2);
  assert.deepEqual(hunks[0].added, ["came", "also"]);
  assert.deepEqual(hunks[1], { oldStart: 9, oldCount: 1, newStart: 10, newCount: 1, added: ["y"] });
});

// ── the matching rule ───────────────────────────────────────────────────────

const BLOCK = ["function render(item) {", "    const title = item.title;", "    const body = format(item.body);", "    return `${title}: ${body}`;", "}"];
const lib = (block) => ["// helpers", "export const a = 1;", "", ...block, "", "export const z = 26;", ""].join("\n");

test("a changed line inside a moved block is found though main re-indented the block and left trailing whitespace", (t) => {
  const s = scenario(t, {
    base: { "src/lib.js": lib(BLOCK) },
    task: { "src/lib.js": lib(BLOCK.map((l) => l.replace("format(item.body)", "format(item.body, { strict: true })"))) },
    main: { "src/lib.js": lib([]), "src/render.js": `export ${BLOCK[0]}\t\n${BLOCK.slice(1).map((l) => `  ${l.trim()}   `).join("\n")}\n` },
  });
  // `export function …` is not the base's line, so the match starts below it.
  const report = s.detect();
  assert.equal(report.findings.length, 1, JSON.stringify(report));
  assert.deepEqual(report.findings[0].source, { path: "src/lib.js", start: 5, end: 8 });
  assert.deepEqual(report.findings[0].destination, { path: "src/render.js", start: 2, end: 5 });
  assert.deepEqual(report.findings[0].edit, { kind: "change", start: 6, end: 6, taskStart: 6, taskEnd: 6 });
});

test("an insertion between two moved lines is found; one at the moved block's edge, with a kept neighbour, is not", (t) => {
  const inside = scenario(t, {
    base: { "src/lib.js": lib(BLOCK) },
    task: { "src/lib.js": lib([...BLOCK.slice(0, 2), "    log(title);", ...BLOCK.slice(2)]) },
    main: { "src/lib.js": lib([]), "src/render.js": `${BLOCK.join("\n")}\n` },
  });
  const found = inside.detect();
  assert.equal(found.findings.length, 1);
  assert.deepEqual(found.findings[0].edit, { kind: "insert", start: 5, end: 6, taskStart: 6, taskEnd: 6 });
  assert.deepEqual(found.findings[0].destination, { path: "src/render.js", start: 1, end: 5 });
  // Before the block's first line: its other neighbour is the blank line
  // main kept, so nothing says which side the insertion belonged to.
  const edge = scenario(t, {
    base: { "src/lib.js": lib(BLOCK) },
    task: { "src/lib.js": lib(["// renders an item", ...BLOCK]) },
    main: { "src/lib.js": ["// helpers", "export const a = 1;", "", "", "export const z = 26;", ""].join("\n"), "src/render.js": `${BLOCK.join("\n")}\n` },
  });
  assert.deepEqual(edge.detect(), { ...edge.revs, findings: [], ambiguous: [] });
});

test("a block main added to two files is an ambiguous warning naming both, never a confirmed move", (t) => {
  const s = scenario(t, {
    base: { "src/lib.js": lib(BLOCK) },
    task: { "src/lib.js": lib(BLOCK.map((l) => l.replace("item.title", "item.name"))) },
    main: { "src/lib.js": lib([]), "src/one.js": `${BLOCK.join("\n")}\n`, "src/two.js": `// copy\n${BLOCK.join("\n")}\n` },
  });
  const report = s.detect();
  assert.deepEqual(report.findings, []);
  assert.equal(report.ambiguous.length, 1);
  assert.deepEqual(report.ambiguous[0].destinations.map((d) => d.path).sort(), ["src/one.js", "src/two.js"]);
  assert.deepEqual(report.ambiguous[0].destinations.find((d) => d.path === "src/two.js"), { path: "src/two.js", start: 2, end: 6 });
});

test("a match needs MIN_MATCH_LINES non-blank lines, so a lone common line moved elsewhere is not a move", (t) => {
  assert.equal(MIN_MATCH_LINES, 3);
  const s = scenario(t, {
    base: { "a.js": "one();\n}\ntwo();\nthree();\n" },
    task: { "a.js": "one();\n} // end\ntwo();\nthree();\n" },
    main: { "a.js": "one();\ntwo();\nthree();\n", "b.js": "x();\n}\n" },
  });
  assert.deepEqual(s.detect().findings, []);
});

// ── what the comparison leaves out ──────────────────────────────────────────

test("a move no task edit touches is left out", (t) => {
  const s = scenario(t, {
    base: { "src/lib.js": lib(BLOCK) },
    task: { "src/lib.js": lib(BLOCK).replace("export const z = 26;", "export const z = 27;") },
    main: { "src/lib.js": lib([]), "src/render.js": `${BLOCK.join("\n")}\n` },
  });
  assert.deepEqual(s.detect(), { ...s.revs, findings: [], ambiguous: [] });
});

test("an in-place edit by main, whatever the task changed there, is left out", (t) => {
  const s = scenario(t, {
    base: { "src/lib.js": lib(BLOCK) },
    task: { "src/lib.js": lib(BLOCK.map((l) => l.replace("item.title", "item.name"))) },
    main: { "src/lib.js": lib(["// rendered elsewhere now", ...BLOCK.slice(0, 1), "    return String(item);", "}"]) },
  });
  assert.deepEqual(s.detect(), { ...s.revs, findings: [], ambiguous: [] });
});

test("a whole file Git pairs as a rename at the threshold is left out, its new path never a destination", (t) => {
  const s = scenario(t, {
    base: { "src/lib.js": lib(BLOCK) },
    task: { "src/lib.js": lib(BLOCK.map((l) => l.replace("item.title", "item.name"))) },
    moves: [["src/lib.js", "src/render/lib.js"]],
    main: { "src/render/lib.js": lib(BLOCK).replace("// helpers", "// helpers, renamed") },
  });
  assert.match(read(s.dir)(["diff-tree", "-r", "--find-renames=50%", s.revs.mergeBase, s.revs.main]), /^:100644 100644 \S+ \S+ R\d+\tsrc\/lib\.js\tsrc\/render\/lib\.js$/m);
  assert.deepEqual(s.detect(), { ...s.revs, findings: [], ambiguous: [] });
});

test("binary files are out of scope: neither read as a source nor a destination, and nothing fails", (t) => {
  const bytes = (n) => Buffer.from([0, 1, 2, n, 0, 10, ...Buffer.from(BLOCK.join("\n")), 10, 0]);
  const dir = root(t);
  git(dir, "init", "-q", "-b", "main"); identity(dir);
  writeFileSync(join(dir, "blob.bin"), bytes(1)); git(dir, "add", "-A"); git(dir, "commit", "-qm", "base");
  const mergeBase = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-qb", "task"); writeFileSync(join(dir, "blob.bin"), bytes(2)); git(dir, "commit", "-qam", "task");
  const task = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "main"); writeFileSync(join(dir, "blob.bin"), bytes(3)); writeFileSync(join(dir, "copy.bin"), bytes(1)); git(dir, "add", "-A"); git(dir, "commit", "-qm", "main");
  const revs = { task, main: git(dir, "rev-parse", "HEAD"), mergeBase };
  assert.deepEqual(detectMovedEdits(read(dir), revs), { ...revs, findings: [], ambiguous: [] });
});

// ── paths ───────────────────────────────────────────────────────────────────

test("paths with spaces, tabs and newlines are read as written, for the source and the destination", (t) => {
  const source = "cli/old dir/hand\tlers\nmore.mjs", destination = "cli/new dir/re port\n\t.mjs";
  const s = scenario(t, {
    base: { [source]: ATELIER },
    task: { [source]: T437 },
    main: { [source]: T426, [destination]: REPORT },
  });
  const [f] = s.detect().findings;
  assert.equal(f.source.path, source);
  assert.equal(f.destination.path, destination);
  assert.equal(showPath(source), JSON.stringify(source));
  assert.equal(showPath("cli/commands/report.mjs"), "cli/commands/report.mjs");
  assert.equal(showPath("a b"), '"a b"');
  assert.match(describeFinding(f), /^"cli\/old dir\/hand\\tlers\\nmore\.mjs" lines 6-11 moved to "cli\/new dir\/re port\\n\\t\.mjs" lines 2-7/);
});

test("parseRawZ reads NUL-separated entries, renames with both paths; parseHunks counts lines and says binary", () => {
  const z = [":100644 100644 aaa bbb M", "a\tb\nc.js", ":100644 100644 ccc ddd R091", "old name", "new\nname", ":000000 100644 000 eee A", "x", ""].join("\0");
  assert.deepEqual(parseRawZ(z), [
    { status: "M", score: null, modes: ["100644", "100644"], blobs: ["aaa", "bbb"], from: null, path: "a\tb\nc.js" },
    { status: "R", score: 91, modes: ["100644", "100644"], blobs: ["ccc", "ddd"], from: "old name", path: "new\nname" },
    { status: "A", score: null, modes: ["000000", "100644"], blobs: ["000", "eee"], from: null, path: "x" },
  ]);
  // A deleted line that reads like a header is still a line of its hunk.
  const patch = ["diff --git a/x b/y", "--- a/x", "+++ b/y", "@@ -3,2 +3 @@", "---- a/looks-like-a-header", "-@@ -1 +1 @@", "+new", "\\ No newline at end of file", "@@ -9,0 +10,2 @@ ctx", "+p", "+q", ""].join("\n");
  assert.deepEqual(parseHunks(patch), [
    { oldStart: 3, oldCount: 2, newStart: 3, newCount: 1, added: ["new"] },
    { oldStart: 9, oldCount: 0, newStart: 10, newCount: 2, added: ["p", "q"] },
  ]);
  assert.equal(parseHunks("diff --git a/x b/y\nBinary files a/x and b/y differ\n"), null);
});

// ── the landings ────────────────────────────────────────────────────────────

// A baseline, the task's workspace forked from it and main moved on after
// the fork, as a landing finds them.
function landWorld(t, { base, task, main, moves = [] }) {
  const p = root(t), seed = join(p, "seed"), baseline = join(p, "baseline.git"), ws = join(p, "work", "t1"), mainClone = join(p, "main");
  mkdirSync(seed); git(seed, "init", "-q", "-b", "main"); identity(seed);
  apply(seed, base); git(seed, "add", "-A"); git(seed, "commit", "-qm", "base");
  git(p, "clone", "-q", "--bare", seed, baseline);
  git(p, "clone", "-q", baseline, ws); identity(ws);
  for (const [key, value] of Object.entries({ project: "proj", item: "t1", actor: "codex/test", branch: "main", "write-token-expires-at": "2999-01-01T00:00:00.000Z" })) git(ws, "config", `atelier.${key}`, value);
  apply(ws, task); git(ws, "add", "-A"); git(ws, "commit", "-qm", "task");
  git(p, "clone", "-q", baseline, mainClone); identity(mainClone);
  const pushMain = (files, mv = []) => {
    for (const [from, to] of mv) { mkdirSync(dirname(join(mainClone, to)), { recursive: true }); git(mainClone, "mv", from, to); }
    apply(mainClone, files); git(mainClone, "add", "-A"); git(mainClone, "commit", "-qm", "main"); git(mainClone, "push", "-q", "origin", "main");
    return git(mainClone, "rev-parse", "HEAD");
  };
  pushMain(main, moves);
  return { p, baseline, ws, mainClone, pushMain, head: () => git(ws, "rev-parse", "HEAD"), mainHead: () => git(mainClone, "rev-parse", "HEAD"), log: () => readMovedCodeRecords(join(ws, ".git")) };
}

// A stand-in landing Workflow: it holds the lease and asks for the workspace
// at once, pauses on a conflict, starts a new round on a resume, and ends
// on a reported head unless `onHead` says otherwise.
function fakeWorkflow({ onHead } = {}) {
  const wf = { instance: null, stage: null, round: 0, status: null, files: null, events: [] };
  const view = () => ({ instance: wf.instance, stage: wf.stage, round: wf.round, files: wf.files, checks: "container", status: { status: wf.status } });
  wf.handle = (method, body) => {
    if (method === "GET") return wf.instance ? view() : { instance: null, status: null };
    if (body.event) {
      const e = body.event;
      wf.events.push(e);
      if (e.type === "workspace" && e.payload.conflict) { wf.stage = "conflict"; wf.files = e.payload.files; }
      else if (e.type === "workspace" && e.payload.failed) { wf.stage = "failed"; wf.status = "errored"; }
      else if (e.type === "workspace") (onHead ?? (() => { wf.stage = "done"; wf.status = "complete"; }))(e, wf);
      else if (e.type === "resume" && e.payload.round === wf.round) { wf.stage = "workspace"; wf.round++; }
      return { sent: true };
    }
    if (wf.instance && wf.status === "running") return { ...view(), created: false };
    Object.assign(wf, { instance: "w1", stage: "workspace", round: 0, status: "running", files: null });
    return { ...view(), created: true };
  };
  return wf;
}

// runLand with the server's answers, real Git in the workspace and the CLI's
// own steps passing. `refuseApproval` has the ledger refuse the --moved-ok
// record as it refuses anyone but the project owner; `failGit` fails the Git
// commands it names.
function landIo(world, { args = {}, wf = null, refuseApproval = false, failGit = null } = {}) {
  const calls = [], lines = [], commands = [];
  const itemPath = "/projects/proj/items/t1", leasePath = "/projects/proj/landing-lease";
  const request = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path === "/version") return { routeLevel: ROUTE_LEVEL, commit: "c0ffee" };
    if (path === leasePath) return method === "GET" ? { lease: null, waiting: [] } : body.cancel || body.renew ? {} : { item: { id: "t1", state: "submitted" } };
    if (path === itemPath) return { item: { id: "t1", state: "submitted", owner: "codex/test" }, policy: { checks: [] } };
    if (path === `${itemPath}/base-token`) return { remote: world.baseline, token: "read", defaultBranch: "main" };
    if (path === `${itemPath}/land` && refuseApproval && body.resolvedBy) throw Object.assign(new Error("not_project_owner: only the project owner records a landing's steps"), { status: 403 });
    if (path === `${itemPath}/landing-workflow`) return wf.handle(method, body ?? {});
    return {};
  };
  const realGit = (a, o = {}) => {
    if (failGit?.(a)) throw new Error(`git ${a[0]} failed:\nfatal: injected failure`);
    const r = spawnSync("git", a, { cwd: o.cwd, encoding: "utf8", maxBuffer: 1 << 28 });
    if (o.allowFail) return r;
    if (r.status !== 0) throw new Error(`git ${a.join(" ")} failed:\n${r.stderr}`);
    return o.raw ? r.stdout : r.stdout.trim();
  };
  const runCommand = async (argv) => { commands.push(argv[2]); return { passed: true, status: 0, output: "ok\n", durationMs: 1 }; };
  const io = {
    args: { _: ["land", "t1"], ...(args.workflow ? {} : { "no-review": true }), ...args }, name: "proj", id: "t1", p: { path: world.p, branch: "main" }, owner: "owner",
    request, git: realGit, print: (line) => lines.push(line), die: (message) => { throw new Error(message); },
    workspacePath: () => world.ws, atelier: "atelier.mjs", env: {}, redact: (s) => s, secrets: () => [], runCommand, adoptWorkspaceToken: () => {},
  };
  const posts = (suffix) => calls.filter((c) => c.method === "POST" && c.path.endsWith(suffix));
  return {
    io, calls, lines, commands, posts, output: () => lines.join("\n"),
    land: async () => { try { await runLand(io); return null; } catch (error) { return error; } },
    records: () => posts("/land").map((c) => c.body),
    released: () => posts("/landing-lease").some((c) => c.body.cancel === true),
  };
}

const unchanged = (world, head) => {
  assert.equal(world.head(), head);
  assert.ok(!existsSync(join(world.ws, ".git", "MERGE_HEAD")), "no merge is left in the workspace");
  assert.equal(git(world.ws, "status", "--porcelain"), "");
};

test("plain land: an edit in moved code stops it before the merge, Git unchanged, the lease released, revisions and porting instructions recorded", async (t) => {
  const w = landWorld(t, regression);
  const head = w.head(), main = w.mainHead(), mergeBase = git(w.ws, "merge-base", "HEAD", "origin/main");
  const l = landIo(w);
  const error = await l.land();
  assert.ok(error, "the landing stops");
  assert.match(error.message, /t1's edits lie in code main moved to another file, so the landing stops before merging main; Git and the workspace are unchanged \(task [0-9a-f]{8}, main [0-9a-f]{8}, merge base [0-9a-f]{8}\):\n  - cli\/atelier\.mjs lines 6-11 moved to cli\/commands\/report\.mjs lines 2-7/);
  assert.match(error.message, /To port them: merge main into the workspace .*atelier dispatch t1 --job merge-main\), make each edit again at its destination, commit, and run atelier land t1 again, which compares afresh\. If a finding is wrong, atelier land t1 --moved-ok records your approval/);
  unchanged(w, head);
  assert.ok(l.released());
  assert.deepEqual(l.commands, []);
  const merge = l.records().find((r) => r.step === "merge");
  assert.equal(merge.failed, true);
  assert.deepEqual(merge.conflicts, ["cli/atelier.mjs", "cli/commands/report.mjs"]);
  assert.ok(merge.reason.startsWith(`moved-code comparison at task ${head}, main ${main}, merge base ${mergeBase}: 1 finding stopped the landing before the merge`), merge.reason);
  const [entry] = w.log();
  assert.equal(entry.kind, "stopped");
  assert.deepEqual([entry.task, entry.main, entry.mergeBase], [head, main, mergeBase]);
  assert.equal(entry.findings[0].destination.path, "cli/commands/report.mjs");
  assert.match(entry.instructions, /make each edit again at its destination/);
});

test("plain land: after the edit is ported a retry compares afresh and lands; with main already merged it says earlier moves cannot be detected", async (t) => {
  const w = landWorld(t, regression);
  assert.ok(await landIo(w).land());
  // The port: main merged by hand (Git puts the line in the loader), the
  // line carried to the moved handler instead, committed.
  git(w.ws, "fetch", "-q", w.baseline, "main"); git(w.ws, "merge", "-q", "--no-edit", "FETCH_HEAD");
  apply(w.ws, { "cli/atelier.mjs": T426, "cli/commands/report.mjs": REPORT.replace("  }\n\n", "  }\n  if (r.stale) process.exitCode = 1;\n\n") });
  git(w.ws, "commit", "-qam", "Port the stale-head exit to cli/commands/report.mjs");
  const ported = w.head(), before = w.mainHead();
  // Main moves on, so the retry has a comparison to make.
  const main = w.pushMain({ "NOTES.md": "notes\n" });
  const retry = landIo(w);
  assert.equal(await retry.land(), null, retry.output());
  assert.match(retry.output(), new RegExp(`Compared t1's edits with code main moved to another file \\(task ${ported.slice(0, 8)}, main ${main.slice(0, 8)}, merge base ${before.slice(0, 8)}\\): none found\\.`));
  assert.equal(retry.records().find((r) => r.step === "merge").reason, `moved-code comparison at task ${ported}, main ${main}, merge base ${before}: no edit in moved code`);
  assert.deepEqual(retry.commands, ["push", "check", "submit"]);
  assert.equal(git(w.ws, "rev-list", "--parents", "-n", "1", "HEAD").split(" ").length, 3);
  // Again, with main already merged: nothing to compare, said as such.
  const again = landIo(w);
  assert.equal(await again.land(), null, again.output());
  assert.match(again.output(), /main at [0-9a-f]{8} is already merged into t1's workspace\. With main already merged there is nothing to compare, so this landing cannot detect edits that an earlier merge of main left in code main had moved to another file\./);
  assert.match(again.records().find((r) => r.step === "merge").reason, /^moved-code comparison: main [0-9a-f]{40} is already in t1's head [0-9a-f]{40}, so nothing was compared/);
});

test("plain land --moved-ok records the owner, the findings and the revisions on the ledger and in the log before the merge, then goes on", async (t) => {
  const w = landWorld(t, regression);
  const head = w.head(), main = w.mainHead();
  const l = landIo(w, { args: { "moved-ok": true } });
  assert.equal(await l.land(), null, l.output());
  const records = l.records();
  const approval = records.findIndex((r) => r.resolvedBy === "owner with --moved-ok");
  assert.ok(approval >= 0);
  assert.deepEqual(records.map((r) => r.step), ["lease", "merge", "merge", "push", "check", "submit", "review"]);
  const recorded = records[approval];
  assert.equal(recorded.head, head);
  assert.deepEqual(recorded.conflicts, ["cli/atelier.mjs", "cli/commands/report.mjs"]);
  assert.match(recorded.reason, new RegExp(`^--moved-ok: owner approved 1 finding at task ${head}, main ${main}, merge base [0-9a-f]{40}: cli/atelier\\.mjs lines 6-11 moved to cli/commands/report\\.mjs lines 2-7`));
  // Recorded before the merge, which the next record is.
  assert.equal(records[approval + 1].step, "merge");
  assert.match(records[approval + 1].reason, /1 finding approved with --moved-ok$/);
  const [entry] = w.log();
  assert.deepEqual({ kind: entry.kind, actor: entry.actor, task: entry.task, main: entry.main }, { kind: "moved-ok", actor: "owner", task: head, main });
  assert.equal(entry.findings.length, 1);
  assert.match(l.output(), /--moved-ok: your approval of exactly these 1 finding at these revisions is recorded; the landing goes on, and a conflict in Git's merge still stops it\./);
  assert.equal(git(w.ws, "rev-list", "--parents", "-n", "1", "HEAD").split(" ").length, 3, "main was merged");
});

test("--moved-ok bypasses only the findings: a Git conflict still stops the landing", async (t) => {
  const w = landWorld(t, {
    base: { ...regression.base, "work.txt": "base\n" },
    task: { ...regression.task, "work.txt": "task\n" },
    main: { ...regression.main, "work.txt": "main\n" },
  });
  const l = landIo(w, { args: { "moved-ok": true } });
  const error = await l.land();
  assert.match(error.message, /stops on conflicts in:\nwork\.txt/);
  assert.ok(l.records().some((r) => r.resolvedBy === "owner with --moved-ok"));
  assert.ok(l.released());
});

test("--moved-ok whose approval the ledger refuses (anyone but the project owner) stops before the merge with Git unchanged", async (t) => {
  const w = landWorld(t, regression);
  const head = w.head();
  const l = landIo(w, { args: { "moved-ok": true }, refuseApproval: true });
  const error = await l.land();
  assert.match(error.message, /the --moved-ok approval of 1 finding \(task [0-9a-f]{8}, main [0-9a-f]{8}, merge base [0-9a-f]{8}\) could not be recorded on the ledger, so the landing stops before merging main; Git and the workspace are unchanged: not_project_owner/);
  unchanged(w, head);
  assert.ok(l.released());
  assert.deepEqual(w.log(), []);
});

test("an approval is not carried to other revisions: a run without --moved-ok stops again, and a later round at another main needs a fresh approval", async (t) => {
  const w = landWorld(t, regression);
  // A run of its own never inherits an approval recorded by an earlier one.
  const approved = landIo(w, { args: { "moved-ok": true, workflow: true }, wf: fakeWorkflow({
    // Round 0's head is reported; the Workflow asks for the workspace again
    // after main moved and the workspace returned to the task's head.
    onHead: (e, wf) => {
      if (e.payload.round !== 0) { wf.stage = "done"; wf.status = "complete"; return; }
      git(w.ws, "reset", "-q", "--hard", "HEAD^1");
      w.pushMain({ "NOTES.md": "main moved\n" });
      wf.stage = "workspace"; wf.round = 1;
    },
  }) });
  const error = await approved.land();
  assert.ok(error);
  assert.match(error.message, /^--moved-ok approved the findings at task [0-9a-f]{8}, main [0-9a-f]{8}, merge base [0-9a-f]{8}; this comparison is at other revisions or found other edits, so it needs a fresh approval\. t1's edits lie in code main moved/);
  assert.match(error.message, /paused at its conflict stage/);
  assert.equal(approved.records().filter((r) => r.resolvedBy).length, 1, "one approval, at the first revisions");
  assert.deepEqual(w.log().map((e) => e.kind), ["moved-ok", "stopped"]);
  assert.notEqual(w.log()[0].main, w.log()[1].main);
  // A fresh plain run without the flag stops on the findings again.
  const plain = landIo(w);
  assert.match((await plain.land()).message, /t1's edits lie in code main moved to another file/);
});

test("Workflow land: an edit in moved code pauses the Workflow at its conflict stage with no merge to resolve, and the rerun resumes and compares afresh", async (t) => {
  const w = landWorld(t, regression);
  const head = w.head();
  const wf = fakeWorkflow();
  const first = landIo(w, { args: { workflow: true }, wf });
  const error = await first.land();
  assert.match(error.message, /t1's edits lie in code main moved to another file/);
  assert.match(error.message, /The landing Workflow is paused at its conflict stage and has released the lease; no merge was made, so nothing is left to resolve in the index\. Once the edits are ported and committed, run atelier land t1 --workflow again/);
  assert.match(error.message, /run atelier land t1 --workflow again, which compares afresh/);
  assert.deepEqual(wf.events.map((e) => [e.type, e.payload.round, e.payload.conflict, e.payload.files]), [["workspace", 0, true, ["cli/atelier.mjs", "cli/commands/report.mjs"]]]);
  assert.equal(wf.stage, "conflict");
  unchanged(w, head);
  assert.deepEqual(first.posts("/push"), []);
  // The rerun resumes; nothing was ported, so the comparison stops it again.
  const second = landIo(w, { args: { workflow: true }, wf });
  assert.match((await second.land()).message, /t1's edits lie in code main moved/);
  assert.deepEqual(wf.events.slice(1).map((e) => [e.type, e.payload.round, e.payload.conflict ?? false]), [["resume", 0, false], ["workspace", 1, true]]);
  unchanged(w, head);
  // With --moved-ok the next round records the approval and goes on.
  const third = landIo(w, { args: { workflow: true, "moved-ok": true }, wf });
  assert.equal(await third.land(), null, third.output());
  const reported = wf.events.at(-1);
  assert.equal(reported.type, "workspace");
  assert.equal(reported.payload.round, 2);
  assert.equal(reported.payload.head, w.head());
  assert.ok(third.records().some((r) => r.resolvedBy === "owner with --moved-ok"));
  assert.deepEqual(third.commands, ["push"]);
});

test("a comparison that fails, or finds no merge base, stops the landing with the reason, Git unchanged and the lease released", async (t) => {
  const w = landWorld(t, regression);
  const head = w.head();
  const failing = landIo(w, { failGit: (a) => a[0] === "diff-tree" });
  const error = await failing.land();
  assert.match(error.message, /the comparison of t1's edits with code main moved to another file failed \(task [0-9a-f]{8}, main [0-9a-f]{8}, merge base [0-9a-f]{8}\), so the landing stops before merging main; Git and the workspace are unchanged: git diff-tree failed:\nfatal: injected failure/);
  unchanged(w, head);
  assert.ok(failing.released());
  assert.equal(failing.records().find((r) => r.step === "merge").failed, true);
  // Main replaced by a history unrelated to the task's.
  git(w.mainClone, "checkout", "-q", "--orphan", "other"); apply(w.mainClone, { "other.txt": "unrelated\n" });
  git(w.mainClone, "add", "-A"); git(w.mainClone, "commit", "-qm", "unrelated"); git(w.mainClone, "push", "-q", "-f", "origin", "other:main");
  const unrelated = landIo(w);
  const none = await unrelated.land();
  assert.match(none.message, /t1's head [0-9a-f]{8} and main at [0-9a-f]{8} have no merge base, so the landing cannot compare t1's edits with code main moved to another file, and stops before merging main; Git and the workspace are unchanged\./);
  unchanged(w, head);
  assert.ok(unrelated.released());
});

test("findingKey names a finding's source, destination and edit, so an approval names exactly what it approved", (t) => {
  const s = scenario(t, regression);
  const [f] = s.detect().findings;
  assert.equal(findingKey(f), JSON.stringify(["cli/atelier.mjs", 6, 11, "cli/commands/report.mjs", 2, 7, "insert", 9, 10]));
});
