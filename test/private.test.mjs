// Private files (t645): a project names files that stay on the developer's
// Macs, kept in its iCloud folder and linked into the checkout; Git ignores
// them and Atelier never commits or pushes them. Every folder is under
// os.tmpdir(), HOME included, so the iCloud folder here is a stand-in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, utimesSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parsePrivateList, privateListText, privatePath } from "../src/rules.ts";
import { privateConfig } from "./fixtures/private-config.mjs";
import { discoverPrivate, excludesPrivate, lockKey, mergeConfigForSave, moveProjectEntry, moveProjectEntryOnDisk, saveWholeConfig, savePrivateFields, guardedPush, linkPrivate, privateGuardFor, readPrivateList, useConfig, privateGuard, remoteBases, privateChanges, privateCommits, privateHome, privateRefusal } from "../cli/private.mjs";
// No test reads this Mac's own iCloud folder (t645).
process.env.ATELIER_PRIVATE_ROOT ||= `${process.env.TMPDIR || "/tmp"}/atelier-tests-no-icloud-${process.pid}`;

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
    const r = spawnSync(process.execPath, [cli, ...argv, "--project", "demo"], { cwd: root, encoding: "utf8", env: { ...env, HOME: home, ATELIER_PRIVATE_ROOT: icloud, ATELIER_CONFIG_DIR: config, ATELIER_CACHE: join(root, "cache"), ATELIER_SERVER: "http://127.0.0.1:9", ATELIER_TOKEN: "t", ATELIER_ACTOR: "owner" } });
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
  assert.deepEqual(privateChanges(g.keep, privateGuard("demo", g.read().projects.demo, { root: g.icloud }).paths), [".atelier-private"], "the list is never staged either");
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
  // Atelier linked it from a folder that has since moved.
  const moved = join(f.root, "moved");
  mkdirSync(moved);
  writeFileSync(join(moved, "PROJECT.md"), "old\n");
  assert.deepEqual(linkPrivate(f.checkout, { private: ["PROJECT.md"], privateHome: moved }, { name: "demo" }).linked, ["PROJECT.md"]);
  rmSync(moved, { recursive: true });
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
  const names = ["a*b.md", "[x].md", "!bang", "q?.md"];
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
  // Already on the base: nothing is pushed, so nothing is refused.
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
  assert.deepEqual(privateGuard("demo", f.read().projects.demo, { root: f.icloud }).paths.sort(), [".atelier-private", "PROJECT.md", "file.txt", "mine.md", "notes"].sort());
});

// Astra's review of t645, finding 4: a list that could not be read shrank
// what was guarded to nothing. Each list read is kept in this Mac's config,
// and a list that cannot be read with no copy kept refuses the push.
test("the guard keeps a copy of each list it reads and fails closed when the list cannot be read and no copy is kept", (t) => {
  const f = setup(t);
  writeFileSync(join(f.keep, ".atelier-private"), "PROJECT.md\n");
  const entry = { path: f.checkout, branch: "main" };
  let saved = 0;
  // Opt-in (third reviews of t645): nothing configured, nothing guarded and
  // nothing read; discovery (clone, private add, ls) keeps the list's copy,
  // which opts the project in.
  assert.deepEqual(privateGuard("demo", entry, { root: join(f.root, "never-read") }), { paths: [], refusal: null });
  discoverPrivate("demo", entry, { root: f.icloud, save: () => saved++ });
  assert.deepEqual(entry.privateFromList, ["PROJECT.md"]);
  assert.equal(saved, 1);
  const read = privateGuard("demo", entry, { root: f.icloud, save: () => saved++ });
  assert.deepEqual(read, { paths: ["PROJECT.md", ".atelier-private"], refusal: null });
  assert.equal(saved, 1, "an unchanged list is not saved again");
  // The folder gone from this Mac: the copy still guards.
  rmSync(f.keep, { recursive: true });
  assert.deepEqual(privateGuard("demo", { ...entry, privateHome: f.keep }, { root: f.icloud }).paths, ["PROJECT.md", ".atelier-private"]);
  // No copy: refused, naming where the list should be.
  const none = privateGuard("demo", { path: f.checkout, privateHome: f.keep, private: ["mine.md"] }, { root: f.icloud });
  assert.match(none.refusal, new RegExp(`${f.keep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}, the folder that keeps demo's private files and their list, is not on this Mac.*Nothing was pushed\\.`));
  assert.ok(none.paths.includes("mine.md"), "what is known is still guarded");
  let pushed = false;
  privateConfig(t, { demo: { path: f.checkout, privateHome: f.keep, private: ["mine.md"], privateFromList: undefined } });
  assert.throws(() => guardedPush({ project: "demo", cwd: f.checkout, tip: "HEAD", what: "The push" }, () => { pushed = true; }), /The push: .*is not on this Mac/);
  assert.equal(pushed, false);
  assert.throws(() => guardedPush({ cwd: f.checkout, tip: "HEAD", what: "The push" }, () => { pushed = true; }), /needs the project's name/, "no push goes unnamed");
  assert.equal(pushed, false);
  // An unreadable list, with no copy, is refused the same way.
  const g = setup(t);
  mkdirSync(join(g.keep, ".atelier-private"));
  assert.match(privateGuard("demo", { path: g.checkout, private: ["mine.md"] }, { root: g.icloud }).refusal, /\.atelier-private cannot be read/);
  // A project with no folder and nothing named guards nothing and refuses nothing.
  assert.deepEqual(privateGuard("other", { path: g.checkout }, { root: g.icloud }), { paths: [], refusal: null });
});

// Astra's review of t645, findings 5 and 7, and Argon's finding 1.
test("the commit scan sees root commits whatever log.showRoot says, reads paths NUL-framed and matches names as a Mac does", (t) => {
  const f = setup(t);
  const repo = join(f.root, "fresh");
  mkdirSync(repo);
  const g = (...a) => f.git(repo, ...a);
  g("init", "-q", "-b", "main");
  writeFileSync(join(f.root, "gitconfig"), "[log]\n\tshowRoot = false\n[diff]\n\tnoprefix = true\n\trenames = copies\n\trelative = true\n[core]\n\tquotePath = true\n");
  writeFileSync(join(repo, "PROJECT.md"), "the plan\n");
  writeFileSync(join(repo, "odd\u0001name C" + "a".repeat(40)), "x\n");
  writeFileSync(join(repo, ":x"), "x\n");
  g("add", "-A");
  g("commit", "-q", "-m", "root");
  const root = g("rev-parse", "HEAD");
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = join(f.root, "gitconfig");
  try {
    assert.deepEqual(privateCommits(repo, ["PROJECT.md"], "HEAD"), [{ commit: root, path: "PROJECT.md" }]);
    assert.deepEqual(privateCommits(repo, ["odd\u0001name C" + "a".repeat(40)], "HEAD").map((x) => x.path), ["odd\u0001name C" + "a".repeat(40)]);
    assert.deepEqual(privateCommits(repo, [":x"], "HEAD").map((x) => x.path), [":x"]);
    // A name committed decomposed and in another case is the same file on a Mac.
    const nfd = "Café.md";
    writeFileSync(join(repo, "x.txt"), "x\n");
    g("add", "x.txt");
    g("commit", "-q", "-m", "x");
    g("update-index", "--add", "--cacheinfo", `100644,${g("hash-object", "-w", "x.txt")},${nfd}`);
    g("commit", "-q", "-m", "decomposed");
    assert.deepEqual(privateCommits(repo, ["CAFÉ.md"], "HEAD", [root]).map((x) => x.path.normalize("NFC")), ["Café.md"]);
  } finally {
    if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previous;
  }
});

test("a file Git tracks under another case is refused as tracked, and never replaced by a link", (t) => {
  const f = setup(t);
  writeFileSync(join(f.checkout, "project.md"), "tracked\n");
  f.git(f.checkout, "add", "project.md");
  f.git(f.checkout, "commit", "-q", "-m", "tracked");
  const r = f.run("private", "add", "PROJECT.md");
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /Git tracks PROJECT\.md/);
  // Named through the list instead, it is still not linked over the tracked file.
  writeFileSync(join(f.keep, ".atelier-private"), "PROJECT.md\n");
  const linked = linkPrivate(f.checkout, { path: f.checkout }, { name: "demo", root: f.icloud });
  assert.deepEqual(linked.refused, ["PROJECT.md"]);
  assert.equal(readFileSync(join(f.checkout, "project.md"), "utf8"), "tracked\n");
  assert.ok(!lstatSync(join(f.checkout, "project.md")).isSymbolicLink());
});

