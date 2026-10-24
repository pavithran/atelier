import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privacyScan } from "../scripts/privacy-scan.mjs";
import { studioFastForward } from "../scripts/studio-ff.mjs";

// The privacy scan and the Studio fast-forward run in temporary repositories.
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

test("the Studio fast-forward pulls only a clean checkout on the branch, and says what it did", () => {
  const calls = [];
  const answers = { "status --porcelain --untracked-files=all": "", "branch --show-current": "main", "rev-parse HEAD": ["aaaaaaaa11", "bbbbbbbb22"], "pull --ff-only --quiet github main": "" };
  const run = (cmd, args) => {
    const key = args.slice(2).join(" ");
    calls.push([cmd, ...args]);
    let v = answers[key];
    if (Array.isArray(v)) v = v.shift();
    return v === undefined ? { status: 1, stderr: `unexpected ${key}` } : { status: 0, stdout: `${v}\n` };
  };
  const r = studioFastForward({ path: "/studio/atelier", remote: "github", branch: "main", run });
  assert.deepEqual(r, { before: "aaaaaaaa11", after: "bbbbbbbb22" });
  assert.deepEqual(calls[0], ["git", "-C", "/studio/atelier", "status", "--porcelain", "--untracked-files=all"]);
});

test("the Studio fast-forward leaves a dirty or off-branch checkout alone and refuses a bad path or host", () => {
  const dirty = () => ({ status: 0, stdout: " M file\n" });
  assert.throws(() => studioFastForward({ path: "/s", remote: "github", branch: "main", run: dirty }), /uncommitted changes/);
  const off = (cmd, args) => ({ status: 0, stdout: args.includes("--show-current") ? "other\n" : "\n" });
  assert.throws(() => studioFastForward({ path: "/s", remote: "github", branch: "main", run: off }), /not on main/);
  assert.throws(() => studioFastForward({ remote: "github", branch: "main" }), /--checkout/);
  assert.throws(() => studioFastForward({ path: "/s", host: "-oProxyCommand=x", remote: "github", branch: "main" }), /not a host name/);
  const failing = () => ({ status: 128, stderr: "fatal: Not possible to fast-forward\n" });
  assert.throws(() => studioFastForward({ path: "/s", remote: "github", branch: "main", run: failing }), /status in the Studio checkout failed/);
});

test("the Studio fast-forward refuses a host that names this Mac, and runs over ssh for another", () => {
  const never = () => { throw new Error("ran"); };
  for (const host of ["localhost", "127.0.0.1", "me@mac.local", "mac"]) {
    assert.throws(() => studioFastForward({ path: "/s", host, remote: "github", branch: "main", local: "mac.local", run: never }), /this Mac/, host);
  }
  const calls = [];
  const run = (cmd, args) => { calls.push([cmd, ...args]); return { status: 0, stdout: args.includes("--show-current") ? "main\n" : "\n" }; };
  studioFastForward({ path: "/s", host: "studio", remote: "github", branch: "main", local: "mac.local", run });
  assert.ok(calls.every((c) => c[0] === "ssh" && c[1] === "studio"));
});

test("the Studio script takes its checkout and host from its arguments, not the environment", () => {
  const env = { ...process.env, STUDIO_CHECKOUT: "/env/checkout", STUDIO_HOST: "env-host" };
  const bare = spawnSync(process.execPath, ["scripts/studio-ff.mjs", "--remote", "github", "--branch", "main"], { encoding: "utf8", env });
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /Usage|--checkout/);
  const local = spawnSync(process.execPath, ["scripts/studio-ff.mjs", "--remote", "github", "--branch", "main", "--checkout", "/s", "--host", "localhost"], { encoding: "utf8", env });
  assert.equal(local.status, 1);
  assert.match(local.stderr, /this Mac/);
});

test("the ship file gives the studio step its checkout and host", () => {
  const ship = JSON.parse(readFileSync("docs/atelier/ship.json", "utf8"));
  const argv = ship.studio.run;
  assert.match(argv[argv.indexOf("--checkout") + 1], /^\//);
  assert.ok(argv[argv.indexOf("--host") + 1]);
});
