import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privacyScan } from "../scripts/privacy-scan.mjs";

// The privacy scan runs in temporary repositories.
// The key below is built from pieces so this file holds no key itself.

const PUBLIC = "1+owner@users.noreply.github.com";
const KEY = ["sk", "ant", "api03", "A".repeat(40)].join("-");

function repo(t) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-ship-scripts-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (email, ...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: email } }).trim();
  git(PUBLIC, "init", "-q", "-b", "main");
  const commit = (email, path, text) => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
    git(email, "add", ".");
    git(email, "commit", "-q", "-m", `add ${path}`);
    return git(email, "rev-parse", "HEAD");
  };
  return { dir, git, commit };
}

test("the privacy scan passes commits under a no-reply address with no key and no private file", (t) => {
  const r = repo(t);
  const base = r.commit(PUBLIC, "a.txt", "one\n");
  r.commit(PUBLIC, "b.txt", "two\n");
  assert.deepEqual(privacyScan({ cwd: r.dir, base: [base], privates: ["PROJECT.md"] }), []);
});

test("the privacy scan refuses an author that is not a no-reply address, naming the commit", (t) => {
  const r = repo(t);
  const base = r.commit(PUBLIC, "a.txt", "one\n");
  const bad = r.commit("me@private.example", "b.txt", "two\n");
  const problems = privacyScan({ cwd: r.dir, base: [base], privates: [] });
  assert.equal(problems.length, 2, "the author and the committer");
  assert.ok(problems.every((p) => p.startsWith("author: ") && p.includes(bad.slice(0, 12)) && p.includes("me@private.example")), problems.join("\n"));
});

test("the privacy scan refuses a leaked key without printing it, and only in the commits being sent", (t) => {
  const r = repo(t);
  r.commit(PUBLIC, "old.txt", `token = ${KEY}\n`);
  const base = r.git(PUBLIC, "rev-parse", "HEAD");
  const bad = r.commit(PUBLIC, "conf/env.txt", `key=${KEY}\n`);
  const problems = privacyScan({ cwd: r.dir, base: [base], privates: [] });
  assert.deepEqual(problems, [`leak: commit ${bad.slice(0, 12)} adds a line to conf/env.txt that looks like a key or secret`]);
  assert.ok(!problems.join("").includes(KEY));
  assert.deepEqual(privacyScan({ cwd: r.dir, base: [bad], privates: [] }), [], "nothing new to send");
});

test("the privacy scan refuses a private file, in the commits and in the tree", (t) => {
  const r = repo(t);
  const base = r.commit(PUBLIC, "a.txt", "one\n");
  const bad = r.commit(PUBLIC, "PROJECT.md", "the plan\n");
  const problems = privacyScan({ cwd: r.dir, base: [base], privates: ["PROJECT.md"] });
  assert.equal(problems.length, 1);
  assert.match(problems[0], new RegExp(`^private files: PROJECT\\.md in ${bad.slice(0, 12)}`));
});

// The Studio runs the release the deploy installs, not a checkout
// (Atelier 2.0, task 9): Atelier's own ship file has no studio step, and its
// deploy names the Studio's host.
test("Atelier's ship file has no studio step, and its deploy names the Studio's host", () => {
  const ship = JSON.parse(readFileSync("docs/atelier/ship.json", "utf8"));
  assert.equal(ship.studio, undefined);
  assert.equal(ship.baseline, undefined);
  const argv = ship.deploy.run;
  assert.equal(argv[argv.indexOf("--host") + 1], "ai-studio");
});