test("private ls takes no --home", (t) => {
  const f = setup(t);
  const r = f.run("private", "ls", "--home", f.keep);
  assert.notEqual(r.code, 0);
  assert.match(r.output, /usage: atelier private add/);
});

test("every name privatePath accepts comes back unchanged from the list in iCloud", () => {
  for (const bad of ["#plan", "  PROJECT.md", "PROJECT.md ", "a\tb", "a\u0001b", "x\u007f"]) assert.ok("error" in privatePath(bad), JSON.stringify(bad));
  const names = ["PROJECT.md", "notes/a b.md", "!bang", "a#b", "[x].md", "Café.md", "dir/#inner"].map((n) => privatePath(n).path);
  assert.ok(names.every(Boolean));
  assert.deepEqual(parsePrivateList(privateListText(names)).paths.sort(), [...names].sort());
});

// Second reviews of t645 (Astra 1, Argon 3): a missing list emptied the copy
// kept, and an ai-projects folder that could not be read guarded nothing.
test("a missing list never shrinks the copy kept, and an unreadable iCloud folder refuses unless a copy is kept", (t) => {
  const f = setup(t);
  const entry = { path: f.checkout, privateFromList: ["PROJECT.md"] };
  let saved = 0;
  // The folder is there, its list is not (not synced yet, or evicted).
  const g = privateGuard("demo", entry, { root: f.icloud, save: () => saved++ });
  assert.deepEqual(entry.privateFromList, ["PROJECT.md"], "the copy is kept as it was");
  assert.equal(saved, 0);
  assert.deepEqual(g, { paths: ["PROJECT.md", ".atelier-private"], refusal: null });
  // A list that is there and read is joined to it; no read removes a name.
  writeFileSync(join(f.keep, ".atelier-private"), "notes\n");
  privateGuard("demo", entry, { root: f.icloud, save: () => saved++ });
  assert.deepEqual(entry.privateFromList, ["PROJECT.md", "notes"]);
  // An ai-projects folder this Mac cannot read: refused with no copy, guarded by the copy otherwise.
  const blocked = join(f.root, "blocked");
  mkdirSync(blocked);
  chmodSync(blocked, 0o000);
  let none, kept;
  try {
    none = privateGuard("demo", { path: f.checkout, private: ["mine.md"] }, { root: blocked });
    kept = privateGuard("demo", { path: f.checkout, privateFromList: ["PROJECT.md"] }, { root: blocked });
  } finally { chmodSync(blocked, 0o755); }
  assert.match(none.refusal ?? "", /cannot be read .*Nothing was pushed\./);
  assert.deepEqual(kept, { paths: ["PROJECT.md", ".atelier-private"], refusal: null });
  // No ai-projects folder on this Mac at all is no folder for the project.
  assert.deepEqual(privateGuard("demo", { path: f.checkout, private: ["mine.md"] }, { root: join(f.root, "absent") }), { paths: ["mine.md", ".atelier-private"], refusal: null });
  // And a project with nothing configured never reads it, readable or not.
  chmodSync(blocked, 0o000);
  try { assert.deepEqual(privateGuard("demo", { path: f.checkout }, { root: blocked }), { paths: [], refusal: null }); } finally { chmodSync(blocked, 0o755); }
});

// Second reviews of t645 (Astra 2 and 3, Argon 2): post-merge recovery and
// the task refresh dropped the project's configuration. The guard now reads
// it by the project's name, so a name kept only in config, with its own
// folder, is guarded on every path.
test("guardedPush reads the project's own configuration by name: config-only names and its own folder", (t) => {
  const f = setup(t);
  const c = f.checkout;
  writeFileSync(join(c, "secret.md"), "x\n");
  f.git(c, "add", "-f", "secret.md");
  f.git(c, "commit", "-q", "-m", "by hand");
  privateConfig(t, { demo: { path: c, private: ["secret.md"], privateHome: f.keep } });
  let pushed = false;
  assert.throws(() => guardedPush({ project: "demo", cwd: c, tip: "HEAD", what: "The refresh" }, () => { pushed = true; }), /The refresh would carry private files: secret\.md/);
  assert.equal(pushed, false);
  guardedPush({ project: "elsewhere", cwd: c, tip: "HEAD", what: "The refresh" }, () => { pushed = true; });
  assert.equal(pushed, true, "another project's names are not this one's");
});

// Argon's second review of t645, finding 1: a merge whose first parent still
// held a removed private file showed nothing against that parent.
test("a merge is compared with every parent, so one whose first parent keeps a removed private file is refused", (t) => {
  const f = setup(t);
  const c = f.checkout, g = (...a) => f.git(c, ...a);
  writeFileSync(join(c, "PROJECT.md"), "the plan\n");
  g("add", "-f", "PROJECT.md");
  g("commit", "-q", "-m", "A");
  const a = g("rev-parse", "HEAD");
  g("rm", "-q", "--cached", "PROJECT.md");
  g("commit", "-q", "-m", "B");
  const b = g("rev-parse", "HEAD");
  rmSync(join(c, "PROJECT.md"));
  g("checkout", "-q", a);
  g("merge", "-q", "-s", "ours", "--no-edit", b);
  const m = g("rev-parse", "HEAD");
  g("rm", "-q", "PROJECT.md");
  g("commit", "-q", "-m", "N");
  // The tree pushed holds no PROJECT.md; only the merge brings it back over B.
  assert.deepEqual(privateCommits(c, ["PROJECT.md"], "HEAD", [b]), [{ commit: m, path: "PROJECT.md" }]);
});

