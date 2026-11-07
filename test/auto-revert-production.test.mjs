import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { executePostMerge, recoverFailedLanding } from "../cli/post-merge.mjs";
import { parsePostMerge, reservePostMerge, preparePostMerge, startAttempt, finishAttempt, recordCommand } from "../src/post-merge.ts";
// No test reads this Mac's own iCloud folder (t645).
process.env.ATELIER_PRIVATE_ROOT ||= `${process.env.TMPDIR || "/tmp"}/atelier-tests-no-icloud-${process.pid}`;

// The production path end to end: executePostMerge runs the suite in a clone,
// and its default recovery (recoverFailedLanding) reverts in a real checkout and
// pushes to a real bare remote. Only the server (a state machine over
// src/post-merge.ts) and the ntfy request are stood in for.
const at = "2026-11-07T12:00:00Z";
const IDENTITY = { GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.test" };

function world(t, { steps, red = true }) {
  const root = mkdtempSync(join(tmpdir(), "atelier-auto-revert-prod-"));
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; rmSync(root, { recursive: true, force: true }); });
  const sh = (cwd, args, extra = {}) => {
    const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, ...IDENTITY, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } });
    if (extra.allowFail) return r;
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const origin = join(root, "origin.git"), work = join(root, "work"), outside = join(root, "outside");
  mkdirSync(outside);
  sh(root, ["init", "-q", "--bare", "-b", "main", origin]);
  sh(root, ["clone", "-q", origin, work]);
  sh(work, ["checkout", "-q", "-b", "main"]);
  writeFileSync(join(work, "f"), "good\n"); sh(work, ["add", "."]); sh(work, ["commit", "-qm", "base"]);
  const before = sh(work, ["rev-parse", "HEAD"]);
  sh(work, ["checkout", "-q", "-b", "feat"]);
  writeFileSync(join(work, "f"), red ? "bad\n" : "good\n"); writeFileSync(join(work, "g"), "gate\n"); sh(work, ["add", "."]); sh(work, ["commit", "-qm", "feat"]);
  sh(work, ["checkout", "-q", "main"]); sh(work, ["merge", "--no-ff", "-qm", "merge t7", "feat"]);
  sh(work, ["push", "-q", "origin", "main"]);
  sh(work, ["branch", "--set-upstream-to=origin/main", "main"]);
  const merge = sh(work, ["rev-parse", "HEAD"]);

  const policy = parsePostMerge({ version: 1, steps: steps(outside).map(s => ({ class: "check", when: "always", protect: ["package.json"], timeoutMs: 20000, ...s })), approval: { reason: "owner authorizes these commands" } }, "owner", at);
  const run = reservePostMerge(policy, ["t7"], before, "run-1", at);
  run.after = merge; preparePostMerge(run, []);

  const log = [], sent = [];
  let counter = 0, failNext = {}, ntfy = () => new Response("ok");
  globalThis.fetch = async request => { sent.push(request); return ntfy(request); };
  const request = async (method, path, body) => {
    log.push({ method, path, body });
    const hit = Object.keys(failNext).find(k => `${method} ${path}`.endsWith(k) && failNext[k] > 0);
    if (hit) { failNext[hit]--; throw new Error(`${hit} refused`); }
    if (path.endsWith("/post-merge/t7")) {
      if (method === "GET") return { run: structuredClone(run) };
      if (body.action === "start") startAttempt(run, `a${++counter}`, at);
      else if (body.action === "command") recordCommand(run, body.attempt, body.passed, body.publication);
      else if (body.action === "finish") finishAttempt(run, body.attempt, body.passed, body.output, at, undefined, body.commandOutcome);
      return { run: structuredClone(run) };
    }
    if (path.endsWith("/git-token")) return { remote: origin, token: "" };
    if (path.endsWith("/landing-lease")) return method === "GET" ? { lease: null } : { ok: true };
    if (path.endsWith("/items") && method === "POST") return { id: `t${99 + log.filter(l => l.path.endsWith("/items") && l.method === "POST").length}` };
    if (path.endsWith("/items/t7")) return { item: { id: "t7", owner: "claude-code/sonnet-5.5" } };
    if (path === "/projects/p") return { project: { policy: {} } };
    return {};
  };
  // The CLI's landingGit, with a commit identity this test owns.
  const landingGit = (args, opts = {}) => {
    const r = sh(opts.cwd, args, { allowFail: true });
    if (opts.allowFail) return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  const deps = { cfg: { projects: { p: { path: work, branch: "main" } } }, landingGit, entryPath: e => e.path, server: () => "https://atelier.test" };
  const env = { PATH: process.env.PATH, HOME: root, ATELIER_NTFY_TOPIC: "pavi-topic" };
  const prints = [];
  // One executor process: a restart is another call over the same saved state.
  const execute = (over = {}) => executePostMerge({ request, name: "p", id: "t7", env, print: line => prints.push(line), recover: a => recoverFailedLanding({ ...a, deps }), ...over });
  return {
    root, origin, work, outside, merge, run, log, sent, prints, execute, sh,
    failNext: (key, n = 1) => { failNext[key] = n; },
    ntfy: fn => { ntfy = fn; },
    originHead: () => sh(origin, ["rev-parse", "main"]),
    posted: suffix => log.filter(l => l.method === "POST" && l.path.endsWith(suffix)),
    stateFile: () => join(sh(work, ["rev-parse", "--absolute-git-dir"]), "atelier-auto-revert.json"),
  };
}
const suite = () => [{ name: "suite", command: "grep -q good f" }];

