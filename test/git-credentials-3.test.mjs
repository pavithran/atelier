// Part 3 of 4 of the tests that were in git-credentials.test.mjs, split so no file runs for more than about a minute (t771).
import { test } from "node:test";
import assert from "node:assert/strict";
import { REAL_GIT, WRITE, WRITE2, READ, LEGACY, isolated, real, fixture, started, cli, actor, serveGit } from "./git-credentials-shared.mjs";

for (const status of [403, 401]) test(`a token expired by its recorded date and refused again after one renewal stops with atelier start, in update and push (git sees ${status})`, async (t) => {
  for (const command of ["update", "push"]) {
    const f = await started(t);
    real(f.workspace, "config", "--local", "atelier.write-token-expires-at", "2020-01-01T00:00:00.000Z");
    f.claim.token = WRITE2; // the renewed token is still refused
    f.valid["repo.git"] = new Set([]);
    f.refuse.status = status;
    real(f.workspace, "-c", "user.name=A", "-c", "user.email=a@example.test", "commit", "-q", "--allow-empty", "-m", "Work");
    const r = await f.run([command], f.workspace);
    assert.notEqual(r.status, 0, `${command}: ${r.output}`);
    assert.match(r.output, /still refused this workspace's token after it was renewed\. Run atelier start t1 --as codex\/test\./, command);
    assert.deepEqual(f.claims, ["POST", "POST"], `${command}: one claim to start, one renewal`);
  }
});
