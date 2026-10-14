// Private files (t645): a project names files that stay on the developer's
// Macs, kept in its iCloud folder and linked into the checkout; Git ignores
// them and Atelier never commits or pushes them. Every folder is under
// os.tmpdir(), HOME included, so the iCloud folder here is a stand-in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parsePrivateList, privateListText, privatePath } from "../src/rules.ts";
import { privateConfig } from "./fixtures/private-config.mjs";
import { discoverPrivate, guardedPush, linkPrivate, privateGuard, remoteBases, privateChanges, privateCommits, privateHome, privateRefusal } from "../cli/private.mjs";
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

// Both reviews of t645: pushes were guarded call by call and some were
// missed. Every git push in the CLI is made inside guardedPush, except the
// ones listed here with why.
test("every git push the CLI makes runs inside guardedPush", () => {
  const exempt = {
    "cli/push-steps.mjs": "its helpers run only inside guardedPush: init's pushHistory and push's 413 fallback, which pushes the HEAD the guarded push checked",
    "cli/commands/merge.mjs#notes": "refs/notes/atelier alone, which holds receipts, no project file",
  };
  const files = execFileSync("git", ["ls-files", "cli"], { encoding: "utf8" }).split("\n").filter((f) => f.endsWith(".mjs") && !/\.(test|spec)\.mjs$/.test(f));
  const unguarded = [];
  for (const file of files) {
    if (exempt[file]) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!/["']push["']\s*,\s*["']--/.test(line)) return;
      if (/refs\/notes\/atelier:refs\/notes\/atelier['"]\]/.test(line) && !/refs\/heads/.test(line) && exempt[`${file}#notes`]) return;
      // The push's own lines and those just around it: guardedPush wraps
      // the push, or the argument list is built just before it.
      const around = lines.slice(Math.max(0, i - 20), i + 21).join("\n");
      if (!around.includes("guardedPush(")) unguarded.push(`${file}:${i + 1}`);
    });
  }
  assert.deepEqual(unguarded, []);
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
  // Only a list that is there and read replaces it.
  writeFileSync(join(f.keep, ".atelier-private"), "notes\n");
  privateGuard("demo", entry, { root: f.icloud, save: () => saved++ });
  assert.deepEqual(entry.privateFromList, ["notes"]);
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