test("a red suite on the landed head lands a revert on the owner remote with no session command (criterion 1)", async t => {
  const w = world(t, { steps: suite });
  await assert.rejects(w.execute(), /was reverted/);
  const head = w.originHead();
  assert.notEqual(head, w.merge);
  assert.equal(w.sh(w.origin, ["rev-parse", `${head}^`]), w.merge);
  assert.match(w.sh(w.origin, ["log", "-1", "--format=%B", head]), /Revert t7[\s\S]*Agent: atelier\/auto-revert/);
  assert.equal(w.sh(w.origin, ["show", `${head}:f`]), "good");
  // Taken and released under the landing lease, as the lander does.
  assert.deepEqual(w.posted("/landing-lease").map(l => l.body), [{ item: "t7" }, { cancel: true, item: "t7" }]);
  // A revert is never pushed with the read grant: no push went through runStep's clone.
  assert.equal(w.sh(w.work, ["rev-parse", "HEAD"]), head);
});

test("a fix task linked by fixOf carries the failing output and is dispatched to the builder (criterion 2)", async t => {
  const w = world(t, { steps: suite });
  await assert.rejects(w.execute(), /was reverted/);
  const [filed] = w.posted("/items");
  assert.equal(filed.body.fixOf, "t7");
  assert.match(filed.body.brief, /grep|post-merge command failed/);
  assert.ok(filed.body.accept.length > 0);
  const [dispatched] = w.posted("/items/t100/dispatch");
  assert.equal(dispatched.body.agent, "claude-code");
  assert.equal(dispatched.body.model, "sonnet-5.5");
  assert.ok(w.log.findIndex(l => l === filed) < w.log.findIndex(l => l === dispatched));
  assert.equal(w.log.some(l => l.path.endsWith("/reopen")), false);
});

test("one notification to the owner's topic per revert, none for a repeat (criterion 3)", async t => {
  const w = world(t, { steps: suite });
  await assert.rejects(w.execute(), /was reverted/);
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0].url, "https://ntfy.sh/pavi-topic");
  assert.match(await w.sent[0].text(), /t7/);
  const head = w.originHead();
  // The same failure on the same merge, seen by a later executor: nothing more.
  await assert.rejects(w.execute(), /already reverted/);
  assert.equal(w.sent.length, 1);
  assert.equal(w.posted("/items").length, 1);
  assert.equal(w.originHead(), head);
});

