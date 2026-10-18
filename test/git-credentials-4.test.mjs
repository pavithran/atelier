// Part 4 of 4 of the tests that were in git-credentials.test.mjs, split so no file runs for more than about a minute (t771).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REAL_GIT, WRITE, WRITE2, READ, BASE, LEGACY, isolated, real, fixture, started, lapse, cli, actor, serveGit } from "./git-credentials-shared.mjs";

test("update and push renew an expired token from a subdirectory of the workspace", async (t) => {
  for (const command of ["update", "push"]) {
    const f = await started(t);
    real(f.workspace, "config", "--local", "atelier.write-token-expires-at", "2020-01-01T00:00:00.000Z");
    lapse(f);
    f.refuse.status = 500;
    real(f.workspace, "-c", "user.name=A", "-c", "user.email=a@example.test", "commit", "-q", "--allow-empty", "-m", "Work");
    const sub = join(f.workspace, "deep", "er");
    mkdirSync(sub, { recursive: true });
    const r = await f.run([command], sub);
    assert.equal(r.status, 0, `${command}: ${r.output}`);
    assert.match(readFileSync(join(f.workspace, ".git", "atelier-credentials"), "utf8"), new RegExp(WRITE2), command);
  }
});


test("push renews a lapsed token before reading the fork's branch, so a branch mismatch still stops it", async (t) => {
  const f = await started(t);
  real(f.workspace, "config", "--local", "atelier.write-token-expires-at", "2020-01-01T00:00:00.000Z");
  real(f.workspace, "config", "--local", "atelier.branch", "elsewhere");
  lapse(f);
  f.refuse.status = 403;
  real(f.workspace, "-c", "user.name=A", "-c", "user.email=a@example.test", "commit", "-q", "--allow-empty", "-m", "Work");
  const r = await f.run(["push"], f.workspace);
  assert.notEqual(r.status, 0, r.output);
  assert.match(r.output, /reads its head from main, but this workspace pushes to elsewhere/);
});


test("git's RPC failure for a refused push upload reads as a refused token", async () => {
  const { TOKEN_REFUSED } = await import("../cli/atelier.mjs");
  assert.match("error: RPC failed; HTTP 401", TOKEN_REFUSED);
  assert.match("error: RPC failed; HTTP 403 curl 22", TOKEN_REFUSED);
  assert.doesNotMatch("error: RPC failed; HTTP 413", TOKEN_REFUSED);
});


// Captured from git 2.54.0 against a server answering 401 to /info/refs, with
// the Bearer extraHeader, no credential helper and GIT_TERMINAL_PROMPT=0, for
// ls-remote, fetch and push alike, with and without WWW-Authenticate: Basic.
test("git's real wording for a 401 reads as a refused token, and unrelated errors do not", async () => {
  const { TOKEN_REFUSED } = await import("../cli/atelier.mjs");
  assert.match("fatal: could not read Username for 'http://127.0.0.1:58536': terminal prompts disabled", TOKEN_REFUSED);
  assert.match("fatal: could not read Password for 'https://u@host': terminal prompts disabled", TOKEN_REFUSED);
  assert.match("fatal: Authentication failed for 'https://host/r.git/'", TOKEN_REFUSED);
  for (const other of ["fatal: unable to access 'http://h/r.git/': Could not resolve host: h", "fatal: repository 'http://h/r.git/' not found", "error: RPC failed; HTTP 500", "fatal: could not read from remote repository."]) assert.doesNotMatch(other, TOKEN_REFUSED);
});


// Round 5 (both reviewers): a renewal that fails keeps the exit code of the
// failure (4 for a server that cannot answer, 5 or 6 for a task closed under
// the holder, t476) and still says to run atelier start.
for (const [what, fail, code] of [
  ["a server that cannot answer", { status: 503, body: { error: "unavailable", detail: "try later" } }, 4],
  ["a merged task", { status: 409, body: { error: "task_terminal", detail: "t1 is merged (state: merged)" } }, 5],
  ["an abandoned task", { status: 409, body: { error: "task_terminal", detail: "t1 is closed (state: abandoned)" } }, 6],
]) for (const command of ["update", "push"]) {
  test(`${command}: a renewal answered by ${what} exits ${code} and says to run atelier start`, async (t) => {
    const f = await started(t);
    if (command === "push") real(f.workspace, "-c", "user.name=A", "-c", "user.email=a@example.test", "commit", "-q", "--allow-empty", "-m", "Work");
    real(f.workspace, "config", "--local", "atelier.write-token-expires-at", "2020-01-01T00:00:00.000Z");
    f.api.fail = fail;
    const r = await f.run([command], f.workspace);
    assert.equal(r.status, code, r.output);
    assert.match(r.output, /Renewing it failed: .*Run atelier start t1 --as codex\/test to issue a new token\./);
  });
}
