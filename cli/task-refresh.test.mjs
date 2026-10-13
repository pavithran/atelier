// The task refresh's runner jobs (t462, cli/task-refresh.mjs), against real
// Git repositories standing in for a task's fork and main, with the server's
// side faked at the CLI: a clean merge, a task already holding main, a
// mechanical conflict found by the integrator and resolved by a resolver, a
// resolution outside the transformations, behavioural and uncertain
// conflicts, a builder's push under the refresh, a refused push, failed
// checks, a recorded push the server would not take, one it recorded with
// every answer lost, a lease resumed at its recorded head, and an edit in code
// main moved to another file (t471), which neither job merges; and the
// lease, renewed through a long run and given back, saying why, when a
// provider's usage limit stops the resolver or a failure precedes any report.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { DETECTOR_ENV } from "../src/moved-code.ts";
import { diffIdentity, runTaskRefresh } from "./task-refresh.mjs";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com", GIT_CONFIG_NOSYSTEM: "1", HOME: tmpdir() };
function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, env: ENV, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

// A fork of the task and main, as two bare repositories, from one history:
// a base commit, the task's commit on it (`task`), and main's (`main`).
// `files` gives each side's files; null removes one.
function fixture(t, { base = {}, task = {}, main = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "t462-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const work = join(root, "work");
  git(root, "init", "--quiet", "-b", "main", work);
  const commit = (files, message) => {
    for (const [path, text] of Object.entries(files)) {
      if (text === null) git(work, "rm", "--quiet", path);
      else { mkdirSync(dirname(join(work, path)), { recursive: true }); writeFileSync(join(work, path), text); git(work, "add", path); }
    }
    git(work, "commit", "--quiet", "--allow-empty", "-m", message);
    return git(work, "rev-parse", "HEAD");
  };
  const b = commit({ "keep.txt": "keep\n", ...base }, "base");
  const taskHead = commit(task, "task work\n\nAgent: claude-code/opus-5.5");
  git(work, "checkout", "--quiet", "-B", "mainline", b);
  const mainHead = commit(main, "main moved");
  const fork = join(root, "fork.git"), baseline = join(root, "main.git");
  git(root, "init", "--quiet", "--bare", "-b", "main", fork);
  git(root, "init", "--quiet", "--bare", "-b", "main", baseline);
  git(work, "push", "--quiet", fork, `${taskHead}:refs/heads/main`);
  git(work, "push", "--quiet", baseline, `${mainHead}:refs/heads/main`);
  return { root, work, fork, baseline, base: b, task: taskHead, main: mainHead };
}

// The runner's io for the job, with git run for real and the CLI faked:
// `answers[verb]` answers a command (a function of its argv), and every
// call is kept in `calls`.
function harness(f, { job = "task-refresh", actor = job === "task-resolve" ? "claude-code/opus-5.5" : "atelier/integrator", answers = {}, resolve, checks = [], gitFault, renewMs, checking, pushing } = {}) {
  const calls = [], logs = [], reports = [];
  const lease = { id: "L1", job: job === "task-resolve" ? "resolve" : "refresh", by: actor, mainHead: f.main, expectedHead: f.task, ...(checking ? { checking } : {}), ...(pushing ? { pushing } : {}) };
  const flag = (argv, name) => argv[argv.indexOf(name) + 1];
  const defaults = {
    "refresh-lease": (argv) => argv.includes("--renew") ? { lease } : argv.includes("--release") ? { released: true } : argv.includes("--status") ? { head: f.task, lease: true, checking: null } : ({ lease, workspace: { remote: f.fork, token: "w", defaultBranch: "main" }, baseline: { remote: f.baseline, token: "r", defaultBranch: "main" }, checks, commitIdentity: null }),
    "refresh-pushing": () => ({ ...lease, pushing: {} }),
    refreshed: (argv) => ({ result: { outcome: argv.includes("--head") ? "refreshed" : "held", reason: checks.length && argv.includes("--head") ? "checks pending" : null } }),
    "refresh-failed": (argv) => {
      if (argv.includes("--report")) reports.push(JSON.parse(readFileSync(flag(argv, "--report"), "utf8")));
      return { result: { outcome: flag(argv, "--outcome") } };
    },
    "refresh-checked": () => ({ result: { outcome: "refreshed" } }),
    check: () => "PASS  npm test",
  };
  const io = {
    log: (line) => logs.push(line),
    cli: async (argv) => {
      calls.push(argv);
      const answer = (answers[argv[0]] ?? defaults[argv[0]]);
      if (!answer) throw new Error(`unexpected command ${argv[0]}`);
      const out = await answer(argv);
      return typeof out === "string" ? out : JSON.stringify(out);
    },
    git: async (args, { cwd, allowFail = false, raw = false, env } = {}) => {
      if (gitFault?.(args, env)) throw new Error(`git ${args[0]} failed: fatal: bad object`);
      const r = spawnSync("git", args, { cwd, env: ENV, encoding: "utf8" });
      if (allowFail) return { status: r.status, stdout: r.stdout, stderr: r.stderr };
      if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed:\n${r.stderr}`);
      return raw ? r.stdout : r.stdout.trim();
    },
    fetch: async (cwd, remote, token, head) => git(cwd, "fetch", "--quiet", remote, head),
    head: async (cwd) => git(cwd, "rev-parse", "HEAD"),
    isAncestor: async (cwd, a, b) => spawnSync("git", ["merge-base", "--is-ancestor", a, b], { cwd, env: ENV }).status === 0,
    tempDir: async (prefix) => mkdtempSync(join(f.root, prefix)),
    removeTree: async (dir) => rmSync(dir, { recursive: true, force: true }),
    resolveConflicts: async (assignment, cwd, brief) => { calls.push(["resolve", brief]); await resolve(cwd); },
    ...(renewMs ? { leaseRenewMs: renewMs } : {}),
  };
  const assignment = { project: "demo", actor, agent: actor.split("/")[0], model: actor.split("/")[1], item: { id: "t7", head: f.task, dispatch: { job, head: f.main, expectedHead: f.task } } };
  return { io, calls, logs, reports, assignment, verbs: () => calls.map((c) => c[0]), run: () => runTaskRefresh(assignment, { agents: [] }, "home:test", io) };
}

const forkHead = (f) => git(f.root, "--git-dir", f.fork, "rev-parse", "main");
const parents = (f, head) => git(f.root, "--git-dir", f.fork, "rev-list", "--parents", "-n", "1", head).split(" ").slice(1);
const message = (f, head) => git(f.root, "--git-dir", f.fork, "log", "-1", "--format=%B", head).trim();
const IMPORTS = 'import { a } from "./a.ts";\nimport { b } from "./b.ts";\n\nexport const all = [a, b];\n';

test("a clean refresh is merged in a workspace of its own, pushed after it is announced, recorded with the integrator's Agent line, and checked", async (t) => {
  const f = fixture(t, { task: { "task.txt": "task\n" }, main: { "main.txt": "main\n" } });
  const h = harness(f, { checks: ["npm test"] });
  const state = await h.run();
  assert.equal(state.phase, "refreshed");
  assert.deepEqual(h.verbs(), ["refresh-lease", "refresh-pushing", "refreshed", "check", "refresh-checked"]);
  const head = forkHead(f);
  assert.equal(head, state.head);
  assert.deepEqual(parents(f, head), [f.task, f.main]);
  assert.equal(message(f, head), `Merge main at ${f.main.slice(0, 8)} into t7\n\nAgent: atelier/integrator`);
  const refreshed = h.calls.find((c) => c[0] === "refreshed");
  assert.equal(refreshed[refreshed.indexOf("--head") + 1], head);
  assert.equal(refreshed[refreshed.indexOf("--lease") + 1], "L1");
  // The task's own diff is the same before and after: main touched other files.
  assert.equal(refreshed[refreshed.indexOf("--diff-before") + 1], refreshed[refreshed.indexOf("--diff-after") + 1]);
  assert.ok(h.calls.find((c) => c[0] === "refresh-checked").includes("--passed"));
  // The builder's workspace is never used, and the refresh's own is gone.
  assert.ok(!existsSync(join(f.root, "refresh-demo-t7-")));
});

test("a task that already holds main is reported refreshed with no head, and nothing is pushed", async (t) => {
  const f = fixture(t, { main: { "main.txt": "main\n" } });
  git(f.work, "checkout", "--quiet", f.task);
  git(f.work, "merge", "--quiet", "--no-edit", f.main);
  const merged = git(f.work, "rev-parse", "HEAD");
  git(f.work, "push", "--quiet", f.fork, `${merged}:refs/heads/main`);
  const h = harness({ ...f, task: merged });
  assert.equal((await h.run()).held, true);
  assert.deepEqual(h.verbs(), ["refresh-lease", "refreshed"]);
  assert.ok(!h.calls[1].includes("--head"));
  assert.equal(forkHead(f), merged);
});

test("the integrator sends a mechanical conflict to a resolver and pushes nothing", async (t) => {
  const f = fixture(t, { base: { "index.ts": IMPORTS }, task: { "index.ts": IMPORTS.replace('from "./b.ts";\n', 'from "./b.ts";\nimport { task } from "./task.ts";\n') }, main: { "index.ts": IMPORTS.replace('from "./b.ts";\n', 'from "./b.ts";\nimport { main } from "./main.ts";\n') } });
  const h = harness(f);
  const state = await h.run();
  assert.equal(state.recorded, true);
  const failed = h.calls.find((c) => c[0] === "refresh-failed");
  assert.equal(failed[failed.indexOf("--outcome") + 1], "mechanical");
  assert.equal(forkHead(f), f.task);
});

test("a resolver's mechanical resolution is verified, committed under its Agent line and pushed", async (t) => {
  const task = IMPORTS.replace('from "./b.ts";\n', 'from "./b.ts";\nimport { task } from "./task.ts";\n');
  const f = fixture(t, { base: { "index.ts": IMPORTS }, task: { "index.ts": task }, main: { "index.ts": IMPORTS.replace('from "./b.ts";\n', 'from "./b.ts";\nimport { main } from "./main.ts";\n') } });
  const resolved = 'import { a } from "./a.ts";\nimport { b } from "./b.ts";\nimport { main } from "./main.ts";\nimport { task } from "./task.ts";\n\nexport const all = [a, b];\n';
  const h = harness(f, { job: "task-resolve", resolve: (cwd) => writeFileSync(join(cwd, "index.ts"), resolved) });
  const state = await h.run();
  assert.equal(state.phase, "refreshed");
  assert.match(h.calls.find((c) => c[0] === "resolve")[1], /import-union/);
  const head = forkHead(f);
  assert.deepEqual(parents(f, head), [f.task, f.main]);
  assert.match(message(f, head), /\n\nAgent: claude-code\/opus-5\.5$/);
  assert.equal(git(f.root, "--git-dir", f.fork, "show", `${head}:index.ts`), resolved.trimEnd());
  const refreshed = h.calls.find((c) => c[0] === "refreshed");
  assert.equal(refreshed[refreshed.indexOf("--transformations") + 1], "import-union");
});

test("a resolution outside the transformations goes back to the builder and nothing is pushed", async (t) => {
  const f = fixture(t, { base: { "index.ts": IMPORTS }, task: { "index.ts": IMPORTS.replace('from "./b.ts";\n', 'from "./b.ts";\nimport { task } from "./task.ts";\n') }, main: { "index.ts": IMPORTS.replace('from "./b.ts";\n', 'from "./b.ts";\nimport { main } from "./main.ts";\n') } });
  const h = harness(f, { job: "task-resolve", resolve: (cwd) => { writeFileSync(join(cwd, "index.ts"), 'import { a } from "./a.ts";\n\nexport const all = [a];\n'); writeFileSync(join(cwd, "extra.ts"), "x\n"); } });
  const state = await h.run();
  assert.equal(state.returned, true);
  const failed = h.calls.find((c) => c[0] === "refresh-failed");
  assert.equal(failed[failed.indexOf("--outcome") + 1], "returned");
  assert.equal(h.reports[0].kind, "uncertain");
  assert.match(h.reports[0].files[0].why, /not mechanical.*index\.ts/);
  assert.match(failed[failed.indexOf("--reason") + 1], /not mechanical/);
  assert.equal(forkHead(f), f.task);
});

test("a behavioural conflict goes back to the builder with the merge base, both heads, the paths and the hunks", async (t) => {
  const f = fixture(t, { base: { "limit.ts": "export const limit = 10;\n" }, task: { "limit.ts": "export const limit = 20;\n" }, main: { "limit.ts": "export const limit = 30;\n" } });
  const h = harness(f);
  const state = await h.run();
  assert.equal(state.returned, true);
  const [report] = h.reports;
  assert.deepEqual([report.base, report.head, report.main, report.kind], [f.base, f.task, f.main, "behavioural"]);
  assert.equal(report.files[0].path, "limit.ts");
  assert.deepEqual([report.files[0].hunks[0].ours, report.files[0].hunks[0].base, report.files[0].hunks[0].theirs], [["export const limit = 20;"], ["export const limit = 10;"], ["export const limit = 30;"]]);
  assert.equal(forkHead(f), f.task);
  assert.ok(!h.verbs().includes("refresh-pushing"));
});

test("a file the task deleted and main changed is uncertain, and goes back to the builder", async (t) => {
  const f = fixture(t, { base: { "gone.ts": "one\n" }, task: { "gone.ts": null }, main: { "gone.ts": "two\n" } });
  const h = harness(f);
  assert.equal((await h.run()).returned, true);
  assert.equal(h.reports[0].kind, "uncertain");
  assert.match(h.reports[0].files[0].why, /task deleted or renamed/);
});

// t471's t437-after-t426 fixture (test/moved-code.test.mjs): t426 moved the
// report handler to cli/commands/report.mjs and t437 edited it where it was.
// Git merges the edit cleanly into the loader left behind, so once main is
// merged a landing's comparison, whose merge base is then main's head, finds
// nothing: the refresh compares before it merges.
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
const MOVED = { base: { "cli/atelier.mjs": ATELIER }, task: { "cli/atelier.mjs": T437 }, main: { "cli/atelier.mjs": T426, "cli/commands/report.mjs": REPORT } };

for (const job of ["task-refresh", "task-resolve"]) {
  test(`${job}: an edit in code main moved to another file goes back to the builder before the merge, and nothing is pushed (t471)`, async (t) => {
    const f = fixture(t, MOVED);
    // The regression: Git's merge is clean, so without the comparison the
    // refresh would push it and hide the finding from the landing.
    const probe = join(f.root, "probe");
    git(f.root, "clone", "--quiet", f.fork, probe);
    git(probe, "fetch", "--quiet", f.baseline, f.main);
    git(probe, "merge", "--quiet", "--no-edit", f.main);
    const h = harness(f, { job, resolve: () => { throw new Error("no resolver runs on a moved-code finding"); } });
    const state = await h.run();
    assert.deepEqual([state.phase, state.returned, state.recorded], ["failed", true, true]);
    assert.deepEqual(h.verbs(), ["refresh-lease", "refresh-failed"]);
    const failed = h.calls.find((c) => c[0] === "refresh-failed");
    assert.equal(failed[failed.indexOf("--outcome") + 1], "returned");
    assert.match(failed[failed.indexOf("--reason") + 1], /^1 edit in code main moved to another file: cli\/atelier\.mjs .* moved to cli\/commands\/report\.mjs/);
    const [report] = h.reports;
    assert.deepEqual([report.base, report.head, report.main, report.kind], [f.base, f.task, f.main, "behavioural"]);
    assert.deepEqual(report.files.map((x) => x.path), ["cli/atelier.mjs"]);
    assert.match(report.files[0].why, /cli\/commands\/report\.mjs/);
    assert.equal(forkHead(f), f.task);
  });
}

test("a builder's push under the refresh is never overwritten: the refresh's push fails and it is queued again", async (t) => {
  const f = fixture(t, { task: { "task.txt": "task\n" }, main: { "main.txt": "main\n" } });
  let builder;
  const h = harness(f, { answers: { "refresh-pushing": () => {
    git(f.work, "checkout", "--quiet", f.task);
    writeFileSync(join(f.work, "task.txt"), "task, fixed\n");
    git(f.work, "commit", "--quiet", "-am", "fix\n\nAgent: claude-code/opus-5.5");
    builder = git(f.work, "rev-parse", "HEAD");
    git(f.work, "push", "--quiet", f.fork, `${builder}:refs/heads/main`);
    return {};
  } } });
  const state = await h.run();
  assert.equal(state.recorded, true);
  const failed = h.calls.find((c) => c[0] === "refresh-failed");
  assert.equal(failed[failed.indexOf("--outcome") + 1], "superseded");
  assert.equal(forkHead(f), builder);
  assert.ok(!h.verbs().includes("refreshed"));
});

test("a push the server refuses to announce (busy, landing, moved) pushes nothing", async (t) => {
  const f = fixture(t, { task: { "task.txt": "task\n" }, main: { "main.txt": "main\n" } });
  const h = harness(f, { answers: { "refresh-pushing": () => { throw new Error("refresh_deferred: t7 is landing now"); } } });
  await h.run();
  assert.equal(forkHead(f), f.task);
  const failed = h.calls.find((c) => c[0] === "refresh-failed");
  assert.match(failed[failed.indexOf("--reason") + 1], /landing now/);
});

test("checks that fail at the refreshed head are reported, and the task goes back to its builder", async (t) => {
  const f = fixture(t, { task: { "task.txt": "task\n" }, main: { "main.txt": "main\n" } });
  const h = harness(f, { checks: ["npm test"], answers: { check: () => { throw Object.assign(new Error("checks failed"), { code: 2, output: "FAIL  npm test  @ 1234" }); } } });
  const state = await h.run();
  assert.equal(state.phase, "failed");
  const checked = h.calls.find((c) => c[0] === "refresh-checked");
  assert.ok(checked.includes("--failed"));
  assert.match(checked[checked.indexOf("--reason") + 1], /FAIL npm test/);
});

test("a pushed head whose report is refused remains fenced for recovery", async (t) => {
  const f = fixture(t, { task: { "task.txt": "task\n" }, main: { "main.txt": "main\n" } });
  const h = harness(f, { answers: { refreshed: () => { throw new Error("head_moved"); } } });
  const state = await h.run();
  assert.equal(state.phase, "failed");
  assert.equal(h.verbs().filter((v) => v === "refreshed").length, 2);
  assert.notEqual(forkHead(f), f.task);
  assert.deepEqual(released(h), []);
});

test("a recorded refresh whose answer was lost is asked again, not taken back", async (t) => {
  const f = fixture(t, { task: { "task.txt": "task\n" }, main: { "main.txt": "main\n" } });
  let asks = 0;
  const h = harness(f, { answers: { refreshed: () => { if (++asks === 1) throw new Error("socket hang up"); return { replay: true, result: { outcome: "refreshed", reason: null } }; } } });
  const state = await h.run();
  assert.equal(state.phase, "refreshed");
  assert.equal(forkHead(f), state.head);
});

test("a refresh the server recorded though both its answers were lost stays on the fork, and its lease is not given back", async (t) => {
  const f = fixture(t, { task: { "task.txt": "task\n" }, main: { "main.txt": "main\n" } });
  let recordedHead = f.task;
  // The server records the refresh each time; the answers never arrive.
  const h = harness(f, { checks: ["npm test"], answers: { refreshed: (argv) => { recordedHead = argv[argv.indexOf("--head") + 1]; throw new Error("socket hang up"); } } });
  const answer = h.io.cli;
  h.io.cli = async (argv) => {
    if (argv[0] !== "refresh-lease" || !argv.includes("--status")) return answer(argv);
    h.calls.push(argv);
    return JSON.stringify({ head: recordedHead, lease: true, checking: recordedHead });
  };
  const state = await h.run();
  assert.equal(state.phase, "failed");
  assert.notEqual(recordedHead, f.task);
  assert.equal(forkHead(f), recordedHead, "the push the ledger names is not taken back");
  assert.deepEqual(released(h), []);
  assert.ok(h.calls.some((c) => c[0] === "refresh-lease" && c.includes("--status")));
});

test("a push whose recorded head cannot be read is left on the fork rather than taken back", async (t) => {
  const f = fixture(t, { task: { "task.txt": "task\n" }, main: { "main.txt": "main\n" } });
  const h = harness(f, { answers: { refreshed: () => { throw new Error("socket hang up"); } } });
  const answer = h.io.cli;
  h.io.cli = async (argv) => { if (argv[0] === "refresh-lease" && argv.includes("--status")) { h.calls.push(argv); throw new Error("socket hang up"); } return answer(argv); };
  await h.run();
  assert.notEqual(forkHead(f), f.task);
  assert.deepEqual(released(h), []);
});

test("a lease resumed at a recorded head runs only the checks and reports them under it", async (t) => {
  const f = fixture(t, { task: { "task.txt": "task\n" }, main: { "main.txt": "main\n" } });
  const recorded = git(f.root, "--git-dir", f.fork, "rev-parse", "main");
  const h = harness(f, { checks: ["npm test"], checking: recorded });
  const state = await h.run();
  assert.deepEqual(state, { phase: "refreshed", head: recorded });
  assert.deepEqual(h.verbs(), ["refresh-lease", "check", "refresh-checked"]);
  const checked = h.calls.find((c) => c[0] === "refresh-checked");
  assert.equal(checked[checked.indexOf("--expected-head") + 1], f.task);
  assert.ok(checked.includes("--passed"));
  assert.equal(forkHead(f), recorded);
});

test("a refused lease is no failure the runner counts", async (t) => {
  const f = fixture(t, { task: { "task.txt": "task\n" }, main: { "main.txt": "main\n" } });
  const h = harness(f, { answers: { "refresh-lease": () => { throw new Error("refresh_deferred: claude-code/opus-5.5 holds t7"); } } });
  const state = await h.run();
  assert.equal(state.recorded, true);
  assert.deepEqual(h.verbs(), ["refresh-lease"]);
});

const MECHANICAL = { base: { "index.ts": IMPORTS }, task: { "index.ts": IMPORTS.replace('from "./b.ts";\n', 'from "./b.ts";\nimport { task } from "./task.ts";\n') }, main: { "index.ts": IMPORTS.replace('from "./b.ts";\n', 'from "./b.ts";\nimport { main } from "./main.ts";\n') } };
const released = (h) => h.calls.filter((c) => c[0] === "refresh-lease" && c.includes("--release"));

test("a provider's usage limit on the resolver's harness gives the lease back at once, carrying the limit, with nothing pushed or reported", async (t) => {
  const f = fixture(t, MECHANICAL);
  const limit = { reason: "usage limit reached", resetAt: Date.now() + 3_600_000, fallback: false, harness: "claude-code" };
  const h = harness(f, { job: "task-resolve", resolve: () => { throw Object.assign(new Error("claude-code usage limit: usage limit reached"), { providerLimit: limit }); } });
  const state = await h.run();
  // The loop pauses the harness on providerLimit and counts no failure (test/runner-limit.test.mjs).
  assert.deepEqual([state.phase, state.providerLimit], ["failed", limit]);
  assert.ok(!state.recorded);
  const [release] = released(h);
  assert.equal(release[release.indexOf("--release") + 1], "L1");
  assert.ok(release.includes("--provider-limit"));
  assert.match(release[release.indexOf("--reason") + 1], /usage limit reached/);
  assert.ok(!h.verbs().some((v) => ["refresh-failed", "refresh-pushing", "refreshed"].includes(v)));
  assert.equal(forkHead(f), f.task);
  assert.ok(h.logs.some((l) => /released t7's refresh lease; the same work resumes when the provider's limit resets/.test(l)));
});

test("an exception from the moved-code detector is reported as the lease's release, not left holding it", async (t) => {
  const f = fixture(t, { task: { "task.txt": "task\n" }, main: { "main.txt": "main\n" } });
  const h = harness(f, { gitFault: (args, env) => env === DETECTOR_ENV });
  const state = await h.run();
  assert.equal(state.phase, "failed");
  assert.ok(!state.providerLimit && !state.recorded, "an infrastructure failure the loop counts");
  const [release] = released(h);
  assert.ok(release, "the lease is given back");
  assert.ok(!release.includes("--provider-limit"));
  assert.match(release[release.indexOf("--reason") + 1], /^comparing the task's edits with code main moved failed: git .* failed: fatal: bad object/);
  assert.ok(!h.verbs().some((v) => ["refresh-failed", "refresh-pushing", "refreshed"].includes(v)));
  assert.equal(forkHead(f), f.task);
});

test("a refused refresh report never starts a rollback or releases the push fence", async (t) => {
  const f = fixture(t, { task: { "task.txt": "task\n" }, main: { "main.txt": "main\n" } });
  const h = harness(f, { answers: { refreshed: () => { throw new Error("head_moved"); } } });
  await h.run();
  assert.notEqual(forkHead(f), f.task);
  assert.equal(released(h).length, 0);
  assert.ok(!h.verbs().includes("refresh-failed"));
});

test("a recorded outcome is never followed by a release", async (t) => {
  const f = fixture(t, { base: { "limit.ts": "export const limit = 10;\n" }, task: { "limit.ts": "export const limit = 20;\n" }, main: { "limit.ts": "export const limit = 30;\n" } });
  const h = harness(f);
  assert.equal((await h.run()).returned, true);
  assert.deepEqual(released(h), []);
  const g = fixture(t, { task: { "task.txt": "task\n" }, main: { "main.txt": "main\n" } });
  const k = harness(g, { checks: ["npm test"], answers: { check: () => { throw Object.assign(new Error("npm cache refused"), { code: 4 }); } } });
  assert.equal((await k.run()).phase, "failed");
  assert.deepEqual(released(k), [], "a lease checking a recorded head is not given back");
});

test("the lease is renewed while a long run holds it, and no longer once the job ends", async (t) => {
  const f = fixture(t, MECHANICAL);
  const resolved = 'import { a } from "./a.ts";\nimport { b } from "./b.ts";\nimport { main } from "./main.ts";\nimport { task } from "./task.ts";\n\nexport const all = [a, b];\n';
  // A resolver's harness and checks that outlast several renewal intervals.
  const h = harness(f, { job: "task-resolve", renewMs: 5, checks: ["npm test"],
    resolve: async (cwd) => { await sleep(60); writeFileSync(join(cwd, "index.ts"), resolved); },
    answers: { check: async () => { const before = renewals(); await sleep(60); assert.ok(renewals() > before, "renewed during the checks"); return "PASS  npm test"; } } });
  const renewals = () => h.calls.filter((c) => c[0] === "refresh-lease" && c.includes("--renew")).length;
  const resolveAt = () => h.calls.findIndex((c) => c[0] === "resolve");
  const state = await h.run();
  assert.equal(state.phase, "refreshed");
  const renew = h.calls.find((c) => c.includes("--renew"));
  assert.equal(renew[renew.indexOf("--renew") + 1], "L1");
  assert.ok(h.calls.slice(resolveAt()).some((c) => c.includes("--renew")), "renewed during the resolver's run");
  const after = renewals();
  await sleep(30);
  assert.equal(renewals(), after, "the renewal stops with the job");
  assert.deepEqual(released(h), []);
});

test("a renewal that fails is said, and the job goes on", async (t) => {
  const f = fixture(t, MECHANICAL);
  const resolved = 'import { a } from "./a.ts";\nimport { b } from "./b.ts";\nimport { main } from "./main.ts";\nimport { task } from "./task.ts";\n\nexport const all = [a, b];\n';
  let lease;
  const h = harness(f, { job: "task-resolve", renewMs: 5, resolve: async (cwd) => { await sleep(40); writeFileSync(join(cwd, "index.ts"), resolved); },
    answers: { "refresh-lease": (argv) => { if (argv.includes("--renew")) throw new Error("socket hang up"); return lease; } } });
  lease = { lease: { id: "L1", job: "resolve", by: "claude-code/opus-5.5", mainHead: f.main, expectedHead: f.task }, workspace: { remote: f.fork, token: "w", defaultBranch: "main" }, baseline: { remote: f.baseline, token: "r", defaultBranch: "main" }, checks: [], commitIdentity: null };
  assert.equal((await h.run()).phase, "refreshed");
  assert.ok(h.logs.some((l) => l === "renewing t7's refresh lease failed: socket hang up"));
});

test("the diff identity ignores line numbers and blob ids", () => {
  const a = "diff --git a/x b/x\nindex 111..222 100644\n@@ -1,2 +1,2 @@\n-a\n+b\n";
  const b = "diff --git a/x b/x\nindex 333..444 100644\n@@ -9,2 +9,2 @@\n-a\n+b\n";
  assert.equal(diffIdentity(a), diffIdentity(b));
  assert.notEqual(diffIdentity(a), diffIdentity(a.replace("+b", "+c")));
  assert.equal(diffIdentity(""), null);
});

for (const outcome of ["pushed", "not-pushed", "moved", "unreachable"]) {
  test(`reconcile a crashed push: ${outcome}`, async (t) => {
    const f = fixture(t, { task: { "task.txt": "task\n" }, main: { "main.txt": "main\n" } });
    const first = harness(f);
    const head = (await first.run()).head;
    if (outcome === "not-pushed") git(f.work, "push", "--quiet", "--force", f.fork, `${f.task}:refs/heads/main`);
    if (outcome === "moved") git(f.work, "push", "--quiet", "--force", f.fork, `${f.main}:refs/heads/main`);
    const h = harness(f, { checks: ["npm test"], pushing: { head, until: new Date(0).toISOString() }, gitFault: (args) => outcome === "unreachable" && args[0] === "ls-remote" });
    await h.run();
    assert.ok(!h.verbs().includes("refresh-pushing"));
    if (outcome === "pushed") {
      assert.deepEqual(h.verbs(), ["refresh-lease", "refreshed", "check", "refresh-checked"]);
      assert.equal(forkHead(f), head);
    } else if (outcome === "unreachable") {
      assert.ok(!h.verbs().includes("refresh-failed"));
      assert.equal(forkHead(f), head);
    } else {
      assert.deepEqual(h.verbs(), ["refresh-lease", "refresh-failed"]);
    }
  });
}

test("pushes have a bounded execution timeout", async (t) => {
  const f = fixture(t, { task: { "task.txt": "task\n" }, main: { "main.txt": "main\n" } });
  const h = harness(f);
  const run = h.io.git;
  let pushes = 0;
  h.io.git = (args, options) => {
    if (args[0] === "push") { pushes++; assert.equal(options.timeoutMs, 120000); }
    return run(args, options);
  };
  await h.run();
  assert.equal(pushes, 1);
});

for (const timeout of [false, true]) test(`a push that changes the fork then ${timeout ? "times out" : "returns an error"} retains its check obligation`, async (t) => {
  const f = fixture(t, { task: { "task.txt": "task\n" }, main: { "main.txt": "main\n" } });
  const h = harness(f, { checks: ["npm test"] });
  const run = h.io.git;
  h.io.git = async (args, options) => {
    const result = await run(args, options);
    if (args[0] !== "push") return result;
    if (timeout) throw new Error("git push timed out");
    return { status: 1, stderr: "remote hung up after receiving the commit" };
  };
  await h.run();
  assert.notEqual(forkHead(f), f.task);
  assert.deepEqual(released(h), []);
  assert.ok(!h.verbs().includes("refresh-failed"));
  if (!timeout) assert.deepEqual(h.verbs().slice(-3), ["refreshed", "check", "refresh-checked"]);
});
