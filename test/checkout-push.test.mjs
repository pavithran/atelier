// The pushes Atelier makes from the developer's checkout (cli/checkout-push.mjs):
// a push is pinned to the commit it resolved, and a remote the project declares
// a public mirror takes only commits under the project's own address. t770
// removed the mirror scan, which also checked every commit's address on its way
// to a mirror; these tests keep that one check, through the CLI's own git helper.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../cli/atelier.mjs";
import { pinnedPush, pushCheckoutRemote } from "../cli/checkout-push.mjs";

const OWN = "123+owner@users.noreply.github.com", AGENT = "agents@atelier.example";
const identity = { name: "Owner", email: OWN, agentEmails: [AGENT], publicMirrors: ["github"] };

function setup(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "atelier-checkout-push-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "gitconfig"), "");
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "gitconfig") };
  const g = (cwd, email, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: email } }).trim();
  const dir = join(root, "checkout");
  mkdirSync(dir);
  g(dir, OWN, "init", "-q", "-b", "main");
  const commit = (email, name) => { writeFileSync(join(dir, name), name); g(dir, email, "add", "."); g(dir, email, "commit", "-q", "-m", name); return g(dir, email, "rev-parse", "HEAD"); };
  const remotes = {};
  for (const name of ["github", "origin"]) {
    remotes[name] = join(root, `${name}.git`);
    g(root, OWN, "init", "-q", "--bare", "-b", "main", remotes[name]);
    g(dir, OWN, "remote", "add", name, remotes[name]);
  }
  const held = (name) => { try { return g(root, OWN, "--git-dir", remotes[name], "rev-parse", "main"); } catch { return null; } };
  // The CLI's git helper reads the process environment: point it at the same empty global config.
  process.env.GIT_CONFIG_GLOBAL = join(root, "gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  return { dir, commit, held, g };
}

test("pinnedPush hands the push the commit the tip named when it resolved, and refuses a tip that names none", (t) => {
  const f = setup(t);
  const first = f.commit(OWN, "a");
  let given = null;
  pinnedPush({ cwd: f.dir, tip: "refs/heads/main", what: "The push" }, (sha) => { given = sha; f.commit(OWN, "b"); });
  assert.equal(given, first, "a commit made after the resolve is not the one pushed");
  assert.throws(() => pinnedPush({ cwd: f.dir, tip: "refs/heads/none", what: "The push" }, () => assert.fail("pushed")), /The push: refs\/heads\/none does not name a commit here\. Nothing was pushed\./);
  assert.equal(pinnedPush({ cwd: f.dir, tip: "--upload-pack=x", what: "The push", fail: (m) => m }, () => assert.fail("pushed")), "The push: --upload-pack=x does not name a commit here. Nothing was pushed.");
});

test("a remote that is no declared mirror takes the branch whoever committed it", (t) => {
  const f = setup(t);
  f.commit(AGENT, "a");
  const head = f.commit(AGENT, "b");
  const r = pushCheckoutRemote({ git, dir: f.dir, branch: "main", remote: "origin", identity });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.held("origin"), head);
});

test("a declared public mirror refuses a commit under an agent's address and nothing is pushed", (t) => {
  const f = setup(t);
  f.commit(OWN, "a");
  const agent = f.commit(AGENT, "b");
  const r = pushCheckoutRemote({ git, dir: f.dir, branch: "main", remote: "github", identity });
  assert.notEqual(r.status, 0);
  assert.ok(r.refused.startsWith(`Not pushed to github: commit ${agent.slice(0, 12)}: the author email ${AGENT} is not the project's public address ${OWN}`), r.refused);
  assert.equal(f.held("github"), null);
});

test("a declared public mirror takes commits under the project's address, and checks only what it lacks", (t) => {
  const f = setup(t);
  f.commit(AGENT, "old");
  const old = f.commit(AGENT, "older");
  // The mirror already holds the agent's commits (pushed before it was declared); only newer ones are checked.
  f.g(f.dir, OWN, "push", "-q", "github", "main");
  assert.equal(f.held("github"), old);
  const head = f.commit(OWN, "new");
  const r = pushCheckoutRemote({ git, dir: f.dir, branch: "main", remote: "github", identity });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.refused, undefined);
  assert.equal(f.held("github"), head);
});

test("a branch pushed under another name on the remote lands there, and a failed push is the git result", (t) => {
  const f = setup(t);
  const head = f.commit(OWN, "a");
  const r = pushCheckoutRemote({ git, dir: f.dir, branch: "main", targetBranch: "release", remote: "origin", identity });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.g(f.dir, OWN, "--git-dir", join(f.dir, "..", "origin.git"), "rev-parse", "release"), head);
  const missing = pushCheckoutRemote({ git, dir: f.dir, branch: "main", remote: "nowhere", identity });
  assert.notEqual(missing.status, 0);
  assert.equal(missing.refused, undefined, "a refusal by git is not Atelier's refusal");
});
