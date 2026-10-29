// The land push when the workspace token has expired (t317). On 2026-10-26
// miqra/t126's land job failed three times saying the workspace held commits
// the recorded head lacked, until atelier push renewed the token and pushed.
// Since G2 the plain landing pushes nothing to the task's branch, so the
// renewal of a refused push stays with the Workflow landing alone; what is
// left here is the next landing's reading of a merge an earlier one could
// not push.
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
  assert.match(w.lines.join("\n"), new RegExp(`t1's workspace holds ${w.merged.slice(0, 8)}, the merge an earlier landing made and could not push because the server refused the workspace token; this landing goes on from it\\.`));
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
