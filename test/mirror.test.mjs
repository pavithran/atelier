import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { commitPatch, globMatcher, headerPath, publishMirror } from "../cli/mirror.mjs";

// atelier publish REMOTE (t433), against a real checkout and a bare mirror on
// disk. The keys below are assembled at run time so this file holds none.

const cli = resolve("cli/atelier.mjs");
const PUBLIC = "pub@example.org";
const KEY = "AKIA" + "ABCDEFGHIJKLMNOP";
const POLICY = { mirrors: { github: { destination: "", email: PUBLIC } }, privatePaths: ["private/**", "*.pem", "notes/internal.md"], privatePatterns: ["ACME-INTERNAL-\\d+"] };

// Atelier's own runner, as publishMirror takes it: cwd, input and allowFail.
const runner = (args, opts = {}) => {
  const r = spawnSync("git", args, { cwd: opts.cwd, input: opts.input, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } });
  if (!opts.allowFail && r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return opts.allowFail ? r : r.stdout.trim();
};

function fixture(t, { policy = POLICY, emptyMirror = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-mirror-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const checkout = join(dir, "checkout"), mirror = join(dir, "mirror.git");
  const git = (cwd, ...args) => runner(args, { cwd });
  git(dir, "init", "-q", "--bare", "-b", "main", mirror);
  mkdirSync(checkout);
  git(checkout, "init", "-q", "-b", "main");
  git(checkout, "config", "user.name", "Pub");
  git(checkout, "config", "user.email", PUBLIC);
  git(checkout, "remote", "add", "github", mirror);
  const put = (file, text, cwd = checkout) => { mkdirSync(join(cwd, file, ".."), { recursive: true }); writeFileSync(join(cwd, file), text); };
  const commit = (subject, env = {}) => {
    git(checkout, "add", "-A");
    const r = spawnSync("git", ["commit", "-qm", subject], { cwd: checkout, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", ...env } });
    assert.equal(r.status, 0, r.stderr);
    return git(checkout, "rev-parse", "HEAD");
  };
  put(".atelier/publication.json", JSON.stringify({ ...policy, mirrors: { github: { ...policy.mirrors?.github, destination: mirror } } }));
  put("README.md", "hello\n");
  const first = commit("First");
  const lines = [];
  const publish = (over = {}) => {
    lines.length = 0;
    const r = publishMirror({ git: runner, dir: checkout, branch: "main", remote: "github", say: (l) => lines.push(l), ...over });
    return { ...r, text: lines.join("\n") };
  };
  const refs = () => git(mirror, "for-each-ref", "--format=%(refname)").split("\n").filter(Boolean);
  const head = () => runner(["rev-parse", "refs/heads/main"], { cwd: mirror, allowFail: true }).stdout?.trim();
  return { dir, checkout, mirror, git, put, commit, first, publish, refs, head, lines };
}

test("a clean history publishes to an empty mirror, every commit, and only the branch", (t) => {
  const f = fixture(t);
  f.put("src/a.txt", "a\n"); f.commit("Second");
  f.git(f.checkout, "tag", "v1");
  f.git(f.checkout, "notes", "--ref=atelier", "add", "-m", "note", "HEAD");
  f.git(f.checkout, "update-ref", "refs/rescue/old", "HEAD");
  const r = f.publish();
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /2 commits checked/);
  assert.deepEqual(f.refs(), ["refs/heads/main"]);
  assert.equal(f.head(), f.git(f.checkout, "rev-parse", "main"));
  // A second publish with nothing new does nothing; one commit more sends one.
  assert.match(f.publish().text, /nothing to publish/);
  f.put("src/b.txt", "b\n"); f.commit("Third");
  const again = f.publish();
  assert.equal(again.ok, true, again.text);
  assert.match(again.text, /1 commit checked/);
  assert.deepEqual(f.refs(), ["refs/heads/main"]);
});

test("a wrong author or committer email is refused, naming the commit", (t) => {
  const f = fixture(t);
  f.put("b.txt", "b\n");
  const author = f.commit("Author", { GIT_AUTHOR_EMAIL: "me@private.example" });
  f.put("c.txt", "c\n");
  const committer = f.commit("Committer", { GIT_COMMITTER_EMAIL: "me@private.example" });
  const r = f.publish();
  assert.equal(r.ok, false);
  assert.ok(r.text.includes(`${author.slice(0, 12)}: author email is not ${PUBLIC}`), r.text);
  assert.ok(r.text.includes(`${committer.slice(0, 12)}: committer email is not ${PUBLIC}`), r.text);
  assert.deepEqual(f.refs(), []);
});

test("a commit that came in by a merge is checked too", (t) => {
  const f = fixture(t);
  f.publish();
  f.git(f.checkout, "checkout", "-qb", "side");
  f.put("side.txt", "s\n");
  const bad = f.commit("Side", { GIT_AUTHOR_EMAIL: "x@private.example" });
  f.git(f.checkout, "checkout", "-q", "main");
  f.put("main.txt", "m\n"); f.commit("Main");
  f.git(f.checkout, "merge", "-q", "--no-ff", "-m", "Merge", "side");
  const r = f.publish();
  assert.equal(r.ok, false);
  assert.ok(r.text.includes(bad.slice(0, 12)), r.text);
});

test("a secret added and later deleted blocks publication, by place and never by value", (t) => {
  const f = fixture(t);
  f.put("config/app.txt", `line one\nkey = ${KEY}\n`);
  const added = f.commit("Add key");
  f.put("config/app.txt", "line one\n"); f.commit("Remove key");
  const r = f.publish();
  assert.equal(r.ok, false);
  assert.ok(r.text.includes(`${added.slice(0, 12)} config/app.txt:2: secret`), r.text);
  assert.ok(!r.text.includes(KEY));
  assert.deepEqual(f.refs(), []);
});

test("a secret added then removed is refused even when the net difference is empty: each commit's own patch is read", (t) => {
  const f = fixture(t);
  assert.equal(f.publish().ok, true);
  const before = f.head();
  // README.md ends as the mirror holds it: `git diff mirror..main` shows
  // nothing, and the commit in between still publishes the key.
  f.put("README.md", `hello\ntoken = ${KEY}\n`);
  const added = f.commit("Add key");
  f.put("README.md", "hello\n");
  const removed = f.commit("Remove key");
  assert.equal(f.git(f.checkout, "diff", `${before}..main`), "");
  const r = f.publish();
  assert.equal(r.ok, false);
  assert.ok(r.text.includes(`${added.slice(0, 12)} README.md:2: secret`), r.text);
  assert.ok(!r.text.includes(removed.slice(0, 12)), r.text);
  assert.ok(!r.text.includes(KEY));
  assert.equal(f.head(), before);
});

test("only the lines a commit adds are scanned, numbered as the commit holds them", (t) => {
  const f = fixture(t);
  f.put("docs/net.md", "one\ntwo\nthree\n"); f.commit("Doc");
  assert.equal(f.publish().ok, true);
  // A pattern declared after the mirror holds "two" does not re-report it
  // when a later commit touches another line of the file.
  f.put(".atelier/publication.json", JSON.stringify({ ...POLICY, privatePatterns: ["^two$", "^four$"], mirrors: { github: { ...POLICY.mirrors.github, destination: f.mirror } } }));
  f.put("docs/net.md", "one\ntwo\nthree\nfour\n");
  const c = f.commit("Append").slice(0, 12);
  const r = f.publish();
  assert.equal(r.ok, false);
  assert.ok(r.text.includes(`${c} docs/net.md:4: private-pattern`), r.text);
  assert.ok(!r.text.includes("docs/net.md:2"), r.text);
});

test("a line a merge alone introduces is reported at the merge; lines its parents hold are not", (t) => {
  const f = fixture(t);
  f.put("notes.txt", "a\nb\nc\n"); f.commit("Base");
  assert.equal(f.publish().ok, true);
  f.git(f.checkout, "checkout", "-qb", "side");
  f.put("notes.txt", "a\nside\nc\n"); f.commit("Side");
  f.git(f.checkout, "checkout", "-q", "main");
  f.put("notes.txt", "a\nmain\nc\n"); f.commit("Main");
  const merged = spawnSync("git", ["merge", "-q", "--no-commit", "side"], { cwd: f.checkout, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
  assert.notEqual(merged.status, 0); // a conflict, resolved by hand with new content
  f.put("notes.txt", `a\nmain\nside\nkey = ${KEY}\nc\n`);
  const merge = f.commit("Merge").slice(0, 12);
  const r = f.publish();
  assert.equal(r.ok, false);
  assert.ok(r.text.includes(`${merge} notes.txt:4: secret`), r.text);
  assert.ok(!r.text.includes("notes.txt:2"), r.text);
  assert.ok(!r.text.includes("notes.txt:3"), r.text);
});

test("paths git quotes in a patch header are named as paths", (t) => {
  const f = fixture(t);
  f.put("docs/my file.txt", `x\nkey = ${KEY}\n`);
  f.put("docs/café \"quoted\".txt", `key = ${KEY}\n`);
  f.put("docs/tab\there.txt", `\nkey = ${KEY}\n`);
  const c = f.commit("Odd names").slice(0, 12);
  const r = f.publish();
  assert.equal(r.ok, false);
  for (const expected of [`${c} docs/my file.txt:2: secret`, `${c} docs/café "quoted".txt:1: secret`, `${c} docs/tab\there.txt:2: secret`]) assert.ok(r.text.includes(expected), `${expected}\n${r.text}`);
  assert.ok(!r.text.includes("cannot scan"), r.text);
});

test("a mode change, a type change and a symlink publish; an oversized blob is refused", (t) => {
  const f = fixture(t);
  f.put("run.sh", "echo\n"); f.commit("Script");
  chmodSync(join(f.checkout, "run.sh"), 0o755); f.commit("Executable");
  rmSync(join(f.checkout, "run.sh")); symlinkSync("README.md", join(f.checkout, "run.sh")); f.commit("Link");
  let r = f.publish();
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /4 commits checked/);
  f.put("big.txt", "x".repeat(8 * 1024 * 1024 + 1)); const big = f.commit("Big").slice(0, 12);
  r = f.publish();
  assert.equal(r.ok, false);
  assert.ok(r.text.includes(`cannot scan ${big} big.txt: 8388609 bytes, over the`), r.text);
});

test("commitPatch reads plain and combined hunks with their line numbers", () => {
  const plain = [
    "diff --git a/x.txt b/x.txt", "index 1..2 100644", "--- a/x.txt", "+++ b/x.txt",
    "@@ -3,2 +3,3 @@", "-gone", "+new three", "+new four", "\\ No newline at end of file",
    "@@ -10 +11,2 @@", "+eleven", "+twelve",
    "diff --git a/img.bin b/img.bin", "new file mode 100644", "Binary files /dev/null and b/img.bin differ",
    "diff --combined m.txt", "index 1,2..3", "--- a/m.txt", "+++ b/m.txt",
    "@@@ -1,2 -1,2 +1,4 @@@", "  same", "- left", " -right", "++merge", "+ from side",
  ].join("\n");
  const r = commitPatch(() => ({ status: 0, stdout: plain, stderr: "" }), "c");
  assert.equal(r.ok, true, r.why);
  assert.deepEqual(r.files.map((f) => [f.path, f.binary, f.added]), [
    ["x.txt", false, [{ line: 3, text: "new three" }, { line: 4, text: "new four" }, { line: 11, text: "eleven" }, { line: 12, text: "twelve" }]],
    ["img.bin", true, []],
    ["m.txt", false, [{ line: 2, text: "merge" }, { line: 3, text: "from side" }]],
  ]);
  assert.equal(headerPath("diff --git a/a b.txt b/a b.txt"), "a b.txt");
  assert.equal(headerPath('diff --git "a/caf\\303\\251 \\"q\\".txt" "b/caf\\303\\251 \\"q\\".txt"'), 'café "q".txt');
  assert.equal(headerPath('diff --combined "t\\tab.txt"'), "t\tab.txt");
  assert.equal(headerPath("diff --git a/one.txt b/two.txt"), null);
  assert.equal(commitPatch(() => ({ status: 0, stdout: "+stray\n", stderr: "" }), "c").ok, false);
});

test("private addresses, private paths and policy patterns are reported with commit, path and line", (t) => {
  const f = fixture(t);
  f.put("docs/net.md", "ok\nhost 192.168.1.20 here\nand build.corp.internal\n");
  f.put("private/plan.txt", "fine\n");
  f.put("keys/server.pem", "fine\n");
  f.put("docs/x.md", "ref ACME-INTERNAL-42\n");
  const c = f.commit("Mixed").slice(0, 12);
  const r = f.publish();
  assert.equal(r.ok, false);
  for (const expected of [`${c} docs/net.md:2: private-ipv4`, `${c} docs/net.md:3: private-hostname`, `${c} private/plan.txt: the path matches`, `${c} keys/server.pem: the path matches`, `${c} docs/x.md:1: private-pattern`]) {
    assert.ok(r.text.includes(expected), `${expected}\n${r.text}`);
  }
  for (const value of ["192.168.1.20", "build.corp.internal", "ACME-INTERNAL-42"]) assert.ok(!r.text.includes(value), value);
});

test("content the scan cannot read is refused with its path and reason", (t) => {
  const f = fixture(t);
  f.put("img/logo.bin", "ab\0cd");
  f.commit("Binary");
  const r = f.publish();
  assert.equal(r.ok, false);
  assert.match(r.text, /cannot scan [0-9a-f]{12} img\/logo\.bin: binary content/);
  assert.deepEqual(f.refs(), []);
});

test("a diverged or ahead mirror is refused and left alone", (t) => {
  const f = fixture(t);
  assert.equal(f.publish().ok, true);
  const published = f.head();
  // The mirror gains a commit the checkout lacks: ahead.
  const other = join(f.dir, "other");
  f.git(f.dir, "clone", "-q", f.mirror, other);
  f.git(other, "config", "user.email", PUBLIC); f.git(other, "config", "user.name", "O");
  f.put("o.txt", "o\n", other); f.git(other, "add", "-A"); f.git(other, "commit", "-qm", "Other"); f.git(other, "push", "-q", "origin", "main");
  const moved = f.head();
  let r = f.publish();
  assert.equal(r.ok, false);
  assert.match(r.text, /is ahead of main/);
  // The checkout gains one too: diverged.
  f.put("c.txt", "c\n"); f.commit("Mine");
  r = f.publish();
  assert.equal(r.ok, false);
  assert.match(r.text, /has diverged from main/);
  assert.match(r.text, /never force-pushed/);
  assert.equal(f.head(), moved);
  assert.notEqual(moved, published);
});

test("a remote pointed away from the declared destination is not pushed to", (t) => {
  const f = fixture(t);
  const elsewhere = join(f.dir, "elsewhere.git");
  f.git(f.dir, "init", "-q", "--bare", elsewhere);
  f.git(f.checkout, "remote", "set-url", "github", elsewhere);
  const r = f.publish();
  assert.equal(r.ok, false);
  assert.match(r.text, /points at a different place/);
  assert.deepEqual(f.refs(), []);
  assert.equal(runner(["for-each-ref"], { cwd: elsewhere }), "");
  // An undeclared remote is refused as well.
  f.git(f.checkout, "remote", "add", "other", elsewhere);
  assert.match(f.publish({ remote: "other" }).text, /is not a mirror/);
});

test("a destination that changes during the check is refused", (t) => {
  const f = fixture(t);
  const elsewhere = join(f.dir, "elsewhere.git");
  f.git(f.dir, "init", "-q", "--bare", elsewhere);
  const racing = (args, opts) => {
    const r = runner(args, opts);
    if (args[0] === "diff-tree") runner(["remote", "set-url", "github", elsewhere], { cwd: f.checkout });
    return r;
  };
  const r = f.publish({ git: racing });
  assert.equal(r.ok, false);
  assert.match(r.text, /URL changed during the check/);
  assert.deepEqual(f.refs(), []);
});

test("a mirror that moves between the fetch and the push is refused without force", (t) => {
  const f = fixture(t);
  assert.equal(f.publish().ok, true);
  f.put("n.txt", "n\n"); f.commit("Next");
  const racing = (args, opts) => {
    const r = runner(args, opts);
    if (args[0] === "diff-tree" && !racing.done) {
      racing.done = true;
      const other = join(f.dir, "racer");
      runner(["clone", "-q", f.mirror, other], {});
      runner(["-c", "user.name=R", "-c", "user.email=r@example.org", "commit", "-q", "--allow-empty", "-m", "Race"], { cwd: other });
      runner(["push", "-q", "origin", "main"], { cwd: other });
    }
    return r;
  };
  const before = f.head();
  const r = f.publish({ git: racing });
  assert.equal(r.ok, false);
  assert.match(r.text, /refused the push/);
  assert.notEqual(f.head(), f.git(f.checkout, "rev-parse", "main"));
  assert.notEqual(f.head(), before); // the racer's commit stands; ours was not forced over it
});

test("a missing or invalid publication policy blocks publication before any push", (t) => {
  for (const [name, content] of [["missing", null], ["not json", "{"], ["no mirrors", "{}"], ["bad email", JSON.stringify({ mirrors: { github: { destination: "/x", email: "nope" } } })], ["bad pattern", JSON.stringify({ mirrors: { github: { destination: "/x", email: PUBLIC } }, privatePatterns: ["("] })], ["unknown field", JSON.stringify({ mirrors: { github: { destination: "/x", email: PUBLIC } }, extra: 1 })]]) {
    const f = fixture(t);
    if (content === null) f.git(f.checkout, "rm", "-q", "-f", ".atelier/publication.json");
    else f.put(".atelier/publication.json", content);
    const r = f.publish();
    assert.equal(r.ok, false, name);
    assert.match(r.text, /Not published: .*(publication policy|publication\.json)/, name);
    assert.deepEqual(f.refs(), [], name);
  }
});

test("globs: a name matches at any depth, ** crosses folders, * does not", () => {
  const m = globMatcher("*.pem");
  assert.ok(m("a.pem") && m("x/y/a.pem") && !m("a.pem.txt"));
  const d = globMatcher("private/**");
  assert.ok(d("private/a") && d("private/x/y") && !d("x/private/a"));
  const s = globMatcher("docs/*.md");
  assert.ok(s("docs/a.md") && !s("docs/x/a.md"));
});

test("atelier publish REMOTE runs through the CLI and refuses without a policy; a bare publish is the baseline's", (t) => {
  const f = fixture(t);
  f.git(f.checkout, "rm", "-q", "-f", ".atelier/publication.json");
  writeFileSync(join(f.dir, "config.json"), JSON.stringify({ server: "https://fake.invalid", owner: "owner", projects: { demo: { path: f.checkout, branch: "main" } } }));
  const env = { ...process.env, ATELIER_CONFIG_DIR: f.dir, ATELIER_CACHE: join(f.dir, "cache"), ATELIER_TOKEN: "fake", ATELIER_SERVER: "https://fake.invalid", GIT_CONFIG_NOSYSTEM: "1" };
  const run = (...a) => spawnSync(process.execPath, [cli, ...a, "--project", "demo"], { cwd: f.dir, encoding: "utf8", env });
  const r = run("publish", "github");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Not published: no publication policy/);
  assert.deepEqual(f.refs(), []);
  // Bare publish still asks the server for a write token, which this one cannot reach.
  const bare = run("publish");
  assert.notEqual(bare.status, 0);
  assert.doesNotMatch(bare.stdout, /Not published/);
  assert.equal(run("publish", "a", "b").status, 1);
});