test("a path is checked as it will be kept, so no accepted spelling fails to read back from the list", () => {
  for (const bad of ["./#plan", "./ PROJECT.md", "PROJECT.md /", "./PROJECT.md /", "notes/ "]) assert.ok("error" in privatePath(bad), JSON.stringify(bad));
  // Every accepted spelling of many generated names reads back as kept.
  const pieces = ["", ".", "./", "/", " ", "#", "a", "B", "é", "\t", "-", "!", "[", "*", "..", ".git", "x y"];
  let accepted = 0;
  for (const p1 of pieces) for (const p2 of pieces) for (const p3 of pieces) {
    const r = privatePath(p1 + p2 + p3);
    if (!("path" in r)) continue;
    accepted++;
    assert.deepEqual(parsePrivateList(privateListText([r.path])).paths, [r.path], JSON.stringify(p1 + p2 + p3));
    assert.deepEqual(privatePath(r.path), r, "a kept name is accepted as it is");
  }
  assert.ok(accepted > 100);
});

// Argon's third review of t645, finding 2: only the tip's tree was read, so
// a pushed commit between base and tip could still hold a private file, and
// a stepped push could leave the remote at it.
test("the tree of every commit pushed is read, not only the tip's", (t) => {
  const f = setup(t);
  const c = f.checkout, g = (...a) => f.git(c, ...a);
  writeFileSync(join(c, "PROJECT.md"), "the plan\n");
  g("add", "-f", "PROJECT.md");
  g("commit", "-q", "-m", "A");
  const a = g("rev-parse", "HEAD");
  g("rm", "-q", "--cached", "PROJECT.md");
  g("commit", "-q", "-m", "B, on the remote");
  const b = g("rev-parse", "HEAD");
  rmSync(join(c, "PROJECT.md"));
  // Case A: a side line from A that keeps PROJECT.md unchanged, merged
  // over B keeping B's tree.
  g("checkout", "-q", "-b", "side", a);
  writeFileSync(join(c, "other.txt"), "x\n");
  g("add", "other.txt");
  g("commit", "-q", "-m", "C1");
  const c1 = g("rev-parse", "HEAD");
  g("checkout", "-q", "main");
  g("merge", "-q", "-s", "ours", "--no-edit", "side");
  assert.ok(privateCommits(c, ["PROJECT.md"], "HEAD", [b]).some((x) => x.commit === c1 && x.path === "PROJECT.md"));
  // Case B: B itself held PROJECT.md; C1 leaves it, C2 removes it. A
  // stepped push could stop at C1, so C1 is refused.
  g("checkout", "-q", "-b", "stepped", a);
  writeFileSync(join(c, "other.txt"), "y\n");
  g("add", "other.txt");
  g("commit", "-q", "-m", "C1");
  const s1 = g("rev-parse", "HEAD");
  g("rm", "-q", "PROJECT.md");
  g("commit", "-q", "-m", "C2");
  assert.deepEqual(privateCommits(c, ["PROJECT.md"], "HEAD", [a]).map((x) => x.commit), [s1]);
});

// Astra's third review of t645, finding 3: a tracked .gitignore with
// !PROJECT.md outweighs .git/info/exclude.
test("a rule in the checkout that un-ignores a private file is warned of, and Atelier still refuses to stage it", (t) => {
  const f = setup(t);
  writeFileSync(join(f.checkout, ".gitignore"), "!PROJECT.md\n");
  f.git(f.checkout, "add", ".gitignore");
  f.git(f.checkout, "commit", "-q", "-m", "unignore");
  const r = f.run("private", "add", "PROJECT.md");
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /Warning: Git does not ignore PROJECT\.md here: a rule in the checkout/);
  assert.match(f.git(f.checkout, "status", "--porcelain"), /\?\? PROJECT\.md/, "git sees it, as the warning says");
  const ls = f.run("private", "ls");
  assert.match(ls.output, /PROJECT\.md \(listed in iCloud and on this Mac\): linked; NOT ignored by Git/);
  assert.deepEqual(privateChanges(f.checkout, privateGuard("demo", f.read().projects.demo, { root: f.icloud }).paths), ["PROJECT.md"], "what wrap would stage includes it, so wrap refuses");
});

// Astra's fourth review of t645, finding 1: a long-running process (the
// integrator) kept the config it started with, so a name made private by
// another process later was not guarded.
test("a guard in a process started earlier honours a name another process made private since", (t) => {
  const f = setup(t);
  writeFileSync(join(f.keep, "secret.md"), "s\n");
  // This process registered its config at startup, as the CLI does; then
  // another process names secret.md private.
  const memory = JSON.parse(readFileSync(join(f.root, "config", "config.json"), "utf8"));
  useConfig(memory, () => {});
  const previous = { dir: process.env.ATELIER_CONFIG_DIR, root: process.env.ATELIER_PRIVATE_ROOT };
  process.env.ATELIER_CONFIG_DIR = join(f.root, "config");
  process.env.ATELIER_PRIVATE_ROOT = f.icloud;
  t.after(() => {
    useConfig(null);
    for (const [key, value] of [["ATELIER_CONFIG_DIR", previous.dir], ["ATELIER_PRIVATE_ROOT", previous.root]]) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  });
  assert.deepEqual(privateGuardFor("demo"), { paths: [], refusal: null }, "nothing is private when it starts");
  assert.equal(f.run("private", "add", "secret.md").code, 0);
  // A task commit holding it, pushed from this process.
  rmSync(join(f.checkout, "secret.md"));
  writeFileSync(join(f.checkout, "secret.md"), "s\n");
  f.git(f.checkout, "add", "-f", "secret.md");
  f.git(f.checkout, "commit", "-q", "-m", "task");
  let pushed = false;
  assert.throws(() => guardedPush({ project: "demo", cwd: f.checkout, tip: "HEAD", base: ["HEAD~1"], what: "The refresh" }, () => { pushed = true; }), /The refresh would carry private files: secret\.md/);
  assert.equal(pushed, false);
  // And a name this process holds but has not written is honoured too.
  memory.projects.demo.private.push("mine.md");
  assert.ok(privateGuardFor("demo").paths.includes("mine.md"));
});

// Astra's fourth review of t645, finding 2: with the list gone missing,
// private add wrote a list of the new name alone, and discovery then dropped
// the names only the copy held.
test("private add never writes the list without a name it knows; only private remove drops one", (t) => {
  const f = setup(t);
  writeFileSync(join(f.keep, ".atelier-private"), "PROJECT.md\n");
  writeFileSync(join(f.keep, "notes.md"), "n\n");
  assert.equal(f.run("private", "ls").code, 0, "ls finds the list and keeps its copy");
  assert.deepEqual(f.read().projects.demo.privateFromList, ["PROJECT.md"]);
  rmSync(join(f.keep, ".atelier-private"));
  const r = f.run("private", "add", "notes.md");
  assert.equal(r.code, 0, r.output);
  const listed = () => parsePrivateList(readFileSync(join(f.keep, ".atelier-private"), "utf8")).paths;
  assert.deepEqual(listed(), ["PROJECT.md", "notes.md"]);
  assert.deepEqual(f.read().projects.demo.privateFromList, ["PROJECT.md", "notes.md"]);
  assert.ok(lstatSync(join(f.checkout, "PROJECT.md")).isSymbolicLink(), "still linked");
  // private remove is the one way out.
  const removed = f.run("private", "remove", "PROJECT.md");
  assert.equal(removed.code, 0, removed.output);
  assert.deepEqual(listed(), ["notes.md"]);
  assert.deepEqual(f.read().projects.demo.privateFromList, ["notes.md"]);
  assert.ok(!f.read().projects.demo.private.includes("PROJECT.md"));
  assert.ok(!existsSync(join(f.checkout, "PROJECT.md")), "its link is gone");
  assert.ok(existsSync(join(f.keep, "PROJECT.md")), "the file in iCloud is left");
  assert.notEqual(f.run("private", "remove", "nothing.md").code, 0);
});

