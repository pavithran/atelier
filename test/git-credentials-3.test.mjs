// Part 3 of 4 of the tests that were in git-credentials.test.mjs, split so no file runs for more than about a minute (t771).
import { test } from "node:test";
import assert from "node:assert/strict";
import { REAL_GIT, WRITE, WRITE2, READ, BASE, LEGACY, isolated, real, fixture, started, cli, actor, serveGit } from "./git-credentials-shared.mjs";

test("a token that lapses during the stepped pushes is renewed once and the steps resume", async (t) => {
  const f = await started(t);
  f.valid["fork.git"] = new Set([WRITE, WRITE2, READ]);
  f.claim.token = WRITE2;
  f.claim.expiresAt = "2999-01-01T00:00:00.000Z";
  // The whole push answers 413; the first step is refused as expired; the renewed token pushes.
  let uploads = 0;
  f.refuse.upload = (req, tokens) => req.method === "POST" && req.url.includes("git-receive-pack") && tokens.includes(WRITE) ? (++uploads === 1 ? 413 : 403) : undefined;
  real(f.workspace, "-c", "user.name=A", "-c", "user.email=a@example.test", "commit", "-q", "--allow-empty", "-m", "Work");
  const r = await f.run(["push"], f.workspace);
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /renewed it for codex\/test/);
  assert.match(r.output, /t1 head [0-9a-f]{8}/);
});


test("a stepped push refused again after its one renewal stops with atelier start", async (t) => {
  const f = await started(t);
  f.valid["fork.git"] = new Set([WRITE, WRITE2, READ]);
  f.claim.token = WRITE2;
  f.claim.expiresAt = "2999-01-01T00:00:00.000Z";
  // The whole push answers 413; every step is then refused, with the old token and the renewed one.
  let uploads = 0;
  f.refuse.upload = (req) => req.method === "POST" && req.url.includes("git-receive-pack") ? (++uploads === 1 ? 413 : 403) : undefined;
  real(f.workspace, "-c", "user.name=A", "-c", "user.email=a@example.test", "commit", "-q", "--allow-empty", "-m", "Work");
  const r = await f.run(["push"], f.workspace);
  assert.notEqual(r.status, 0, r.output);
  assert.match(r.output, /still refused this workspace's token after it was renewed\. Run atelier start t1 --as codex\/test\./);
  assert.deepEqual(f.claims, ["POST", "POST"], "one claim to start, one renewal");
});


for (const status of [403, 401]) test(`a token expired by its recorded date and refused again after one renewal stops with atelier start, in update and push (git sees ${status})`, async (t) => {
  for (const command of ["update", "push"]) {
    const f = await started(t);
    real(f.workspace, "config", "--local", "atelier.write-token-expires-at", "2020-01-01T00:00:00.000Z");
    f.claim.token = WRITE2; // the renewed token is still refused
    f.valid["fork.git"] = new Set([]);
    f.refuse.status = status;
    real(f.workspace, "-c", "user.name=A", "-c", "user.email=a@example.test", "commit", "-q", "--allow-empty", "-m", "Work");
    const r = await f.run([command], f.workspace);
    assert.notEqual(r.status, 0, `${command}: ${r.output}`);
    assert.match(r.output, /still refused this workspace's token after it was renewed\. Run atelier start t1 --as codex\/test\./, command);
    assert.deepEqual(f.claims, ["POST", "POST"], `${command}: one claim to start, one renewal`);
  }
});