test("a restart that finds the run failed with an unfinished revert resumes it instead of throwing (finding 3)", async t => {
  const w = world(t, { steps: suite });
  w.failNext("/items", 1);
  // The first executor dies after the revert landed, before the fix task exists.
  await assert.rejects(w.execute(), /remains merged/);
  assert.equal(w.run.state, "failed");
  const landed = w.originHead();
  assert.notEqual(landed, w.merge);
  const saved = JSON.parse(readFileSync(w.stateFile(), "utf8"));
  assert.equal(Object.values(saved.failures)[0].landed, landed);
  assert.equal(Object.values(saved.failures)[0].reopened, undefined);
  assert.equal(w.sent.length, 0);
  // A new executor, from the saved state alone.
  await assert.rejects(w.execute(), error => /already reverted/.test(error.message) || assert.fail(w.prints.join("\n")));
  assert.equal(w.originHead(), landed, "no second revert");
  assert.equal(w.posted("/items").length, 2, "one refused, one filed");
  assert.equal(w.posted("/items/t101/dispatch").length, 1);
  assert.equal(w.sent.length, 1);
  assert.equal(JSON.parse(readFileSync(w.stateFile(), "utf8")).failures[Object.keys(saved.failures)[0]].notified, true);
});

test("a refused ntfy send leaves notified unset and the restart sends again (finding 4)", async t => {
  const w = world(t, { steps: suite });
  w.ntfy(() => new Response("no", { status: 429 }));
  await assert.rejects(w.execute(), /remains merged/);
  let entry = Object.values(JSON.parse(readFileSync(w.stateFile(), "utf8")).failures)[0];
  assert.equal(entry.reopened, true);
  assert.equal(entry.notified, undefined);
  w.ntfy(() => new Response("ok"));
  await assert.rejects(w.execute(), /already reverted/);
  entry = Object.values(JSON.parse(readFileSync(w.stateFile(), "utf8")).failures)[0];
  assert.equal(entry.notified, true);
  assert.equal(w.sent.length, 2, "the refused send and the one that returned ok");
  assert.equal(w.posted("/items").length, 1);
});

test("a revert that fails its checks lands nothing, records a failed event and sends one message (criterion 4, finding 5)", async t => {
  const w = world(t, { steps: outside => [{ name: "suite", command: `grep -q good f && ! test -e ${outside}/block` }] });
  writeFileSync(join(w.outside, "block"), "");
  await assert.rejects(w.execute(), /remains merged/);
  assert.equal(w.originHead(), w.merge, "nothing was pushed");
  assert.equal(w.sh(w.work, ["rev-parse", "HEAD"]), w.merge, "the failed revert was discarded");
  assert.equal(w.posted("/items").length, 0);
  const [event] = w.posted("/deploys");
  assert.equal(event.body.result, "failed");
  assert.equal(event.body.head, w.merge);
  assert.match(event.body.note, /failed its checks/);
  assert.equal(w.sent.length, 1);
  assert.match(await w.sent[0].text(), /failed its checks/);
  // Another executor on the same merge: nothing more is recorded or sent.
  await assert.rejects(w.execute(), /remains merged/);
  assert.equal(w.sent.length, 1);
  assert.equal(w.originHead(), w.merge);
});

test("a flaky failure that passes on re-run is not reverted (criterion 5)", async t => {
  const w = world(t, { steps: outside => [{ name: "suite", command: `n=$(cat ${outside}/n 2>/dev/null || echo 0); echo $((n + 1)) > ${outside}/n; [ "$n" -ge 1 ]` }], red: false });
  await assert.rejects(w.execute(), /remains merged/);
  assert.equal(w.originHead(), w.merge);
  assert.equal(w.posted("/items").length, 0);
  assert.equal(w.sent.length, 0);
  assert.equal(existsSync(w.stateFile()), false);
});

test("a red release gate with a green suite is reverted the same way (criterion 6)", async t => {
  const w = world(t, { steps: () => [{ name: "suite", command: "true" }, { name: "gate", gate: true, command: "! test -e g" }], red: false });
  await assert.rejects(w.execute(), /was reverted/);
  const head = w.originHead();
  assert.notEqual(head, w.merge);
  assert.equal(w.sh(w.origin, ["ls-tree", "--name-only", head]).includes("g"), false);
  assert.equal(w.posted("/items")[0].body.fixOf, "t7");
  assert.match(w.posted("/items")[0].body.title, /release gate/);
  assert.equal(w.sent.length, 1);
});
