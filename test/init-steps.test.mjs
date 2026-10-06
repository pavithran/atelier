import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PUSH_STEP, pushHistory, refusedForSize } from "../cli/push-steps.mjs";

// atelier init pushes a project's history to its new baseline. When Artifacts
// refuses the push for size or time, the history goes in steps of about 700
// commits, and a step that fails says which commit the baseline holds so
// running init again resumes from it. A local bare repository stands in for
// Artifacts: its pre-receive hook refuses a push that brings more commits than
// the file `limit` allows, and, once the file `budget` counts down to zero,
// every push as timed out. Every decision is logged in the file `log`.

const cli = resolve("cli/atelier.mjs");
const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };

function git(args, opts = {}) {
  const r = spawnSync("git", args, { encoding: "utf8", cwd: opts.cwd, env: GIT_ENV });
  if (opts.allowFail) return r;
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

// A repository whose main line holds `count` commits, with a side branch of
// three commits merged in at each position in `merges`: the first-parent line
// is `count` commits long and the repository holds three more for each merge.
// The first side branch is unrelated to main's history; the others start from
// the main commit before their merge.
function history(dir, count, merges = [], stamp = 1_700_000_000) {
  let stream = "", mark = 0;
  const commit = (ref, message, extra = "") => {
    mark += 1;
    stream += `commit ${ref}\nmark :${mark}\ncommitter Test <test@example.invalid> ${stamp++} +0000\ndata ${message.length}\n${message}\n${extra}M 644 inline f.txt\ndata ${String(mark).length}\n${mark}\n\n`;
    return mark;
  };
  for (let i = 1; i <= count; i++) {
    if (merges.includes(i)) {
      commit("refs/heads/side", `side ${i} a`, i === merges[0] ? "" : `from :${mark}\n`);
      commit("refs/heads/side", `side ${i} b`);
      const tip = commit("refs/heads/side", `side ${i} c`);
      commit("refs/heads/main", `merge ${i}`, `merge :${tip}\n`);
    } else commit("refs/heads/main", `commit ${i}`);
  }
  git(["init", "-q", "-b", "main", dir]);
  const r = spawnSync("git", ["fast-import", "--quiet"], { cwd: dir, input: stream, encoding: "utf8", env: GIT_ENV });
  assert.equal(r.status, 0, r.stderr);
  git(["config", "user.name", "Test"], { cwd: dir });
  git(["config", "user.email", "test@example.invalid"], { cwd: dir });
  git(["reset", "-q", "--hard", "main"], { cwd: dir });
}

const HOOK = `#!/bin/sh
limit=$(cat limit 2>/dev/null || echo 1000000)
while read old new ref; do
  n=$(git rev-list --count "$new" --not --all)
  if [ -f deny ]; then echo "$old $new $n refused deny" >> log; echo "denied: the token may not push here" >&2; exit 1; fi
  if [ "$n" -gt "$limit" ]; then echo "$old $new $n refused size" >> log; echo "push too large: $n commits, the limit is $limit" >&2; exit 1; fi
  if [ -f budget ]; then
    left=$(cat budget)
    if [ "$left" -le 0 ]; then echo "$old $new $n refused time" >> log; echo "the request timed out" >&2; exit 1; fi
    echo $((left - 1)) > budget
  fi
  echo "$old $new $n accepted" >> log
done
`;

// A checkout holding `count` commits, and a bare baseline that refuses a push
// of more than `limit` commits.
function scenario(t, { count, limit, merges = [] }) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-steps-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const checkout = join(dir, "demo"), baseline = join(dir, "baseline.git");
  history(checkout, count, merges);
  git(["init", "-q", "--bare", "-b", "main", baseline]);
  mkdirSync(join(baseline, "hooks"), { recursive: true });
  writeFileSync(join(baseline, "hooks", "pre-receive"), HOOK, { mode: 0o755 });
  git(["config", "core.hooksPath", join(baseline, "hooks")], { cwd: baseline });
  // A push of thousands of commits would start a background gc that writes into the folder as the test removes it.
  git(["config", "receive.autogc", "false"], { cwd: baseline });
  writeFileSync(join(baseline, "limit"), String(limit));
  const decisions = () => (existsSync(join(baseline, "log")) ? readFileSync(join(baseline, "log"), "utf8").trim().split("\n").filter(Boolean).map((l) => {
    const [old, next, commits, outcome, why] = l.split(" ");
    return { old, new: next, commits: Number(commits), outcome, why };
  }) : []);
  const tip = () => git(["rev-parse", "--verify", "-q", "refs/heads/main"], { cwd: baseline, allowFail: true }).stdout.trim() || null;
  const set = (file, value) => writeFileSync(join(baseline, file), String(value));
  return { dir, checkout, baseline, decisions, tip, set, clear: (file) => rmSync(join(baseline, file), { force: true }) };
}

