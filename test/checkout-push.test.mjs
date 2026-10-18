// The pushes Atelier makes from the developer's checkout (cli/checkout-push.mjs):
// no commit the remote lacks may hold a private file of the project, and a remote
// the project declares a public mirror takes only commits under the project's own
// address. t770 removed the mirror scan, which also checked every commit's address
// on its way to a mirror; these tests keep that one check, through the CLI's own
// git helper.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../cli/atelier.mjs";
import { pushCheckoutRemote } from "../cli/checkout-push.mjs";
import { privateConfig } from "./fixtures/private-config.mjs";

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

test("a push carries no commit holding a private file of the project, however it got into history, and sends nothing", (t) => {
  const f = setup(t);
  privateConfig(t, { demo: { private: ["PROJECT.md"] } });
  f.commit(OWN, "a");
  writeFileSync(join(f.dir, "PROJECT.md"), "the plan\n");
  f.g(f.dir, OWN, "add", "-f", "PROJECT.md");
  f.g(f.dir, OWN, "commit", "-q", "-m", "plan, by mistake");
  const leak = f.g(f.dir, OWN, "rev-parse", "HEAD");
  f.g(f.dir, OWN, "rm", "-q", "PROJECT.md");
  f.g(f.dir, OWN, "commit", "-q", "-m", "plan removed");
  const r = pushCheckoutRemote({ git, dir: f.dir, branch: "main", remote: "origin", identity, project: "demo" });
  assert.notEqual(r.status, 0);
  assert.match(r.refused, new RegExp(`^Not pushed to origin: main would carry private files: PROJECT\\.md in ${leak.slice(0, 12)}`));
  assert.equal(f.held("origin"), null);
  // A project that names no private file pushes the same history.
  const ok = pushCheckoutRemote({ git, dir: f.dir, branch: "main", remote: "origin", identity, project: "other" });
  assert.equal(ok.status, 0, ok.stderr);
});

test("a remote that is no declared mirror takes the branch whoever committed it", (t) => {
  const f = setup(t);
  f.commit(AGENT, "a");
  const head = f.commit(AGENT, "b");
  const r = pushCheckoutRemote({ git, dir: f.dir, branch: "main", remote: "origin", identity, project: "other" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.held("origin"), head);
});

test("a declared public mirror refuses a commit under an agent's address and nothing is pushed", (t) => {
  const f = setup(t);
  f.commit(OWN, "a");
  const agent = f.commit(AGENT, "b");
  const r = pushCheckoutRemote({ git, dir: f.dir, branch: "main", remote: "github", identity, project: "other" });
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
  const r = pushCheckoutRemote({ git, dir: f.dir, branch: "main", remote: "github", identity, project: "other" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.refused, undefined);
  assert.equal(f.held("github"), head);
});

test("a branch pushed under another name on the remote lands there, and a failed push is the git result", (t) => {
  const f = setup(t);
  const head = f.commit(OWN, "a");
  const r = pushCheckoutRemote({ git, dir: f.dir, branch: "main", targetBranch: "release", remote: "origin", identity, project: "other" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.g(f.dir, OWN, "--git-dir", join(f.dir, "..", "origin.git"), "rev-parse", "release"), head);
  const missing = pushCheckoutRemote({ git, dir: f.dir, branch: "main", remote: "nowhere", identity, project: "other" });
  assert.notEqual(missing.status, 0);
  assert.equal(missing.refused, undefined, "a refusal by git is not Atelier's refusal");
});

// A push goes to a remote's push URLs, which may differ from its fetch URL and be
// several. Each is read for what it holds, so an empty one is checked in full.
function bare(f, name) {
  const dir = join(f.dir, "..", `${name}.git`);
  f.g(f.dir, OWN, "init", "-q", "--bare", "-b", "main", dir);
  const head = () => { try { return f.g(f.dir, OWN, "--git-dir", dir, "rev-parse", "main"); } catch { return null; } };
  return { dir, head };
}

test("a declared public mirror is checked against its push URL, not its fetch URL", (t) => {
  const f = setup(t);
  f.commit(OWN, "a");
  const agent = f.commit(AGENT, "b");
  // The fetch URL already holds the agent's commit; the push URL is empty.
  f.g(f.dir, OWN, "push", "-q", "github", "main");
  const aside = bare(f, "aside");
  f.g(f.dir, OWN, "config", "remote.github.pushurl", aside.dir);
  const r = pushCheckoutRemote({ git, dir: f.dir, branch: "main", remote: "github", identity, project: "other" });
  assert.notEqual(r.status, 0);
  assert.ok(r.refused.includes(`commit ${agent.slice(0, 12)}: the author email ${AGENT}`), r.refused);
  assert.equal(aside.head(), null, "nothing reached the push URL");
});

test("a declared public mirror with two push URLs is checked against each: one that lacks an agent's commit refuses the push to both", (t) => {
  const f = setup(t);
  f.commit(OWN, "a");
  const agent = f.commit(AGENT, "b");
  const first = bare(f, "first"), second = bare(f, "second");
  f.g(f.dir, OWN, "push", "-q", first.dir, "main");
  f.g(f.dir, OWN, "push", "-q", "github", "main"); // the fetch URL holds it too
  f.g(f.dir, OWN, "config", "--add", "remote.github.pushurl", first.dir);
  f.g(f.dir, OWN, "config", "--add", "remote.github.pushurl", second.dir);
  const r = pushCheckoutRemote({ git, dir: f.dir, branch: "main", remote: "github", identity, project: "other" });
  assert.notEqual(r.status, 0);
  assert.ok(r.refused.includes(`commit ${agent.slice(0, 12)}: the author email ${AGENT}`), r.refused);
  assert.equal(second.head(), null);
  assert.equal(first.head(), agent, "the one that held it was not pushed over either");
});

test("a declared public mirror with two push URLs that both hold the older commits takes a new one under the public address", (t) => {
  const f = setup(t);
  f.commit(AGENT, "old");
  const first = bare(f, "first"), second = bare(f, "second");
  f.g(f.dir, OWN, "push", "-q", first.dir, "main");
  f.g(f.dir, OWN, "push", "-q", second.dir, "main");
  f.g(f.dir, OWN, "config", "--add", "remote.github.pushurl", first.dir);
  f.g(f.dir, OWN, "config", "--add", "remote.github.pushurl", second.dir);
  const head = f.commit(OWN, "new");
  const r = pushCheckoutRemote({ git, dir: f.dir, branch: "main", remote: "github", identity, project: "other" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(first.head(), head);
  assert.equal(second.head(), head);
});