// Astra's fifth review of t645, finding 1: every lstat error was taken for
// "nothing there", so a list that could not be read counted as no list.
test("a list that cannot be reached is unreadable, not missing, and an opted-in project refuses", (t) => {
  const f = setup(t);
  writeFileSync(join(f.keep, ".atelier-private"), "PROJECT.md\n");
  chmodSync(f.keep, 0o600); // readable, but nothing in it can be reached
  let read, guard;
  try {
    read = readPrivateList(f.keep);
    guard = privateGuard("demo", { path: f.checkout, private: ["mine.md"], privateHome: f.keep }, { root: f.icloud });
  } finally { chmodSync(f.keep, 0o755); }
  assert.equal(read.exists, true);
  assert.match(read.unreadable, /\.atelier-private cannot be read \(EACCES\)/);
  assert.match(guard.refusal ?? "", /cannot be read \(EACCES\).*Nothing was pushed\./);
});

// Astra's fifth review of t645, finding 2: names only the copy of the list
// held were left out of what linkPrivate worked on.
test("names only this Mac's copy of the list holds are excluded and reported when the folder is gone", (t) => {
  const f = setup(t);
  const gone = join(f.root, "gone");
  const r = linkPrivate(f.checkout, { path: f.checkout, privateHome: gone, privateFromList: ["PROJECT.md"] }, { name: "demo", root: f.icloud });
  assert.equal(r.missingHome, true);
  assert.match(r.said.join("\n"), /Private files not linked: .*gone, the folder that keeps them, is not on this Mac/);
  assert.ok(excludesPrivate(f.checkout, "PROJECT.md"), "Git ignores it meanwhile");
});

// Astra's fifth review of t645, finding 3: private add replaced a list it
// could not read with the names known here.
test("private add and remove refuse a list they cannot read, and change nothing", (t) => {
  const f = setup(t);
  const file = join(f.keep, ".atelier-private");
  writeFileSync(file, "PROJECT.md\nother.md\n");
  chmodSync(file, 0o000);
  const before = f.read();
  let add, remove;
  try {
    add = f.run("private", "add", "notes.md");
    remove = f.run("private", "remove", "PROJECT.md");
  } finally { chmodSync(file, 0o644); }
  assert.notEqual(add.code, 0);
  assert.match(add.output, /\.atelier-private cannot be read \(EACCES\); nothing was changed/);
  assert.notEqual(remove.code, 0);
  assert.match(remove.output, /cannot be read.*nothing was changed/);
  assert.equal(readFileSync(file, "utf8"), "PROJECT.md\nother.md\n", "the list is as it was");
  assert.deepEqual(f.read(), before, "the config is as it was");
});

// Astra's sixth review of t645, finding 2: the guard saved by writing the
// whole config the process held in memory, which, in a process started
// earlier (the integrator), erased what another process wrote since.
test("the guard writes only its own project's private settings, against the config as it is on disk", (t) => {
  const f = setup(t);
  const otherKeep = join(f.root, "other-keep");
  mkdirSync(otherKeep);
  writeFileSync(join(otherKeep, ".atelier-private"), "x.md\n");
  f.write({ demo: { path: f.checkout, branch: "main", protect: [] }, other: { path: f.root, branch: "main", privateHome: otherKeep } });
  // The integrator starts, holding the config as it is now.
  const memory = JSON.parse(readFileSync(join(f.root, "config", "config.json"), "utf8"));
  useConfig(memory);
  const previous = { dir: process.env.ATELIER_CONFIG_DIR, root: process.env.ATELIER_PRIVATE_ROOT };
  process.env.ATELIER_CONFIG_DIR = join(f.root, "config");
  process.env.ATELIER_PRIVATE_ROOT = f.icloud;
  t.after(() => {
    useConfig(null);
    for (const [key, value] of [["ATELIER_CONFIG_DIR", previous.dir], ["ATELIER_PRIVATE_ROOT", previous.root]]) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  });
  // Another process makes a file of demo private.
  writeFileSync(join(f.keep, "secret.md"), "s\n");
  assert.equal(f.run("private", "add", "secret.md").code, 0);
  // The integrator's guard for other reads other's list and keeps its copy.
  assert.ok(privateGuardFor("other").paths.includes("x.md"));
  const disk = f.read();
  assert.deepEqual(disk.projects.other.privateFromList, ["x.md"], "other's copy is written");
  assert.deepEqual(disk.projects.demo.private, ["secret.md"], "demo's settings, written by the other process, survive");
});

// Astra's sixth review of t645, finding 1: after projects rename the config
// entry has the new name, while a workspace made before still names the old
// one, and the guard looked only under the name it was given.
test("a project renamed since is guarded under its former name", (t) => {
  const f = setup(t);
  f.write({ renamed: { path: f.checkout, branch: "main", private: ["secret.md"], formerNames: ["demo"] } });
  const c = f.checkout;
  writeFileSync(join(c, "secret.md"), "x\n");
  f.git(c, "add", "-f", "secret.md");
  f.git(c, "commit", "-q", "-m", "task");
  const previous = process.env.ATELIER_CONFIG_DIR;
  process.env.ATELIER_CONFIG_DIR = join(f.root, "config");
  t.after(() => { if (previous === undefined) delete process.env.ATELIER_CONFIG_DIR; else process.env.ATELIER_CONFIG_DIR = previous; });
  let pushed = false;
  assert.throws(() => guardedPush({ project: "demo", cwd: c, tip: "HEAD", base: ["HEAD~1"], what: "t1's push to its fork" }, () => { pushed = true; }), /would carry private files: secret\.md/);
  assert.equal(pushed, false);
});

// Astra's eighth review of t645: after a merge joined two entries' copies of
// the list, the next read of the surviving folder's list replaced the copy,
// and the other entry's names stopped being guarded.
test("no read removes a name from the copy: a merged copy keeps guarding both entries' names", (t) => {
  const f = setup(t);
  writeFileSync(join(f.keep, ".atelier-private"), "PROJECT.md\n");
  const entry = { path: f.checkout, privateHome: f.keep, privateFromList: ["PROJECT.md", "other-notes.md"] };
  for (let i = 0; i < 2; i++) {
    const guard = privateGuard("demo", entry, { root: f.icloud, save: () => {} });
    assert.deepEqual(guard.paths.sort(), [".atelier-private", "PROJECT.md", "other-notes.md"].sort(), `guard call ${i + 1}`);
  }
  assert.deepEqual(entry.privateFromList, ["PROJECT.md", "other-notes.md"]);
});

test("a lock left by a process that is gone is taken over", (t) => {
  const f = setup(t);
  const lock = join(f.root, "config", "config.json.lock");
  writeFileSync(lock, `999999999 ${Date.now()}\n`);
  const previous = process.env.ATELIER_CONFIG_DIR;
  process.env.ATELIER_CONFIG_DIR = join(f.root, "config");
  t.after(() => { if (previous === undefined) delete process.env.ATELIER_CONFIG_DIR; else process.env.ATELIER_CONFIG_DIR = previous; });
  assert.equal(savePrivateFields("demo", { private: ["x.md"] }), true);
  assert.deepEqual(f.read().projects.demo.private, ["x.md"]);
  assert.ok(!existsSync(lock));
});

