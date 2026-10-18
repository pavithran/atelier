// Part 2 of 4 of the tests that were in git-credentials.test.mjs, split so no file runs for more than about a minute (t771).
import { test } from "node:test";
import assert from "node:assert/strict";
import { REAL_GIT, WRITE, WRITE2, READ, BASE, LEGACY, isolated, real, fixture, started, lapse, cli, actor, serveGit } from "./git-credentials-shared.mjs";

for (const status of [403, 401]) test(`update renews a token the fork refuses as expired and fetches again (git sees ${status})`, async (t) => {
  const f = await started(t);
  f.refuse.status = status;
  lapse(f);
  const r = await f.run(["update"], f.workspace);
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /renewed it for codex\/test/);
  assert.deepEqual(f.claims, ["POST", "POST"], "one claim to start, one to renew");
});


for (const status of [403, 401]) test(`push renews a token the fork refuses as expired and pushes with the new one (git sees ${status})`, async (t) => {
  const f = await started(t);
  f.refuse.status = status;
  lapse(f);
  real(f.workspace, "-c", "user.name=A", "-c", "user.email=a@example.test", "commit", "-q", "--allow-empty", "-m", "Work");
  const r = await f.run(["push"], f.workspace);
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /renewed it for codex\/test/);
  assert.match(r.output, /t1 head [0-9a-f]{8}/);
});


for (const status of [403, 401]) test(`update says plainly to run atelier start when the token cannot be renewed for the caller (git sees ${status})`, async (t) => {
  const f = await started(t);
  f.refuse.status = status;
  f.valid["fork.git"] = new Set([]);
  f.claim.owner = "codex/other";
  const r = await f.run(["update"], f.workspace);
  assert.notEqual(r.status, 0);
  assert.match(r.output, /refused this workspace's token as expired\. t1 is held by codex\/other now, so it cannot be renewed for codex\/test\. Run atelier start t1 --as codex\/test to issue a new token\./);
  assert.deepEqual(f.claims, ["POST"], "no second claim was made");
});


for (const status of [403, 401]) test(`update that renews and is refused again says to run atelier start (git sees ${status})`, async (t) => {
  const f = await started(t);
  f.refuse.status = status;
  f.valid["fork.git"] = new Set([]);
  const r = await f.run(["update"], f.workspace);
  assert.notEqual(r.status, 0);
  assert.match(r.output, /still refused this workspace's token after it was renewed\. Run atelier start t1 --as codex\/test\./);
});