const ZERO = "0".repeat(40);
const TOKEN = "baseline-secret-token-1";
const onLine = (checkout, n) => git(["rev-list", "--first-parent", "--reverse", "main"], { cwd: checkout }).split("\n")[n - 1];

test("a push refused for size or time is told apart from one that would fail again at every step", () => {
  for (const text of [
    "error: RPC failed; HTTP 413 curl 22 The requested URL returned error: 413",
    "fatal: unable to access 'https://x.test/r.git/': The requested URL returned error: 504",
    "error: RPC failed; HTTP 524 curl 22 The requested URL returned error: 524",
    "remote: push too large: 1700 commits, the limit is 1000",
    "remote: the pack exceeds the repository's size limit",
    "fatal: pack exceeds maximum allowed size",
    "error: RPC failed; curl 28 Operation timed out after 300000 milliseconds",
    "send-pack: unexpected disconnect while reading sideband packet\nfatal: the remote end hung up unexpectedly",
  ]) assert.equal(refusedForSize(text), true, text);
  for (const text of [
    "remote: Authentication failed",
    "fatal: unable to access 'https://x.test/r.git/': The requested URL returned error: 401",
    "fatal: unable to access 'https://x.test/r.git/': The requested URL returned error: 403",
    " ! [rejected]        main -> main (non-fast-forward)",
    " ! [rejected]        main -> main (fetch first)",
    "fatal: unable to access 'https://x.test/r.git/': Could not resolve host: x.test",
    " ! [remote rejected] main -> main (pre-receive hook declined)",
    "error: src refspec main does not match any",
    "",
  ]) assert.equal(refusedForSize(text), false, text);
});