// Astra's ninth and tenth reviews of t645: writers of config.json and of the
// list in iCloud must not lose each other's change. Each test makes two
// writers overlap for certain: the first stops between its read and its
// write (testHold), the second runs meanwhile; with the lock the second
// waits, without it (ATELIER_TEST_NO_LOCK) the first's stale write loses
// the second's change, which shows the test can see a lost update.
function child(script, env) {
  const proc = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  proc.stdout.on("data", (d) => { out += d; });
  proc.stderr.on("data", (d) => { out += d; });
  const done = new Promise((ok) => proc.on("close", (code) => ok({ code, out })));
  return { proc, done, exited: () => proc.exitCode !== null };
}
const until = async (check, ms = 10_000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 10)); } };
async function overlap(t, { stage, first, second, env, lock }) {
  const hold = join(mkdtempSync(join(tmpdir(), "atelier-hold-")), "hold");
  t.after(() => rmSync(dirname(hold), { recursive: true, force: true }));
  const off = lock ? {} : { ATELIER_TEST_NO_LOCK: "1" };
  const a = child(first, { ...env, ...off, ATELIER_TEST_HOLD: hold, ATELIER_TEST_HOLD_STAGE: stage });
  await until(() => existsSync(`${hold}.read`));
  const b = child(second, { ...env, ...off });
  if (lock) {
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(b.exited(), false, "the second writer waits for the lock");
  } else await b.done;
  writeFileSync(`${hold}.go`, "");
  const [ra, rb] = await Promise.all([a.done, b.done]);
  assert.equal(ra.code, 0, ra.out);
  assert.equal(rb.code, 0, rb.out);
}
const moduleUrl = JSON.stringify(resolve("cli/private.mjs"));

for (const lock of [true, false]) {
  test(`savePrivateFields for two projects at once ${lock ? "keeps both" : "loses one without the lock"}`, async (t) => {
    const f = setup(t);
    f.write({ a: { path: f.root, branch: "main" }, b: { path: f.root, branch: "main" } });
    const save = (project) => `const { savePrivateFields } = await import(${moduleUrl}); savePrivateFields(${JSON.stringify(project)}, { private: [${JSON.stringify(project + ".md")}] });`;
    await overlap(t, { stage: "update", first: save("a"), second: save("b"), env: { ATELIER_CONFIG_DIR: join(f.root, "config") }, lock });
    const p = f.read().projects;
    assert.deepEqual(p.a.private, ["a.md"]);
    if (lock) assert.deepEqual(p.b.private, ["b.md"]); else assert.equal(p.b.private, undefined, "b's name was lost");
  });

  test(`a whole-config save beside another command's private save ${lock ? "keeps both" : "loses one without the lock"}`, async (t) => {
    const f = setup(t);
    f.write({ a: { path: f.root, branch: "main" }, b: { path: f.root, branch: "main" } });
    const env = { ATELIER_CONFIG_DIR: join(f.root, "config") };
    // The first is a command that read the config at its start and changed a's branch.
    const whole = `const { readFileSync } = await import("node:fs");
      const { saveWholeConfig } = await import(${moduleUrl});
      const file = process.env.ATELIER_CONFIG_DIR + "/config.json";
      const snapshot = JSON.parse(readFileSync(file, "utf8")), memory = structuredClone(snapshot);
      memory.projects.a.branch = "next";
      saveWholeConfig(memory, snapshot);`;
    const other = `const { savePrivateFields } = await import(${moduleUrl}); savePrivateFields("b", { private: ["b.md"] });`;
    await overlap(t, { stage: "save", first: whole, second: other, env, lock });
    const p = f.read().projects;
    assert.equal(p.a.branch, "next");
    if (lock) assert.deepEqual(p.b.private, ["b.md"]); else assert.equal(p.b.private, undefined, "b's name was lost");
  });

  test(`two private add commands at once ${lock ? "keep both names in the list" : "lose one without the lock"}`, async (t) => {
    const f = setup(t);
    writeFileSync(join(f.keep, "one.md"), "1\n");
    writeFileSync(join(f.keep, "two.md"), "2\n");
    const env = { ...f.env, HOME: f.home, ATELIER_PRIVATE_ROOT: f.icloud, ATELIER_CONFIG_DIR: join(f.root, "config"), ATELIER_CACHE: join(f.root, "cache"), ATELIER_SERVER: "http://127.0.0.1:9", ATELIER_TOKEN: "t", ATELIER_ACTOR: "owner" };
    const add = (name) => `const { spawnSync } = await import("node:child_process");
      const r = spawnSync(process.execPath, [${JSON.stringify(resolve("cli/atelier.mjs"))}, "private", "add", ${JSON.stringify(name)}, "--project", "demo"], { encoding: "utf8", env: process.env });
      process.stdout.write(r.stdout + r.stderr); process.exit(r.status ?? 1);`;
    await overlap(t, { stage: "list", first: add("one.md"), second: add("two.md"), env, lock });
    const listed = parsePrivateList(readFileSync(join(f.keep, ".atelier-private"), "utf8")).paths;
    if (lock) assert.deepEqual(listed, ["one.md", "two.md"]); else assert.deepEqual(listed, ["one.md"], "two.md was lost from the list");
  });
}

test("a whole-config save keeps what another command wrote since, and every private name", () => {
  const snapshot = { server: "s", projects: { a: { path: "/a", branch: "main" }, b: { path: "/b", branch: "main", private: ["x.md"] }, gone: { path: "/g" } } };
  const memory = structuredClone(snapshot);
  memory.projects.a.branch = "next";
  delete memory.projects.gone;
  memory.projects.b.private = ["x.md"];
  const disk = structuredClone(snapshot);
  disk.projects.b.private = ["x.md", "y.md"];
  disk.projects.b.privateFromList = ["z.md"];
  disk.projects.c = { path: "/c" };
  disk.owner = "o";
  const merged = mergeConfigForSave(disk, memory, snapshot);
  assert.equal(merged.projects.a.branch, "next", "this process's change is written");
  assert.equal(merged.projects.gone, undefined, "this process's removal is written");
  assert.deepEqual(merged.projects.b.private, ["x.md", "y.md"], "another's private name is kept");
  assert.deepEqual(merged.projects.b.privateFromList, ["z.md"]);
  assert.deepEqual(merged.projects.c, { path: "/c" }, "another's new entry is kept");
  assert.equal(merged.owner, "o");
  // An entry this process changed keeps every private name the disk has too.
  memory.projects.b.branch = "other";
  assert.deepEqual(mergeConfigForSave(disk, memory, snapshot).projects.b.private, ["x.md", "y.md"]);
});

