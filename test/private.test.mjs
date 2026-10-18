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
import { parsePrivateList, privatePath } from "../src/rules.ts";
// What a list in iCloud holds: one path a line.
const privateListText = (paths) => `${[...new Set(paths)].sort().map((p) => `${p}\n`).join("")}`;
import { privateConfig } from "./fixtures/private-config.mjs";
import { discoverPrivate, mergeConfigForSave, moveProjectEntry, moveProjectEntryOnDisk, saveWholeConfig, savePrivateFields, guardedPush, privateGuardFor, readPrivateList, useConfig, privateGuard, remoteBases, privateChanges, privateCommits, privateHome, privateRefusal } from "../cli/private-guard.mjs";
// No test reads this Mac's own iCloud folder (t645).
process.env.ATELIER_PRIVATE_ROOT ||= `${process.env.TMPDIR || "/tmp"}/atelier-tests-no-icloud-${process.pid}`;

const cli = resolve("cli/atelier.mjs");

// What the project's private files looked like when a command linked them: a
// link in the checkout to each file in the folder that keeps them, ignored
// through .git/info/exclude.
function linkByHand(f, names) {
  for (const name of names) {
    mkdirSync(dirname(join(f.checkout, name)), { recursive: true });
    symlinkSync(join(f.keep, name), join(f.checkout, name));
  }
  writeFileSync(join(f.checkout, ".git", "info", "exclude"), names.map((n) => `/${n}\n`).join(""));
}

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

test("a folder named for the project is found case-, space- and hyphen-insensitively, and two are refused", (t) => {
  const f = setup(t, { folder: "de mo" });
  assert.equal(privateHome("De-Mo", {}, f.icloud).home, join(f.icloud, "de mo"));
  mkdirSync(join(f.icloud, "DEMO"));
  assert.match(privateHome("demo", {}, f.icloud).error, /more than one folder .* \(DEMO, de mo\)/);
  assert.equal(privateHome("demo", { privateHome: "/x" }, f.icloud).home, "/x");
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
  linkByHand(f, ["PROJECT.md", "notes"]);
  assert.deepEqual(privateChanges(f.checkout, ["PROJECT.md", "notes"]), []);
  f.git(f.checkout, "add", "-f", "PROJECT.md");
  assert.deepEqual(privateChanges(f.checkout, ["PROJECT.md", "notes"]), ["PROJECT.md"]);
  writeFileSync(join(f.checkout, ".git", "info", "exclude"), "");
  assert.deepEqual(privateChanges(f.checkout, ["PROJECT.md", "notes"]).sort(), ["PROJECT.md", "notes"]);
});

test("the list in iCloud is read as data: config-only names still work, and a bad line is refused alone", (t) => {
  const f = setup(t);
  writeFileSync(join(f.keep, ".atelier-private"), ["# private", "PROJECT.md", "../../etc/passwd", "/abs.md", ".git/config", "file.txt", ".atelier-private", "", "notes"].join("\n"));
  f.write({ demo: { path: f.checkout, branch: "main", protect: [], private: ["mine.md"] } });
  assert.deepEqual(readPrivateList(f.keep).refused.map((x) => x.line), [3, 4, 5, 7]);
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
  f.write({ demo: { ...f.read().projects.demo, private: ["secret.md"] } });
  // A task commit holding it, pushed from this process.
  rmSync(join(f.checkout, "secret.md"), { force: true });
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
  f.write({ ...f.read().projects, demo: { ...f.read().projects.demo, private: ["secret.md"] } });
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
const moduleUrl = JSON.stringify(resolve("cli/private-guard.mjs"));

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


test("guardedPush hands the push the commit it scanned, whatever the branch names by then", (t) => {
  const f = setup(t);
  const c = f.checkout;
  const scanned = f.git(c, "rev-parse", "HEAD");
  let given = null;
  guardedPush({ project: "nothing-private", cwd: c, tip: "refs/heads/main", what: "The push" }, (sha) => { given = sha; });
  assert.equal(given, scanned);
  assert.throws(() => guardedPush({ project: "nothing-private", cwd: c, tip: "refs/heads/none", what: "The push" }, () => {}), /does not name a commit here/);
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

// Argon's seventeenth review of t645, finding 2: a list that is there but
// cannot be read was neither said nor guarded.
test("a list that is there but cannot be read opts the project in and refuses pushes", (t) => {
  const f = setup(t);
  const file = join(f.keep, ".atelier-private");
  writeFileSync(file, "PROJECT.md\n");
  chmodSync(file, 0o000);
  let entry = { path: f.checkout, branch: "main" }, guard, pending = {};
  try {
    discoverPrivate("demo", entry, { root: f.icloud });
    guard = privateGuard("demo", entry, { root: f.icloud });
    discoverPrivate("demo", pending, { root: f.icloud });
  } finally { chmodSync(file, 0o644); }
  assert.equal(entry.privateHome, f.keep, "the project is opted in");
  assert.match(guard.refusal ?? "", /cannot be read.*Nothing was pushed\./);
  assert.equal(pending.privateHome, f.keep, "a first init's pending entry is opted in too");
});

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
