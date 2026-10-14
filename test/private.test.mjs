// Private files (t645): a project names files that stay on the developer's
// Macs, kept in its iCloud folder and linked into the checkout; Git ignores
// them and Atelier never commits or pushes them. Every folder is under
// os.tmpdir(), HOME included, so the iCloud folder here is a stand-in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { guardedPaths, linkPrivate, privateChanges, privateCommits, privateHome, privateRefusal } from "../cli/private.mjs";

const cli = resolve("cli/atelier.mjs");

function setup(t, { folder = "Demo" } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "atelier-private-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "gitconfig"), "");
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "gitconfig"), GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@x.test", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@x.test" };
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env }).trim();
  const home = join(root, "home");
  const icloud = join(home, "Library", "Mobile Documents", "com~apple~CloudDocs", "ai-projects");
  const keep = join(icloud, folder);
  mkdirSync(join(keep, "notes"), { recursive: true });
  writeFileSync(join(keep, "PROJECT.md"), "the plan\n");
  writeFileSync(join(keep, "notes", "plan.md"), "notes\n");
  const checkout = join(root, "src", "demo");
  mkdirSync(checkout, { recursive: true });
  git(checkout, "init", "-q", "-b", "main");
  writeFileSync(join(checkout, "file.txt"), "code\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "-q", "-m", "first");
  const config = join(root, "config");
  mkdirSync(config);
  const write = (projects) => writeFileSync(join(config, "config.json"), JSON.stringify({ server: "http://127.0.0.1:9", owner: "owner", projects }));
  const read = () => JSON.parse(readFileSync(join(config, "config.json"), "utf8"));
  write({ demo: { path: checkout, branch: "main", protect: [] } });
  const run = (...argv) => {
    const r = spawnSync(process.execPath, [cli, ...argv, "--project", "demo"], { cwd: root, encoding: "utf8", env: { ...env, HOME: home, ATELIER_CONFIG_DIR: config, ATELIER_CACHE: join(root, "cache"), ATELIER_SERVER: "http://127.0.0.1:9", ATELIER_TOKEN: "t", ATELIER_ACTOR: "owner" } });
    return { code: r.status, output: `${r.stdout}${r.stderr}` };
  };
  return { root, env, git, home, icloud, keep, checkout, write, read, run };
}

test("private add names the files, links them from the project's iCloud folder and has Git ignore them; ls reports them", (t) => {
  const f = setup(t);
  const r = f.run("private", "add", "PROJECT.md", "notes/plan.md", "./notes/plan.md");
  assert.equal(r.code, 0, r.output);
  assert.deepEqual(f.read().projects.demo.private, ["PROJECT.md", "notes/plan.md"]);
  assert.equal(f.read().projects.demo.privateHome, undefined, "the folder is found by the project's name, not stored");
  for (const path of ["PROJECT.md", "notes/plan.md"]) {
    assert.ok(lstatSync(join(f.checkout, path)).isSymbolicLink(), path);
    assert.equal(readlinkSync(join(f.checkout, path)), join(f.keep, path));
  }
  assert.equal(readFileSync(join(f.checkout, "PROJECT.md"), "utf8"), "the plan\n");
  // Git ignores them through info/exclude, never .gitignore, which is pushed.
  assert.equal(f.git(f.checkout, "status", "--porcelain", "--untracked-files=all"), "");
  assert.ok(!existsSync(join(f.checkout, ".gitignore")));
  assert.match(readFileSync(join(f.checkout, ".git", "info", "exclude"), "utf8"), /^\/PROJECT\.md$/m);
  f.git(f.checkout, "add", "-A");
  assert.equal(f.git(f.checkout, "diff", "--cached", "--name-only"), "", "git add -A stages none of them");
  // A second add changes nothing and writes no second exclude line.
  const again = f.run("private", "add", "PROJECT.md");
  assert.equal(again.code, 0, again.output);
  assert.equal(readFileSync(join(f.checkout, ".git", "info", "exclude"), "utf8").split("\n").filter((l) => l === "/PROJECT.md").length, 1);
  const ls = f.run("private", "ls");
  assert.equal(ls.code, 0, ls.output);
  assert.match(ls.output, new RegExp(`kept in ${f.keep} \\(found by demo's name\\)`));
  assert.match(ls.output, /PROJECT\.md \(listed in iCloud and on this Mac\): linked; ignored by Git/);
  assert.match(ls.output, /notes\/plan\.md \(listed in iCloud and on this Mac\): linked; ignored by Git/);
  // The list beside the files follows the developer to every Mac: sorted,
  // each path once, and never linked into the checkout.
  assert.equal(readFileSync(join(f.keep, ".atelier-private"), "utf8").split("\n").filter((l) => l && !l.startsWith("#")).join(","), "PROJECT.md,notes/plan.md");
  assert.ok(!existsSync(join(f.checkout, ".atelier-private")));
  assert.equal(f.run("private", "add", ".atelier-private").code, 1, "the list itself is never private-linked");
});