// Astra's eleventh review of t645, finding 1: a process that loaded the
// config before another renamed old to new, then changed old and saved,
// made old again; the guard then preferred it and missed names added since.
test("a stale save changes the renamed entry and never makes the old name again; the guard for the old name sees the new entry's names", (t) => {
  const f = setup(t);
  f.write({ old: { path: f.checkout, branch: "main", private: ["a.md"] } });
  const dir = join(f.root, "config"), previous = process.env.ATELIER_CONFIG_DIR;
  process.env.ATELIER_CONFIG_DIR = dir;
  t.after(() => { if (previous === undefined) delete process.env.ATELIER_CONFIG_DIR; else process.env.ATELIER_CONFIG_DIR = previous; });
  // The first process loads the config.
  const snapshot = f.read(), memory = structuredClone(snapshot);
  // Another adds a name and renames old to new.
  savePrivateFields("old", { private: ["b.md"] });
  moveProjectEntryOnDisk({}, "old", "new");
  // The first changes old and saves.
  memory.projects.old.notesRemote = "origin";
  saveWholeConfig(memory, snapshot);
  const projects = f.read().projects;
  assert.deepEqual(Object.keys(projects), ["new"], "old is not made again");
  assert.equal(projects.new.notesRemote, "origin", "the change went to the renamed entry");
  assert.deepEqual(projects.new.private.sort(), ["a.md", "b.md"]);
  assert.ok(privateGuardFor("old").paths.includes("b.md"), "a workspace named old is guarded with the name added since");
  // And where a stale entry under the old name exists beside the renamed one, the renamed one wins, with both entries' names.
  f.write({ old: { path: f.checkout, private: ["stale.md"] }, new: { path: f.checkout, private: ["fresh.md"], formerNames: ["old"] } });
  assert.deepEqual(privateGuardFor("old").paths.sort(), [".atelier-private", "fresh.md", "stale.md"]);
});

// Astra's eleventh review of t645, finding 2: a rename lost the folder that
// discovery found by the old name.
test("a rename keeps the folder found by the old name, and discovery tries former names", (t) => {
  const f = setup(t, { folder: "Old" });
  writeFileSync(join(f.keep, ".atelier-private"), "PROJECT.md\n");
  const previous = process.env.ATELIER_PRIVATE_ROOT;
  process.env.ATELIER_PRIVATE_ROOT = f.icloud;
  t.after(() => { if (previous === undefined) delete process.env.ATELIER_PRIVATE_ROOT; else process.env.ATELIER_PRIVATE_ROOT = previous; });
  const projects = { old: { path: f.checkout, privateFromList: ["PROJECT.md"] } };
  assert.equal(moveProjectEntry(projects, "old", "new").moved, true);
  assert.equal(projects.new.privateHome, f.keep, "the folder found by the old name is recorded");
  // An entry renamed without it still finds the folder by its former name.
  const entry = { path: f.checkout, privateFromList: ["PROJECT.md"], formerNames: ["old"] };
  assert.equal(privateHome("new", entry, f.icloud).home, f.keep);
  assert.deepEqual(privateGuard("new", entry, { root: f.icloud }).refusal, null);
});

// Astra's twelfth review of t645: a stale lock was removed without checking
// it was still the one judged stale, a live owner lost its lock after thirty
// seconds, and release removed whatever lock was there. Each interleaving
// is forced with testHold.
const holdPaths = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return (name) => join(dir, name);
};
const saver = (project, name) => `const { savePrivateFields } = await import(${moduleUrl}); savePrivateFields(${JSON.stringify(project)}, { private: [${JSON.stringify(name)}] });`;

test("two waiters recovering the same dead lock never both enter", async (t) => {
  const f = setup(t);
  f.write({ a: { path: f.root, branch: "main" } });
  const config = join(f.root, "config"), lock = join(config, "config.json.lock"), at = holdPaths(t);
  writeFileSync(lock, "999999999 dead-owner\n");
  const env = { ATELIER_CONFIG_DIR: config };
  // The first judges the lock stale, and stops before taking it.
  const first = child(saver("a", "first.md"), { ...env, ATELIER_TEST_HOLD: at("first"), ATELIER_TEST_HOLD_STAGE: "recover" });
  await until(() => existsSync(`${at("first")}.read`));
  // The second recovers it, takes the lock and stops inside.
  const second = child(saver("a", "second.md"), { ...env, ATELIER_TEST_HOLD: at("second"), ATELIER_TEST_HOLD_STAGE: "update" });
  await until(() => existsSync(`${at("second")}.read`));
  // The first goes on: the lock it finds is the second's, live, so it waits.
  writeFileSync(`${at("first")}.go`, "");
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(first.exited(), false, "the first does not enter while the second holds the lock");
  assert.match(readFileSync(lock, "utf8"), new RegExp(`^${second.proc.pid} `), "the second's lock is in place");
  writeFileSync(`${at("second")}.go`, "");
  const [r1, r2] = await Promise.all([first.done, second.done]);
  assert.equal(r1.code, 0, r1.out);
  assert.equal(r2.code, 0, r2.out);
  assert.deepEqual(f.read().projects.a.private.sort(), ["first.md", "second.md"]);
  assert.ok(!existsSync(lock));
});

test("a live owner keeps its lock however old it is", async (t) => {
  const f = setup(t);
  f.write({ a: { path: f.root, branch: "main" } });
  const config = join(f.root, "config"), lock = join(config, "config.json.lock");
  // This test process is the live owner; its lock is an hour old.
  writeFileSync(lock, `${process.pid} live-owner\n`);
  utimesSync(lock, new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));
  const r = await child(saver("a", "x.md"), { ATELIER_CONFIG_DIR: config, ATELIER_TEST_LOCK_WAIT_MS: "300" }).done;
  assert.notEqual(r.code, 0);
  assert.match(r.out, /is locked by another Atelier command/);
  assert.equal(readFileSync(lock, "utf8"), `${process.pid} live-owner\n`, "its lock is untouched");
  assert.equal(f.read().projects.a.private, undefined);
});

test("releasing a lock never removes a successor's", async (t) => {
  const f = setup(t);
  f.write({ a: { path: f.root, branch: "main" } });
  const config = join(f.root, "config"), lock = join(config, "config.json.lock"), at = holdPaths(t);
  const owner = child(saver("a", "x.md"), { ATELIER_CONFIG_DIR: config, ATELIER_TEST_HOLD: at("owner"), ATELIER_TEST_HOLD_STAGE: "update" });
  await until(() => existsSync(`${at("owner")}.read`));
  // Another lock now stands at the path (as after a takeover).
  writeFileSync(lock, `${process.pid} successor\n`);
  writeFileSync(`${at("owner")}.go`, "");
  const r = await owner.done;
  assert.equal(r.code, 0, r.out);
  assert.equal(readFileSync(lock, "utf8"), `${process.pid} successor\n`, "the successor's lock stays");
  rmSync(lock);
});

