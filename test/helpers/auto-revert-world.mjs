import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { executePostMerge, recoverFailedLanding } from "../../cli/post-merge.mjs";
import { parsePostMerge, reservePostMerge, preparePostMerge, startAttempt, finishAttempt, recordCommand } from "../../src/post-merge.ts";

// The production path end to end: executePostMerge runs the suite in a clone,
// and its default recovery (recoverFailedLanding) reverts in a real checkout and
// pushes to a real bare remote. Only the server (a state machine over
// src/post-merge.ts, and the revert notices keyed by merge as the ledger's
// table keys them) is stood in for.
const at = "2026-11-07T12:00:00Z";
const IDENTITY = { GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.test" };

export function world(t, { steps, red = true, real }) {
  const root = mkdtempSync(join(tmpdir(), "atelier-auto-revert-prod-"));
  t.after(() => { rmSync(root, { recursive: true, force: true }); });
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

  const log = [], notices = [], noticed = new Set();
  let counter = 0, failNext = {};
  const request = async (method, path, body) => {
    log.push({ method, path, body });
    // `real` answers the ledger's own routes where a test runs against it.
    const answered = await real?.(method, path, body);
    if (answered !== undefined) return answered;
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
    if (path.endsWith("/revert-notices")) {
      if (noticed.has(body.merge)) return { recorded: false, merge: body.merge };
      noticed.add(body.merge); notices.push(body);
      return { recorded: true, merge: body.merge };
    }
    if (path.endsWith("/items/t7")) return { item: { id: "t7", owner: "claude-code/sonnet-5.5" } };
    const fix = /\/items\/(t\d+)$/.exec(path);
    if (fix && method === "GET") return { item: { id: fix[1], state: "open", owner: null, dispatch: log.some(l => l.method === "POST" && l.path.endsWith(`/items/${fix[1]}/dispatch`)) ? {} : null } };
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
  const env = { PATH: process.env.PATH, HOME: root };
  const prints = [];
  // One executor process: a restart is another call over the same saved state.
  const execute = (over = {}) => executePostMerge({ request, name: "p", id: "t7", env, print: line => prints.push(line), recover: a => recoverFailedLanding({ ...a, deps }), ...over });
  return {
    root, origin, work, outside, merge, run, log, notices, prints, execute, sh, env,
    failNext: (key, n = 1) => { failNext[key] = n; },
    originHead: () => sh(origin, ["rev-parse", "main"]),
    posted: suffix => log.filter(l => l.method === "POST" && l.path.endsWith(suffix)),
    stateFile: () => join(sh(work, ["rev-parse", "--absolute-git-dir"]), "atelier-auto-revert.json"),
  };
}
