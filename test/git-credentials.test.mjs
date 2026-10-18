// Part 1 of 4 of the tests that were in git-credentials.test.mjs, split so no file runs for more than about a minute (t771).
import { canInspectSlots } from "./fixtures/slot-inspection.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REAL_GIT, WRITE, WRITE2, READ, BASE, LEGACY, isolated, real, fixture, started, lapse, cli, actor, serveGit } from "./git-credentials-shared.mjs";
// Every local user can read a process's arguments with ps, so no Artifacts
// token may appear in the arguments of any git the CLI runs. These tests put
// a shim named git first on PATH that records each call's arguments and the
// names (never the values) of its environment, then runs the real git. The
// remotes are served over HTTP by git http-backend behind a check of the
// Authorization header, so a token that does not reach git, or a revoked one
// still configured, fails the command.
const TOKENS = [WRITE, WRITE2, READ, BASE, LEGACY];
// git http-backend as a CGI program behind a Node server. A request to a
// repository is served only when every Authorization header it carries holds
// a token valid for that repository, and at least one does.
// The caller's own git configuration is kept out, so no credential helper
// answers a refused request.
test("claim, re-claim, push and check authenticate without a token in any git argument", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await fixture(t);
  const start = await f.run(["start", "t1"], f.source);
  assert.equal(start.status, 0, start.output);
  const noTokenInArgs = () => {
    for (const call of f.calls()) for (const token of TOKENS) assert.ok(!call.args.some((arg) => arg.includes(token)), `git ${call.args.join(" ")} carries no token`);
  };
  noTokenInArgs();

  // The workspace's .git/config includes a file only its user can read, and
  // holds no token itself.
  const gitDir = join(f.workspace, ".git");
  assert.equal(statSync(join(gitDir, "atelier-credentials")).mode & 0o777, 0o600);
  assert.match(readFileSync(join(gitDir, "atelier-credentials"), "utf8"), new RegExp(`Authorization: Bearer ${WRITE}`));
  assert.ok(!readFileSync(join(gitDir, "config"), "utf8").includes(WRITE));

  // A workspace claimed by a CLI that wrote the header into .git/config
  // itself: a re-claim with a fresh token must leave neither old one
  // configured, or the fetch carries a revoked token and is refused.
  real(f.workspace, "config", "--local", "--add", `http.${f.forkUrl}.extraHeader`, `Authorization: Bearer ${LEGACY}`);
  f.claim.token = WRITE2;
  f.valid["fork.git"] = new Set([WRITE2, READ]);
  const reclaim = await f.run(["claim", "t1"], f.workspace);
  assert.equal(reclaim.status, 0, reclaim.output);
  const config = readFileSync(join(gitDir, "config"), "utf8");
  for (const token of [WRITE, LEGACY, WRITE2]) assert.ok(!config.includes(token), `${token} is not in .git/config`);
  assert.equal(real(f.workspace, "config", "--local", "--get-all", "include.path"), "atelier-credentials", "the include is added once");
  assert.equal(statSync(join(gitDir, "atelier-credentials")).mode & 0o777, 0o600);

  // The persisted header pushes; the read and baseline tokens clone and fetch.
  real(f.workspace, "-c", "user.name=A", "-c", "user.email=a@example.test", "commit", "-q", "--allow-empty", "-m", "Work");
  const push = await f.run(["push"], f.workspace);
  assert.equal(push.status, 0, push.output);
  const check = await f.run(["check"], f.workspace);
  assert.equal(check.status, 0, check.output);
  assert.match(check.output, /PASS {2}true/);

  const used = (repo, token) => f.seen.some((s) => s.repo === repo && s.tokens.includes(token));
  assert.ok(used("fork.git", WRITE) && used("fork.git", WRITE2) && used("fork.git", READ) && used("base.git", BASE), JSON.stringify(f.seen));
  assert.ok(!used("fork.git", LEGACY), "the old header was removed before the fetch");

  noTokenInArgs();
  const calls = f.calls();
  const clones = calls.filter((c) => c.args[0] === "clone");
  assert.equal(clones.length, 2, "the workspace clone and the check's clean clone");
  for (const c of clones) for (const key of ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]) assert.ok(c.env.includes(key), `${key} reaches git clone`);
  assert.ok(calls.some((c) => c.args[0] === "fetch" && c.env.includes("GIT_CONFIG_VALUE_0")), "the check's baseline fetch takes its token from the environment");
  assert.ok(calls.filter((c) => c.args[0] === "config").every((c) => !c.env.includes("GIT_CONFIG_VALUE_0")), "a command that needs no token is given none");
});


test("auth puts the header in git's environment after any configuration the caller passes there", async () => {
  const { auth, gitEnv } = await import("../cli/atelier.mjs");
  assert.deepEqual(auth("T", {}), { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: "Authorization: Bearer T" });
  const dir = mkdtempSync(join(tmpdir(), "atelier-auth-"));
  try {
    writeFileSync(join(dir, "gitconfig"), "");
    const base = { ...process.env, ...isolated(dir), GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "Caller" };
    const env = gitEnv(base, auth("T", base), ["config"]);
    const read = (key) => execFileSync(REAL_GIT, ["config", "--get-all", key], { cwd: dir, env, encoding: "utf8" }).trim();
    assert.equal(read("http.extraheader"), "Authorization: Bearer T");
    assert.equal(read("user.name"), "Caller");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
// t705, seen in ikon-weblog/t112 after a build of about ten hours: the fetch
// was refused for an expired token, atelier claim then answered "internal",
// and only atelier start worked. update and push now renew the token for the
// holder, or say plainly to run atelier start.
test("update renews a workspace token whose recorded expiry has passed, for the holder, before fetching", async (t) => {
  const f = await started(t);
  real(f.workspace, "config", "--local", "atelier.write-token-expires-at", "2020-01-01T00:00:00.000Z");
  lapse(f);
  // A refusal the CLI would not read as an expired token: only the recorded expiry can have prompted the renewal.
  f.refuse.status = 500;
  const r = await f.run(["update"], f.workspace);
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /t1: this workspace's token had expired; renewed it for codex\/test/);
  assert.equal(real(f.workspace, "config", "--local", "atelier.write-token-expires-at"), "2999-01-01T00:00:00.000Z");
  assert.match(readFileSync(join(f.workspace, ".git", "atelier-credentials"), "utf8"), new RegExp(WRITE2));
});
