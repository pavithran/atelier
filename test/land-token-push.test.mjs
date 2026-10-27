// The land push when the workspace token has expired (t317). On 2026-10-26
// miqra/t126's land job failed three times saying the workspace held commits
// the recorded head lacked, until atelier push renewed the token and pushed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runLand } from "../cli/land.mjs";
import { LAND_UNPUSHED, prepareRecordedWorkspace } from "../cli/landing.mjs";
import { tokenLanding } from "./land-fixture.mjs";

const far = () => new Date(Date.now() + 4 * 3600_000).toISOString();
const HEAD = "a".repeat(40);

// tokenLanding's Git, with LAND_UNPUSHED kept where a test can read it.
function withUnpushed(l) {
  const store = new Map(), git = l.io.git;
  l.io.git = (args, o = {}) => {
    if (args[0] === "config" && args.includes(LAND_UNPUSHED)) {
      if (args.includes("--unset")) store.delete(LAND_UNPUSHED);
      else if (args.at(-1) !== LAND_UNPUSHED) store.set(LAND_UNPUSHED, args.at(-1));
      return o.allowFail ? { status: 0, stdout: store.get(LAND_UNPUSHED) ?? "", stderr: "" } : "";
    }
    return git(args, o);
  };
  return store;
}

// What atelier push prints when the fork refused the token and its own
// renewal failed: no "Invalid or expired token" in it.
const pushRenewalFailed = "The server refused this workspace's token as expired. Renewing it failed: t1 is held elsewhere. Run atelier start t1 --as codex/test to issue a new token.";

test("a land push that atelier push could not renew is renewed by the lander and pushed again (t317)", async (t) => {
  const l = tokenLanding(t, { expiresAt: far(), push: [pushRenewalFailed] });
  const store = withUnpushed(l);
  await runLand(l.io);
  assert.deepEqual(l.commands, ["push", "push", "check", "submit"]);
  assert.equal(l.claims().length, 1);
  assert.equal(l.claims()[0].as, "codex/test");
  assert.equal(l.adopted.length, 1);
  assert.equal(store.has(LAND_UNPUSHED), false);
});