// Astra's twelfth review of t645, finding 2: a merge compared the source's
// folder only with a folder the destination named, not one found by its
// name, and then gave the destination the source's.
test("a rename into an entry whose folder is found by name compares that folder, and refuses a different one", (t) => {
  const f = setup(t, { folder: "Target" });
  const other = join(f.icloud, "Source");
  mkdirSync(other);
  const previous = process.env.ATELIER_PRIVATE_ROOT;
  process.env.ATELIER_PRIVATE_ROOT = f.icloud;
  t.after(() => { if (previous === undefined) delete process.env.ATELIER_PRIVATE_ROOT; else process.env.ATELIER_PRIVATE_ROOT = previous; });
  const projects = { source: { path: "/s", private: ["a.md"] }, target: { path: "/t", private: ["b.md"] } };
  const before = structuredClone(projects);
  const r = moveProjectEntry(projects, "source", "target");
  assert.match(r.error ?? "", new RegExp(`different folders for their private files \\(${other}.*and ${f.keep}\\)`));
  assert.deepEqual(projects, before, "nothing changed");
  // With no folder for the source, the destination keeps the one found by its name.
  rmSync(other, { recursive: true });
  assert.equal(moveProjectEntry(projects, "source", "target").merged, true);
  assert.equal(projects.target.privateHome, f.keep);
});

// Astra's thirteenth review of t645, finding 2: info/exclude was rewritten
// without a lock, so two commands at once could drop each other's lines.
for (const lock of [true, false]) {
  test(`two commands adding ignore lines at once ${lock ? "keep every line once" : "repeat the header without the lock"}`, async (t) => {
    const f = setup(t);
    const add = (path) => `const { excludePrivate } = await import(${moduleUrl}); excludePrivate(${JSON.stringify(f.checkout)}, [${JSON.stringify(path)}]);`;
    const exclude = join(f.checkout, ".git", "info", "exclude");
    writeFileSync(exclude, "# someone's own\nbuild/\n");
    await overlap(t, { stage: "exclude", first: add("one.md"), second: add("two.md"), env: { ATELIER_CONFIG_DIR: join(f.root, "config") }, lock });
    const lines = readFileSync(exclude, "utf8").split("\n");
    assert.ok(lines.includes("/one.md") && lines.includes("/two.md"), "both lines are there");
    assert.ok(lines.includes("build/"), "the lines already there are kept");
    const headers = lines.filter((l) => l.startsWith("# Private files Atelier links")).length;
    if (lock) assert.equal(headers, 1); else assert.equal(headers, 2, "without the lock both read before either wrote");
  });
}

test("guardedPush hands the push the commit it scanned, whatever the branch names by then", (t) => {
  const f = setup(t);
  const c = f.checkout;
  const scanned = f.git(c, "rev-parse", "HEAD");
  let given = null;
  guardedPush({ project: "nothing-private", cwd: c, tip: "refs/heads/main", what: "The push" }, (sha) => { given = sha; });
  assert.equal(given, scanned);
  assert.throws(() => guardedPush({ project: "nothing-private", cwd: c, tip: "refs/heads/none", what: "The push" }, () => {}), /does not name a commit here/);
});

// Astra's fourteenth review of t645, finding 2: a link the developer made
// was replaced whenever it pointed elsewhere.
test("a link the developer made is left as it is and reported", (t) => {
  const f = setup(t);
  const notes = join(f.root, "my-notes");
  mkdirSync(notes);
  writeFileSync(join(notes, "PROJECT.md"), "mine\n");
  symlinkSync(join(notes, "PROJECT.md"), join(f.checkout, "PROJECT.md"));
  const r = f.run("private", "add", "PROJECT.md");
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /PROJECT\.md: a link Atelier did not make is already in the checkout \(to .*my-notes\/PROJECT\.md\); it was left as it is/);
  assert.equal(readlinkSync(join(f.checkout, "PROJECT.md")), join(notes, "PROJECT.md"));
});

// Astra's fourteenth review of t645, finding 1: a save that changed one
// field of an entry wrote back the rest of it as the process had read it.
test("a whole-config save writes only the fields this process changed", () => {
  const snapshot = { projects: { demo: { path: "/d", privateHome: "/old", notesRemote: "github" } } };
  const memory = structuredClone(snapshot);
  memory.projects.demo.notesRemote = "origin";
  const disk = structuredClone(snapshot);
  disk.projects.demo.privateHome = "/new";
  const merged = mergeConfigForSave(disk, memory, snapshot).projects.demo;
  assert.equal(merged.privateHome, "/new", "another command's change to a field this one did not touch is kept");
  assert.equal(merged.notesRemote, "origin", "this process's change is written");
  // A field this process removed is removed; one it did not touch stays.
  delete memory.projects.demo.notesRemote;
  disk.projects.demo.branch = "next";
  const again = mergeConfigForSave(disk, memory, snapshot).projects.demo;
  assert.equal(again.notesRemote, undefined);
  assert.equal(again.branch, "next");
});

// Astra's fifteenth review of t645, finding 1: a process started while the
// project's folder was A kept reading A after another command named B.
test("a process started on an older folder reads the folder named since, and the old one too", (t) => {
  const f = setup(t);
  const a = join(f.root, "folder-a"), b = join(f.root, "folder-b");
  mkdirSync(a); mkdirSync(b);
  writeFileSync(join(a, ".atelier-private"), "a.md\n");
  writeFileSync(join(b, ".atelier-private"), "b.md\n");
  f.write({ demo: { path: f.checkout, branch: "main", privateHome: a } });
  const memory = JSON.parse(readFileSync(join(f.root, "config", "config.json"), "utf8"));
  useConfig(memory);
  const previous = { dir: process.env.ATELIER_CONFIG_DIR, root: process.env.ATELIER_PRIVATE_ROOT };
  process.env.ATELIER_CONFIG_DIR = join(f.root, "config");
  process.env.ATELIER_PRIVATE_ROOT = f.icloud;
  t.after(() => {
    useConfig(null);
    for (const [key, value] of [["ATELIER_CONFIG_DIR", previous.dir], ["ATELIER_PRIVATE_ROOT", previous.root]]) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  });
  // Another command names folder B.
  const disk = f.read();
  disk.projects.demo.privateHome = b;
  writeFileSync(join(f.root, "config", "config.json"), JSON.stringify(disk));
  const paths = privateGuardFor("demo").paths;
  assert.ok(paths.includes("b.md"), "the folder named since is read");
  assert.ok(paths.includes("a.md"), "the older folder still adds its names");
  assert.equal(memory.projects.demo.privateHome, b, "the folder on disk is the current one");
});

// Astra's fifteenth review of t645, finding 2: a developer's link into the
// project's own folder was taken for Atelier's and replaced.
test("a developer's link into the project's folder is left as it is", (t) => {
  const f = setup(t);
  writeFileSync(join(f.keep, "draft.md"), "draft\n");
  symlinkSync(join(f.keep, "draft.md"), join(f.checkout, "PROJECT.md"));
  const r = f.run("private", "add", "PROJECT.md");
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /PROJECT\.md: a link Atelier did not make is already in the checkout/);
  assert.equal(readlinkSync(join(f.checkout, "PROJECT.md")), join(f.keep, "draft.md"));
});