test("a history too large for one push goes in steps of 700 commits, each a fast-forward", (t) => {
  const s = scenario(t, { count: 2500, limit: 1000, merges: [300, 900] });
  const lines = [];
  pushHistory(git, s.checkout, { remote: s.baseline, token: TOKEN, branch: "main", say: (line) => lines.push(line) });
  assert.equal(s.tip(), git(["rev-parse", "main"], { cwd: s.checkout }));
  const log = s.decisions();
  assert.deepEqual(log.map((d) => [d.outcome, d.why ?? null]), [["refused", "size"], ["accepted", null], ["accepted", null], ["accepted", null], ["accepted", null]]);
  // The steps are the first-parent commits 700, 1400, 2100 and the head, oldest first.
  const accepted = log.filter((d) => d.outcome === "accepted");
  assert.deepEqual(accepted.map((d) => d.new), [onLine(s.checkout, 700), onLine(s.checkout, 1400), onLine(s.checkout, 2100), onLine(s.checkout, 2500)]);
  // Each step starts from the commit the last one reached: a fast-forward.
  assert.deepEqual(accepted.map((d) => d.old), [ZERO, ...accepted.slice(0, -1).map((d) => d.new)]);
  // A step brings about 700 commits: its first-parent commits and what they merged in.
  for (const d of accepted) assert.ok(d.commits <= 1000, `${d.commits} commits in a step`);
  for (const d of accepted.slice(0, 3)) assert.ok(d.commits >= 700, `${d.commits} commits in a step`);
  assert.equal(PUSH_STEP, 700);
  // Progress is one line per step, after the refusal and the plan.
  assert.match(lines[0], /^The push of main's history in one piece was refused:\n  remote: push too large/);
  assert.match(lines[1], /^Pushing the first-parent history of main, 2500 commits, in 4 steps of about 700 commits, oldest first\.$/);
  assert.deepEqual(lines.slice(2).map((l) => l.replace(/\([0-9a-f]{8}\)/, "(id)")), [
    "Step 1 of 4: the baseline holds main up to commit 700 of 2500 (id).",
    "Step 2 of 4: the baseline holds main up to commit 1400 of 2500 (id).",
    "Step 3 of 4: the baseline holds main up to commit 2100 of 2500 (id).",
    "Step 4 of 4: the baseline holds main up to commit 2500 of 2500 (id).",
  ]);
});

test("a step that fails says which commit the baseline holds, and running again resumes from it", (t) => {
  const s = scenario(t, { count: 2500, limit: 1000 });
  s.set("budget", 1);
  const lines = [];
  assert.throws(
    () => pushHistory(git, s.checkout, { remote: s.baseline, token: TOKEN, branch: "main", say: (line) => lines.push(line) }),
    (error) => {
      const reached = onLine(s.checkout, 700);
      assert.ok(error.message.startsWith("the push for step 2 of 4 (commit 1400 of 2500 on main's first-parent line) failed.\n"), error.message);
      assert.ok(error.message.includes(`The baseline holds main up to commit 700 of 2500: ${reached}.\nRun atelier init again, with the same options, to resume from there.\n`), error.message);
      assert.match(error.message, /git said:\n  remote: the request timed out/);
      return true;
    },
  );
  assert.equal(s.tip(), onLine(s.checkout, 700));
  assert.equal(lines.filter((l) => l.startsWith("Step ")).length, 1);

  // Run again: the baseline holds the first 700 commits, the rest is still
  // over the limit as one push, and the steps begin after the first.
  s.clear("budget");
  rmSync(join(s.baseline, "log"));
  const again = [];
  pushHistory(git, s.checkout, { remote: s.baseline, token: TOKEN, branch: "main", say: (line) => again.push(line) });
  assert.equal(s.tip(), git(["rev-parse", "main"], { cwd: s.checkout }));
  const log = s.decisions();
  assert.deepEqual(log.map((d) => d.outcome), ["refused", "accepted", "accepted", "accepted"]);
  assert.equal(log[0].old, onLine(s.checkout, 700));
  assert.deepEqual(log.slice(1).map((d) => [d.old, d.new]), [
    [onLine(s.checkout, 700), onLine(s.checkout, 1400)],
    [onLine(s.checkout, 1400), onLine(s.checkout, 2100)],
    [onLine(s.checkout, 2100), onLine(s.checkout, 2500)],
  ]);
  assert.match(again[1], /^The baseline already holds main up to commit 700 of 2500 \([0-9a-f]{8}\)\. Pushing the rest of the first-parent history in 3 steps of about 700 commits, oldest first\.$/);
  assert.equal(again.filter((l) => l.startsWith("Step ")).length, 3);
});

test("a first step that fails says the baseline holds nothing yet", (t) => {
  const s = scenario(t, { count: 1600, limit: 1000 });
  s.set("budget", 0);
  assert.throws(
    () => pushHistory(git, s.checkout, { remote: s.baseline, token: TOKEN, branch: "main", say: () => {} }),
    (error) => {
      assert.match(error.message, /^the push for step 1 of 3 \(commit 700 of 1600 on main's first-parent line\) failed\.\nThe baseline holds none of main's history yet\.\nRun atelier init again, with the same options, to try from the first step\.\n/);
      return true;
    },
  );
  assert.equal(s.tip(), null);
});

test("a push that fails for another reason is not repeated in steps", (t) => {
  const s = scenario(t, { count: 1600, limit: 1000 });
  s.set("deny", "");
  assert.throws(
    () => pushHistory(git, s.checkout, { remote: s.baseline, token: TOKEN, branch: "main", say: () => assert.fail("no steps") }),
    /^Error: git push --quiet --recurse-submodules=no .* main:main failed:\n[^]*denied: the token may not push here/,
  );
  assert.equal(s.decisions().length, 1);
  assert.equal(s.tip(), null);
});

test("a history no longer than one step has no steps to take, so the refusal stands", (t) => {
  const s = scenario(t, { count: 300, limit: 100 });
  assert.throws(
    () => pushHistory(git, s.checkout, { remote: s.baseline, token: TOKEN, branch: "main", say: () => assert.fail("no steps") }),
    /main:main failed:\n[^]*push too large: 300 commits/,
  );
  assert.equal(s.decisions().length, 1);
});

test("the baseline token is cut out of what a failure says", () => {
  const leaky = (args) => (args[0] === "push" ? { status: 1, stdout: "", stderr: `fatal: could not read ${TOKEN}: HTTP 401` } : { status: 0, stdout: "", stderr: "" });
  assert.throws(
    () => pushHistory(leaky, "/nowhere", { remote: "https://x.test/r", token: TOKEN, branch: "main", say: () => {} }),
    (error) => error.message.includes("could not read [redacted]: HTTP 401") && !error.message.includes(TOKEN),
  );
});

// A pre-push hook in the checkout, with the file `pre-push.log` counting its runs.
function prePushHook(s, body = "") {
  const hooks = join(s.checkout, ".git", "hooks");
  mkdirSync(hooks, { recursive: true });
  git(["config", "core.hooksPath", hooks], { cwd: s.checkout });
  writeFileSync(join(hooks, "pre-push"), `#!/bin/sh\necho ran >> "${join(s.dir, "pre-push.log")}"\n${body}\n`, { mode: 0o755 });
  return () => (existsSync(join(s.dir, "pre-push.log")) ? readFileSync(join(s.dir, "pre-push.log"), "utf8").trim().split("\n").length : 0);
}

// The git helper with every command run for real, except that the nth push is
// reported as a gateway timeout, after it has run, when `fails(n)` says so, and
// the nth ls-remote is reported as unreadable when `unreadable(n)` says so.
function flaky({ fails = () => false, unreadable = () => false } = {}) {
  let pushes = 0, reads = 0;
  return (args, opts) => {
    if (args[0] === "ls-remote" && unreadable(++reads)) return { status: 128, stdout: "", stderr: "fatal: unable to access 'https://x.test/r.git/': Could not resolve host: x.test" };
    const r = git(args, opts);
    if (args[0] === "push" && fails(++pushes)) return { status: 1, stdout: "", stderr: "error: RPC failed; HTTP 504 curl 22 The requested URL returned error: 504" };
    return r;
  };
}

// The first push is refused for size whatever the baseline holds, so the
// steps' own decisions can be seen on a baseline whose branch is not an
// ancestor of the checkout's.
const refuseFirstPush = () => {
  let refused = false;
  return (args, opts) => {
    if (args[0] === "push" && !refused) { refused = true; return { status: 1, stdout: "", stderr: "remote: push too large" }; }
    return git(args, opts);
  };
};

test("a baseline branch that is not part of this history is not stepped over", (t) => {
  const s = scenario(t, { count: 1600, limit: 1000 });
  const other = join(s.dir, "other");
  history(other, 5, [], 1_600_000_000);
  git(["push", "-q", s.baseline, "main"], { cwd: other });
  s.clear("log");
  assert.throws(
    () => pushHistory(refuseFirstPush(), s.checkout, { remote: s.baseline, token: TOKEN, branch: "main", say: () => assert.fail("no steps") }),
    /main:main failed:\n  *remote: push too large|main:main failed:\nremote: push too large/,
  );
  assert.deepEqual(s.decisions(), []);
  assert.equal(s.tip(), git(["rev-parse", "main"], { cwd: other }));
});

test("a baseline branch that came in by a merge's second parent is continued from, and the first step is the first commit that holds it", (t) => {
  const s = scenario(t, { count: 2500, limit: 1500, merges: [900] });
  // The side branch is unrelated to main until the merge at commit 900, so
  // the baseline holds a commit that is not on the first-parent line.
  const side = git(["rev-parse", "side"], { cwd: s.checkout });
  git(["push", "-q", s.baseline, "side:main"], { cwd: s.checkout });
  s.clear("log");
  pushHistory(git, s.checkout, { remote: s.baseline, token: TOKEN, branch: "main", say: () => {} });
  assert.equal(s.tip(), git(["rev-parse", "main"], { cwd: s.checkout }));
  // Commit 700 does not hold the side branch's tip, so the first step is 1400.
  assert.deepEqual(s.decisions().filter((d) => d.outcome === "accepted").map((d) => [d.old, d.new]), [
    [side, onLine(s.checkout, 1400)],
    [onLine(s.checkout, 1400), onLine(s.checkout, 2100)],
    [onLine(s.checkout, 2100), onLine(s.checkout, 2500)],
  ]);
});

// The CLI, against a fake Atelier server whose project answers with the local
// bare repository as its baseline.
function cliFixture(t, options) {
  const s = scenario(t, options);
  const hookRuns = prePushHook(s, options.hook);
  writeFileSync(join(s.dir, "config.json"), JSON.stringify({ server: "https://fake.invalid", owner: "owner", ownerName: "Pavi", projects: {} }));
  const preload = join(s.dir, "server.mjs");
  writeFileSync(preload, `
globalThis.fetch = async (url, options = {}) => {
  const path = new URL(url).pathname, method = options.method ?? "GET";
  const project = { name: "demo", title: null, repo: "demo", policy: { checks: [], protected: [], eligible: [], refuseOverlap: false, sandboxOnly: false } };
  const data = path === "/api/config" ? { ownerActor: "owner", ownerName: "Pavi" }
    : method === "PUT" ? { project, baseline: { remote: ${JSON.stringify(s.baseline)}, token: "fake-baseline-token", defaultBranch: "main" } } : {};
  return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
};
`);
  const run = (args = []) => spawnSync(process.execPath, ["--import", preload, cli, "init", ...args], {
    cwd: s.checkout, encoding: "utf8",
    env: { ...GIT_ENV, ATELIER_CONFIG_DIR: s.dir, ATELIER_CACHE: join(s.dir, "cache"), ATELIER_TOKEN: "fake-owner-token", ATELIER_SERVER: "https://fake.invalid", ATELIER_ACTOR: "owner" },
  });
  const registered = () => JSON.parse(readFileSync(join(s.dir, "config.json"), "utf8")).projects.demo;
  return { ...s, run, hookRuns, registered };
}

test("atelier init pushes a large history in steps and registers the project", (t) => {
  const f = cliFixture(t, { count: 2500, limit: 1000, merges: [300, 900] });
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  const head = git(["rev-parse", "main"], { cwd: f.checkout });
  assert.equal(f.tip(), head);
  assert.match(r.stdout, /The push of main's history in one piece was refused:/);
  assert.match(r.stdout, /Pushing the first-parent history of main, 2500 commits, in 4 steps of about 700 commits, oldest first\./);
  assert.match(r.stdout, /Step 1 of 4: the baseline holds main up to commit 700 of 2500/);
  assert.match(r.stdout, /Step 4 of 4: the baseline holds main up to commit 2500 of 2500/);
  assert.match(r.stdout, new RegExp(`baseline demo now holds main @ ${head.slice(0, 8)}`));
  assert.equal(f.registered().branch, "main");
  // The pre-push hook ran for the whole push and again for each of the four steps.
  assert.equal(f.hookRuns(), 5);
});

test("atelier init that stops partway says where, and the next init resumes", (t) => {
  const f = cliFixture(t, { count: 2500, limit: 1000 });
  f.set("budget", 2);
  const failed = f.run();
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /Step 2 of 4: the baseline holds main up to commit 1400 of 2500/);
  const reached = onLine(f.checkout, 1400);
  assert.ok(failed.stderr.includes(`atelier: the push for step 3 of 4 (commit 2100 of 2500 on main's first-parent line) failed.\nThe baseline holds main up to commit 1400 of 2500: ${reached}.\nRun atelier init again, with the same options, to resume from there.\n`), failed.stderr);
  assert.equal(f.tip(), reached);
  assert.equal(f.registered(), undefined, "a project whose baseline is incomplete is not registered");

  f.clear("budget");
  rmSync(join(f.baseline, "log"));
  const resumed = f.run();
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.stdout, /The baseline already holds main up to commit 1400 of 2500/);
  assert.match(resumed.stdout, /in 2 steps of about 700 commits/);
  assert.equal(f.tip(), git(["rev-parse", "main"], { cwd: f.checkout }));
  assert.deepEqual(f.decisions().filter((d) => d.outcome === "accepted").map((d) => d.old), [reached, onLine(f.checkout, 2100)]);
  assert.equal(f.registered().branch, "main");
});

test("atelier init pushes a history the baseline takes in one push as before", (t) => {
  const f = cliFixture(t, { count: 40, limit: 1000 });
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /Step \d/);
  assert.equal(f.tip(), git(["rev-parse", "main"], { cwd: f.checkout }));
  assert.equal(f.decisions().length, 1);
});