test("a renewal that fails says the workspace token expired and how to recover, and records the head it could not push (t317)", async (t) => {
  for (const refusal of ["remote: Invalid or expired token\nfatal: unable to access the fork", pushRenewalFailed]) {
    const l = tokenLanding(t, { expiresAt: far(), claim: "not_owner: refused", push: [refusal] });
    const store = withUnpushed(l);
    await assert.rejects(runLand(l.io), (error) => {
      assert.match(error.message, /t1's workspace token expired, and renewing it for its holder failed: not_owner: refused\./);
      assert.match(error.message, /Run atelier push in .*, which renews the token .* then run atelier land t1 again/);
      assert.doesNotMatch(error.message, /the recorded head lacks/);
      // Its last line says it, so the land job's report, a tail of the output, carries it.
      assert.match(error.message.split("\n").at(-1), /workspace token expired/);
      return true;
    });
    assert.deepEqual(l.commands, ["push"]);
    assert.equal(store.get(LAND_UNPUSHED), HEAD);
    assert.equal(l.leaseTaken(), false);
  }
});

test("a renewed token the fork refuses again says the workspace token expired, and is not renewed a second time (t317)", async (t) => {
  const l = tokenLanding(t, { expiresAt: far(), push: ["Invalid or expired token", "Invalid or expired token"] });
  const store = withUnpushed(l);
  await assert.rejects(runLand(l.io), /atelier push failed[\s\S]*Invalid or expired token\nt1's workspace token expired, and the fork refused the renewed token too\. Run atelier push in /);
  assert.deepEqual(l.commands, ["push", "push"]);
  assert.equal(l.claims().length, 1);
  assert.equal(store.get(LAND_UNPUSHED), HEAD);
});

test("a push that fails for another reason records nothing (t317)", async (t) => {
  const l = tokenLanding(t, { expiresAt: far(), push: ["error: failed to push some refs (non-fast-forward)"] });
  const store = withUnpushed(l);
  await assert.rejects(runLand(l.io), /non-fast-forward/);
  assert.equal(store.has(LAND_UNPUSHED), false);
});

test("a token that expired before the landing and cannot be refreshed is named as an expired workspace token (t317)", async (t) => {
  const l = tokenLanding(t, { expiresAt: "2026-10-26T09:00:00.000Z", claim: "not_owner: refused" });
  await assert.rejects(runLand(l.io), (error) => {
    assert.match(error.message, /t1's workspace token expired 2026-10-26 09:00 UTC, and it could not be refreshed, so the landing stops before taking the lease/);
    assert.match(error.message, /atelier push in .*atelier claim t1/);
    return true;
  });
  assert.deepEqual(l.commands, []);
});

// A workspace a landing merged main into and could not push, as t126's was.
function aheadWorkspace(t) {
  const root = mkdtempSync(join(tmpdir(), "atelier-unpushed-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (args, opts = {}) => {
    const r = spawnSync("git", args, { cwd: opts.cwd ?? root, encoding: "utf8" });
    if (opts.allowFail) return r;
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  const dir = join(root, "workspace");
  git(["init", "-q", "-b", "main", dir]);
  const g = (...args) => git(args, { cwd: dir });
  g("config", "user.name", "Fixture"); g("config", "user.email", "fixture@example.invalid");
  g("config", "atelier.project", "proj"); g("config", "atelier.item", "t1"); g("config", "atelier.actor", "codex/test");
  writeFileSync(join(dir, "work"), "recorded"); g("add", "."); g("commit", "-qm", "recorded");
  const head = g("rev-parse", "HEAD");
  writeFileSync(join(dir, "main"), "from main"); g("add", "."); g("commit", "-qm", "Merge main into t1");
  const merged = g("rev-parse", "HEAD");
  const lines = [], calls = [];
  const io = { git, name: "proj", id: "t1", owner: "owner", p: { path: dir, branch: "main" }, print: (s) => lines.push(s), request: async (...c) => { calls.push(c); throw new Error("no request expected"); } };
  const detail = { item: { head, owner: "codex/test", state: "submitted" }, policy: {} };
  return { dir, g, head, merged, io, lines, calls, ctx: { dir, itemPath: "/projects/proj/items/t1", detail } };
}

test("the next landing goes on from the merge an earlier landing could not push, rather than stopping on its commits (t317)", async (t) => {
  const w = aheadWorkspace(t);
  // Without the record it is work the ledger has not seen, and landing stops (t549).
  await assert.rejects(prepareRecordedWorkspace(w.io, w.ctx), /holds 1 commit the recorded head .* lacks/);
  w.g("config", LAND_UNPUSHED, w.merged);
  for (const dryRun of [true, false]) assert.equal(await prepareRecordedWorkspace(w.io, { ...w.ctx, dryRun }), false);
  assert.match(w.lines.join("\n"), new RegExp(`t1's workspace holds ${w.merged.slice(0, 8)}, the merge an earlier landing made and could not push because the fork refused the workspace token; this landing goes on from it\\.`));
  assert.doesNotMatch(w.lines.join("\n"), /the recorded head lacks/);
  assert.equal(w.g("rev-parse", "HEAD"), w.merged);
  assert.deepEqual(w.calls, []);
});

test("a commit made after the unpushed merge is not the landing's, and still stops the landing (t317)", async (t) => {
  const w = aheadWorkspace(t);
  w.g("config", LAND_UNPUSHED, w.merged);
  writeFileSync(join(w.dir, "fix"), "later"); w.g("add", "."); w.g("commit", "-qm", "Later fix");
  await assert.rejects(prepareRecordedWorkspace(w.io, w.ctx), /holds 2 commits the recorded head .* lacks/);
});