// Astra's sixteenth review of t645, finding 1: names read from the older
// folder were returned but not kept, so the next call, with the older folder
// no longer known, dropped them.
test("names read from an older folder are kept in the copy, so a second guard call still covers them", (t) => {
  const f = setup(t);
  const a = join(f.root, "folder-a"), b = join(f.root, "folder-b");
  mkdirSync(a); mkdirSync(b);
  writeFileSync(join(a, ".atelier-private"), "a.md\n");
  writeFileSync(join(b, ".atelier-private"), "b.md\n");
  f.write({ demo: { path: f.checkout, branch: "main", privateHome: a } });
  const memory = JSON.parse(readFileSync(join(f.root, "config", "config.json"), "utf8"));
  useConfig(memory);
  const previous = { dir: process.env.ATELIER_CONFIG_DIR, root: process.env.ATELIER_PRIVATE_ROOT };
  process.env.ATELIER_CONFIG_DIR = join(f.root, "config");
  process.env.ATELIER_PRIVATE_ROOT = f.icloud;
  t.after(() => {
    useConfig(null);
    for (const [key, value] of [["ATELIER_CONFIG_DIR", previous.dir], ["ATELIER_PRIVATE_ROOT", previous.root]]) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  });
  const disk = f.read();
  disk.projects.demo.privateHome = b;
  writeFileSync(join(f.root, "config", "config.json"), JSON.stringify(disk));
  assert.ok(privateGuardFor("demo").paths.includes("a.md"), "first call");
  assert.ok(privateGuardFor("demo").paths.includes("a.md"), "second call, with folder A no longer known");
  assert.ok(f.read().projects.demo.privateFromList.includes("a.md"), "kept in the copy on disk");
});

// Astra's sixteenth review of t645, finding 2: private remove deleted any
// link to the expected target, a developer's own included.
test("private remove leaves a link the developer made, and still drops the name", (t) => {
  const f = setup(t);
  writeFileSync(join(f.keep, ".atelier-private"), "PROJECT.md\n");
  f.write({ demo: { path: f.checkout, branch: "main", protect: [], private: ["PROJECT.md"], privateFromList: ["PROJECT.md"] } });
  symlinkSync(join(f.keep, "PROJECT.md"), join(f.checkout, "PROJECT.md"));
  const r = f.run("private", "remove", "PROJECT.md");
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /PROJECT\.md: the link in the checkout \(to .*PROJECT\.md\) is not one Atelier made; it was left as it is\./);
  assert.equal(readlinkSync(join(f.checkout, "PROJECT.md")), join(f.keep, "PROJECT.md"));
  assert.ok(!f.read().projects.demo.private.includes("PROJECT.md"));
  assert.deepEqual(parsePrivateList(readFileSync(join(f.keep, ".atelier-private"), "utf8")).paths, []);
});

// Argon's seventeenth review of t645, finding 1: private remove kept only
// the names it held, so with the list naming another (added on another
// Mac), removing the last local one left the project not opted in here.
test("private remove keeps every name the list still holds in the copy, so the project stays guarded", (t) => {
  const f = setup(t);
  writeFileSync(join(f.keep, ".atelier-private"), "PROJECT.md\nnotes/plan.md\n");
  f.write({ demo: { path: f.checkout, branch: "main", protect: [], private: ["PROJECT.md"], privateFromList: ["PROJECT.md"] } });
  const r = f.run("private", "remove", "PROJECT.md");
  assert.equal(r.code, 0, r.output);
  const entry = f.read().projects.demo;
  assert.deepEqual(entry.privateFromList, ["notes/plan.md"]);
  assert.ok(privateGuard("demo", entry, { root: f.icloud }).paths.includes("notes/plan.md"));
});

// Argon's seventeenth review of t645, finding 2: a list that is there but
// cannot be read was neither said nor guarded.
test("a list that is there but cannot be read opts the project in, refuses pushes, and is said by private add and ls", (t) => {
  const f = setup(t);
  const file = join(f.keep, ".atelier-private");
  writeFileSync(file, "PROJECT.md\n");
  chmodSync(file, 0o000);
  let ls, add, entry, guard, pending = {};
  try {
    ls = f.run("private", "ls");
    add = f.run("private", "add", "--home", f.keep);
    entry = f.read().projects.demo;
    guard = privateGuard("demo", entry, { root: f.icloud });
    discoverPrivate("demo", pending, { root: f.icloud });
  } finally { chmodSync(file, 0o644); }
  assert.match(ls.output, /Warning: .*\.atelier-private cannot be read \(EACCES\)/);
  assert.match(add.output, /\.atelier-private cannot be read \(EACCES\)/);
  assert.equal(entry.privateHome, f.keep, "the project is opted in");
  assert.match(guard.refusal ?? "", /cannot be read.*Nothing was pushed\./);
  assert.equal(pending.privateHome, f.keep, "a first init's pending entry is opted in too");
});

// Astra's eighteenth review of t645: a lock keyed by the path as written
// let two spellings of one folder take two locks.
test("two spellings of one folder share one lock key", (t) => {
  const f = setup(t);
  const alias = join(f.root, "alias");
  symlinkSync(f.keep, alias);
  assert.equal(lockKey(join(alias, ".atelier-private")), lockKey(join(f.keep, ".atelier-private")), "through a symbolic link");
  const upper = f.keep.replace(/demo$/i, "DEMO").replace(/Demo$/, "DEMO");
  if (existsSync(upper) && upper !== f.keep) assert.equal(lockKey(join(upper, ".atelier-private")), lockKey(join(f.keep, ".atelier-private")), "in another letter case");
  assert.notEqual(lockKey(join(f.root, "elsewhere", ".atelier-private")), lockKey(join(f.keep, ".atelier-private")));
});

// Argon's eighteenth review of t645, finding 2: two private add commands at
// once raced to make the same link, and the second failed with EEXIST.
for (const lock of [true, false]) {
  test(`two commands linking the same file at once both succeed ${lock ? "(the second waits)" : "(without the lock, the link the other made is taken as made)"}`, async (t) => {
    const f = setup(t);
    const entry = JSON.stringify({ path: f.checkout, private: ["PROJECT.md"], privateHome: f.keep });
    const link = `const { linkPrivate } = await import(${moduleUrl}); const r = linkPrivate(${JSON.stringify(f.checkout)}, ${entry}, { name: "demo" }); if (r.refused.length) process.exit(3);`;
    await overlap(t, { stage: "link", first: link, second: link, env: { ATELIER_CONFIG_DIR: join(f.root, "config") }, lock });
    assert.equal(readlinkSync(join(f.checkout, "PROJECT.md")), join(f.keep, "PROJECT.md"));
  });
}

// Argon's eighteenth review of t645, finding 3: names read from another
// folder were kept as a copy while the current folder's list could not be
// read, and the next push then passed as though that list had a copy.
test("names from other folders do not stand in for an unreadable current list", (t) => {
  const f = setup(t);
  const old = join(f.root, "old-folder");
  mkdirSync(old);
  writeFileSync(join(old, ".atelier-private"), "a.md\n");
  const file = join(f.keep, ".atelier-private");
  writeFileSync(file, "PROJECT.md\n");
  chmodSync(file, 0o000);
  const entry = { path: f.checkout, private: ["mine.md"], privateHome: f.keep };
  let first, second;
  try {
    first = privateGuard("demo", entry, { root: f.icloud, homes: [old], save: () => {} });
    second = privateGuard("demo", entry, { root: f.icloud, save: () => {} });
  } finally { chmodSync(file, 0o644); }
  assert.ok(first.paths.includes("a.md"), "the other folder's names are guarded");
  assert.match(first.refusal ?? "", /cannot be read/);
  assert.equal(entry.privateFromList, undefined, "they are not kept as a copy of the current list");
  assert.match(second.refusal ?? "", /cannot be read/, "the next push still refuses");
});