test("private add never overwrites a file in the checkout, refuses a tracked file and skips one missing from the folder", (t) => {
  const f = setup(t);
  writeFileSync(join(f.checkout, "PROJECT.md"), "a local copy\n");
  const r = f.run("private", "add", "PROJECT.md", "ghost.md");
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /PROJECT\.md: a file Atelier did not link is already in the checkout; it was left as it is/);
  assert.match(r.output, /ghost\.md: not in .*; not linked/);
  assert.equal(readFileSync(join(f.checkout, "PROJECT.md"), "utf8"), "a local copy\n");
  assert.ok(!lstatSync(join(f.checkout, "PROJECT.md")).isSymbolicLink());
  // Still ignored, so git add -A does not take the local copy either.
  assert.equal(f.git(f.checkout, "status", "--porcelain", "--untracked-files=all"), "");
  const tracked = f.run("private", "add", "file.txt");
  assert.equal(tracked.code, 1, tracked.output);
  assert.match(tracked.output, /Git tracks file\.txt/);
  assert.deepEqual(f.read().projects.demo.private, ["PROJECT.md", "ghost.md"], "the tracked file was not named");
  const outside = f.run("private", "add", "../x.md");
  assert.equal(outside.code, 1);
  assert.match(outside.output, /nothing was changed/);
});

test("--home names the folder; a checkout that is that folder keeps its files in place and only ignores them", (t) => {
  const f = setup(t, { folder: "Elsewhere" });
  const missing = f.run("private", "add", "PROJECT.md");
  assert.equal(missing.code, 0, missing.output);
  assert.match(missing.output, /Private files not linked: no folder in .* is named for demo/);
  assert.ok(!existsSync(join(f.checkout, "PROJECT.md")));
  const r = f.run("private", "add", "PROJECT.md", "--home", f.keep);
  assert.equal(r.code, 0, r.output);
  assert.equal(f.read().projects.demo.privateHome, f.keep);
  assert.equal(readlinkSync(join(f.checkout, "PROJECT.md")), join(f.keep, "PROJECT.md"));
  // The iCloud checkout of today: the checkout is the folder itself.
  const g = setup(t);
  g.git(g.keep, "init", "-q", "-b", "main");
  g.write({ demo: { path: g.keep, branch: "main", protect: [] } });
  const inPlace = g.run("private", "add", "PROJECT.md");
  assert.equal(inPlace.code, 0, inPlace.output);
  assert.match(inPlace.output, /Private files stay where they are/);
  // There the list sits in the checkout itself, and Git ignores it too.
  assert.ok(existsSync(join(g.keep, ".atelier-private")));
  assert.equal(g.git(g.keep, "check-ignore", ".atelier-private"), ".atelier-private");
  g.git(g.keep, "commit", "-q", "--allow-empty", "-m", "first");
  g.git(g.keep, "add", "-f", ".atelier-private");
  assert.deepEqual(privateChanges(g.keep, guardedPaths("demo", g.read().projects.demo, g.icloud)), [".atelier-private"], "the list is never staged either");
  assert.ok(lstatSync(join(g.keep, "PROJECT.md")).isFile());
  assert.equal(g.git(g.keep, "status", "--porcelain", "--untracked-files=all").split("\n").filter((l) => l.includes("PROJECT.md")).length, 0);
});