for (const message of ["file exceeds the 50 MB limit", "test suite failed: Test timed out in 5000ms"]) {
  test(`a pre-push hook that refuses with "${message}" is not stepped past`, (t) => {
    const s = scenario(t, { count: 1600, limit: 1000000 });
    const runs = prePushHook(s, `echo "${message}" >&2\nexit 1`);
    assert.throws(
      () => pushHistory(git, s.checkout, { remote: s.baseline, token: TOKEN, branch: "main", say: () => {} }),
      (error) => error.message.includes(message) && /the push for step 1 of 3 /.test(error.message) && error.message.includes("The baseline holds none of main's history yet."),
    );
    // The hook ran for the whole push and for the first step, and refused both:
    // nothing reached the baseline.
    assert.equal(runs(), 2);
    assert.deepEqual(s.decisions(), []);
    assert.equal(s.tip(), null);
  });

  test(`atelier init dies with the pre-push hook's refusal "${message}" and pushes nothing`, (t) => {
    const f = cliFixture(t, { count: 1600, limit: 1000000, hook: `echo "${message}" >&2\nexit 1` });
    const r = f.run();
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes(message), r.stderr);
    assert.deepEqual(f.decisions(), []);
    assert.equal(f.tip(), null);
    assert.equal(f.registered(), undefined);
  });
}