test("a folder named for the project is found case-, space- and hyphen-insensitively, and two are refused", (t) => {
  const f = setup(t, { folder: "de mo" });
  assert.equal(privateHome("De-Mo", {}, f.icloud).home, join(f.icloud, "de mo"));
  mkdirSync(join(f.icloud, "DEMO"));
  assert.match(privateHome("demo", {}, f.icloud).error, /more than one folder .* \(DEMO, de mo\)/);
  assert.equal(privateHome("demo", { privateHome: "/x" }, f.icloud).home, "/x");
});

test("linkPrivate replaces a stale link of its own and leaves a link under a linked folder alone", (t) => {
  const f = setup(t);
  symlinkSync("/nowhere/PROJECT.md", join(f.checkout, "PROJECT.md"));
  const r = linkPrivate(f.checkout, { private: ["PROJECT.md"], privateHome: f.keep }, { name: "demo" });
  assert.deepEqual(r.linked, ["PROJECT.md"]);
  assert.equal(readlinkSync(join(f.checkout, "PROJECT.md")), join(f.keep, "PROJECT.md"));
  // A folder of the checkout that is itself a link would put the new link outside it.
  const outside = join(f.root, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(f.checkout, "docs"));
  mkdirSync(join(f.keep, "docs"));
  writeFileSync(join(f.keep, "docs", "x.md"), "x\n");
  const s = linkPrivate(f.checkout, { private: ["docs/x.md"], privateHome: f.keep }, { name: "demo" });
  assert.deepEqual(s.refused, ["docs/x.md"]);
  assert.ok(!existsSync(join(outside, "x.md")));
});

test("special characters in a private path are ignored by Git as that path alone", (t) => {
  const f = setup(t);
  const names = ["a*b.md", "[x].md", "#plan", "!bang", "q?.md"];
  for (const n of names) writeFileSync(join(f.keep, n), "p\n");
  for (const n of ["ab.md", "aXb.md", "x.md", "qz.md"]) writeFileSync(join(f.checkout, n), "public\n");
  linkPrivate(f.checkout, { private: names, privateHome: f.keep }, { name: "demo" });
  const untracked = f.git(f.checkout, "ls-files", "--others", "--exclude-standard").split("\n").sort();
  assert.deepEqual(untracked, ["aXb.md", "ab.md", "qz.md", "x.md"], "only the private names are ignored, not what their patterns would match");
});

test("privateCommits finds a private file a commit adds, changes, links or a merge brings in, and not a deletion or what the base holds", (t) => {
  const f = setup(t);
  const c = f.checkout, git = (...a) => f.git(c, ...a);
  const base = git("rev-parse", "HEAD");
  assert.deepEqual(privateCommits(c, ["PROJECT.md"], "HEAD", [base]), []);
  git("checkout", "-q", "-b", "side");
  writeFileSync(join(c, "PROJECT.md"), "leaked\n");
  git("add", "-f", "PROJECT.md");
  git("commit", "-q", "-m", "leak");
  const leak = git("rev-parse", "HEAD");
  git("checkout", "-q", "main");
  writeFileSync(join(c, "other.txt"), "x\n");
  git("add", "other.txt");
  git("commit", "-q", "-m", "other");
  git("merge", "-q", "--no-edit", "side");
  const merge = git("rev-parse", "HEAD");
  const found = privateCommits(c, ["project.md"], "HEAD", [base]);
  assert.deepEqual(found.map((x) => x.commit).sort(), [leak, merge].sort());
  assert.ok(found.every((x) => x.path === "PROJECT.md"));
  // Already on the base: nothing to refuse.
  assert.deepEqual(privateCommits(c, ["PROJECT.md"], "HEAD", [merge]), []);
  // A deletion carries no content.
  git("rm", "-q", "PROJECT.md");
  git("commit", "-q", "-m", "drop");
  assert.deepEqual(privateCommits(c, ["PROJECT.md"], "HEAD", [merge]), []);
  // A link committed in a private folder's place is refused as the file would be.
  symlinkSync(f.keep, join(c, "notes"));
  git("add", "-f", "notes");
  git("commit", "-q", "-m", "link");
  assert.deepEqual(privateCommits(c, ["notes"], "HEAD", [merge]).map((x) => x.path), ["notes"]);
  assert.match(privateRefusal(c, ["notes"], "HEAD", [merge], "The push"), /^The push would carry private files: notes in [0-9a-f]{12}\./);
  assert.equal(privateRefusal(c, [], "HEAD", [merge], "The push"), null);
  assert.match(privateRefusal(c, ["notes"], "no-such-ref", [], "The push"), /could not be read for private files/);
});

test("privateChanges names private files wrap would stage: forced into the index, or no longer ignored", (t) => {
  const f = setup(t);
  linkPrivate(f.checkout, { private: ["PROJECT.md", "notes"], privateHome: f.keep }, { name: "demo" });
  assert.deepEqual(privateChanges(f.checkout, ["PROJECT.md", "notes"]), []);
  f.git(f.checkout, "add", "-f", "PROJECT.md");
  assert.deepEqual(privateChanges(f.checkout, ["PROJECT.md", "notes"]), ["PROJECT.md"]);
  writeFileSync(join(f.checkout, ".git", "info", "exclude"), "");
  assert.deepEqual(privateChanges(f.checkout, ["PROJECT.md", "notes"]).sort(), ["PROJECT.md", "notes"]);
});

test("the list in iCloud is read as data: config-only names still work, each source is said, and a bad or tracked line is refused alone", (t) => {
  const f = setup(t);
  writeFileSync(join(f.keep, ".atelier-private"), ["# private", "PROJECT.md", "../../etc/passwd", "/abs.md", ".git/config", "file.txt", ".atelier-private", "", "notes"].join("\n"));
  f.write({ demo: { path: f.checkout, branch: "main", protect: [], private: ["mine.md"] } });
  writeFileSync(join(f.keep, "mine.md"), "this Mac only\n");
  const r = linkPrivate(f.checkout, f.read().projects.demo, { name: "demo", root: f.icloud });
  assert.deepEqual(r.invalid.map((x) => x.line), [3, 4, 5, 7]);
  assert.deepEqual(r.refused, ["file.txt"], "a tracked file the list names is not linked");
  assert.deepEqual(r.linked.sort(), ["PROJECT.md", "mine.md", "notes"]);
  const said = r.said.join("\n");
  for (const n of [3, 4, 5, 7]) assert.match(said, new RegExp(`\\.atelier-private line ${n}: .*; skipped\\.`));
  assert.ok(!existsSync(join(f.root, "etc")));
  assert.equal(f.git(f.checkout, "status", "--porcelain", "--untracked-files=all"), "");
  const ls = f.run("private", "ls");
  assert.match(ls.output, /PROJECT\.md \(listed in iCloud\): linked/);
  assert.match(ls.output, /mine\.md \(listed on this Mac\): linked/);
  assert.match(ls.output, /file\.txt \(listed in iCloud\): Git tracks it in the checkout/);
  assert.match(ls.output, /\.atelier-private line 3: .*skipped/);
  // Every command's guard reads the list too, and holds the list itself.
  assert.deepEqual(guardedPaths("demo", f.read().projects.demo, f.icloud).sort(), [".atelier-private", "PROJECT.md", "file.txt", "mine.md", "notes"].sort());
});