test("a push reported as failed after the baseline took it all counts as pushed", (t) => {
  const s = scenario(t, { count: 300, limit: 1000 });
  const lines = [];
  pushHistory(flaky({ fails: (n) => n === 1 }), s.checkout, { remote: s.baseline, token: TOKEN, branch: "main", say: (line) => lines.push(line) });
  assert.equal(s.tip(), git(["rev-parse", "main"], { cwd: s.checkout }));
  assert.equal(s.decisions().length, 1);
  assert.match(lines.join("\n"), /The push was reported as failed, but the baseline holds main at [0-9a-f]{8}: nothing is left to push\./);
  assert.doesNotMatch(lines.join("\n"), /Step \d/);
});

test("a step reported as failed after the baseline took it counts as done", (t) => {
  const s = scenario(t, { count: 2500, limit: 1000 });
  const lines = [];
  // The first push is the whole history, refused for size; the second is step 1.
  pushHistory(flaky({ fails: (n) => n === 2 }), s.checkout, { remote: s.baseline, token: TOKEN, branch: "main", say: (line) => lines.push(line) });
  assert.equal(s.tip(), git(["rev-parse", "main"], { cwd: s.checkout }));
  assert.equal(lines.filter((l) => l.startsWith("Step ")).length, 4);
  assert.deepEqual(s.decisions().filter((d) => d.outcome === "accepted").map((d) => d.new).slice(0, 2), [onLine(s.checkout, 700), onLine(s.checkout, 1400)]);
});

test("a baseline that cannot be read after a refusal is said so, not taken to hold nothing", (t) => {
  const s = scenario(t, { count: 2500, limit: 1000 });
  assert.throws(
    () => pushHistory(flaky({ unreadable: () => true }), s.checkout, { remote: s.baseline, token: TOKEN, branch: "main", say: () => assert.fail("no steps") }),
    (error) => {
      assert.match(error.message, /main:main failed:\n[^]*push too large/);
      assert.match(error.message, /The baseline's main could not be read afterwards, so the steps cannot start from what it holds\. git said:\n  fatal: unable to access '[^']*': Could not resolve host: x\.test/);
      assert.doesNotMatch(error.message, /holds none/);
      return true;
    },
  );
  assert.equal(s.decisions().length, 1);
});

test("a step that fails when the baseline cannot be read says what it could not check", (t) => {
  const s = scenario(t, { count: 2500, limit: 1000 });
  s.set("budget", 1);
  assert.throws(
    () => pushHistory(flaky({ unreadable: (n) => n === 2 }), s.checkout, { remote: s.baseline, token: TOKEN, branch: "main", say: () => {} }),
    (error) => {
      assert.ok(error.message.startsWith("the push for step 2 of 4 "), error.message);
      assert.ok(error.message.includes(`The baseline holds main up to commit 700 of 2500: ${onLine(s.checkout, 700)}.`), error.message);
      assert.match(error.message, /Reading the baseline's main afterwards failed too, so this may be less than it holds\. git said:\n  fatal: unable to access/);
      assert.match(error.message, /git said:\n  remote: the request timed out/);
      return true;
    },
  );
});
