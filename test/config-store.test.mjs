// How this Mac's config.json is written (cli/config-store.mjs): writers of the
// file must not lose each other's change. Each overlap test makes two writers
// meet for certain: the first stops between its read and its write
// (testHold), the second runs meanwhile; with the lock the second waits,
// without it (ATELIER_TEST_NO_LOCK) the first's stale write loses the
// second's change, which shows the test can see a lost update. Every folder is
// under os.tmpdir().
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mergeConfigForSave, moveProjectEntry, moveProjectEntryOnDisk, projectKey, saveWholeConfig, updateConfig } from "../cli/config-store.mjs";

function setup(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "atelier-config-store-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = join(root, "config");
  mkdirSync(config);
  const write = (projects) => writeFileSync(join(config, "config.json"), JSON.stringify({ server: "http://127.0.0.1:9", owner: "owner", projects }));
  const read = () => JSON.parse(readFileSync(join(config, "config.json"), "utf8"));
  write({ a: { path: root, branch: "main" }, b: { path: root, branch: "main" } });
  const previous = process.env.ATELIER_CONFIG_DIR;
  process.env.ATELIER_CONFIG_DIR = config;
  t.after(() => { if (previous === undefined) delete process.env.ATELIER_CONFIG_DIR; else process.env.ATELIER_CONFIG_DIR = previous; });
  return { root, config, lock: join(config, "config.json.lock"), write, read };
}

const moduleUrl = JSON.stringify(resolve("cli/config-store.mjs"));
// A process that sets one field of one project's entry, under the lock.
const setter = (project, field, value) => `const { updateConfig } = await import(${moduleUrl}); updateConfig((cfg) => { cfg.projects[${JSON.stringify(project)}][${JSON.stringify(field)}] = ${JSON.stringify(value)}; });`;

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

test("a lock left by a process that is gone is taken over", (t) => {
  const f = setup(t);
  writeFileSync(f.lock, `999999999 ${Date.now()}\n`);
  assert.equal(updateConfig((cfg) => { cfg.projects.a.note = "x"; return true; }), true);
  assert.equal(f.read().projects.a.note, "x");
  assert.ok(!existsSync(f.lock));
});

test("a config that is not there is not made by updateConfig", (t) => {
  const f = setup(t);
  rmSync(join(f.config, "config.json"));
  assert.equal(updateConfig(() => true), false);
  assert.ok(!existsSync(join(f.config, "config.json")));
});

for (const lock of [true, false]) {
  test(`updateConfig for two projects at once ${lock ? "keeps both" : "loses one without the lock"}`, async (t) => {
    const f = setup(t);
    await overlap(t, { stage: "update", first: setter("a", "note", "a.md"), second: setter("b", "note", "b.md"), env: { ATELIER_CONFIG_DIR: f.config }, lock });
    const p = f.read().projects;
    assert.equal(p.a.note, "a.md");
    if (lock) assert.equal(p.b.note, "b.md"); else assert.equal(p.b.note, undefined, "b's change was lost");
  });

  test(`a whole-config save beside another command's update ${lock ? "keeps both" : "loses one without the lock"}`, async (t) => {
    const f = setup(t);
    // The first is a command that read the config at its start and changed a's branch.
    const whole = `const { readFileSync } = await import("node:fs");
      const { saveWholeConfig } = await import(${moduleUrl});
      const file = process.env.ATELIER_CONFIG_DIR + "/config.json";
      const snapshot = JSON.parse(readFileSync(file, "utf8")), memory = structuredClone(snapshot);
      memory.projects.a.branch = "next";
      saveWholeConfig(memory, snapshot);`;
    await overlap(t, { stage: "save", first: whole, second: setter("b", "note", "b.md"), env: { ATELIER_CONFIG_DIR: f.config }, lock });
    const p = f.read().projects;
    assert.equal(p.a.branch, "next");
    if (lock) assert.equal(p.b.note, "b.md"); else assert.equal(p.b.note, undefined, "b's change was lost");
  });
}

test("a whole-config save keeps what another command wrote since", () => {
  const snapshot = { server: "s", projects: { a: { path: "/a", branch: "main" }, b: { path: "/b", branch: "main" }, gone: { path: "/g" } } };
  const memory = structuredClone(snapshot);
  memory.projects.a.branch = "next";
  delete memory.projects.gone;
  const disk = structuredClone(snapshot);
  disk.projects.b.notesRemote = "origin";
  disk.projects.c = { path: "/c" };
  disk.owner = "o";
  const merged = mergeConfigForSave(disk, memory, snapshot);
  assert.equal(merged.projects.a.branch, "next", "this process's change is written");
  assert.equal(merged.projects.gone, undefined, "this process's removal is written");
  assert.equal(merged.projects.b.notesRemote, "origin", "another's change to an entry this process left alone is kept");
  assert.deepEqual(merged.projects.c, { path: "/c" }, "another's new entry is kept");
  assert.equal(merged.owner, "o");
});

test("a whole-config save writes only the fields this process changed", () => {
  const snapshot = { projects: { demo: { path: "/d", notesRemote: "github", branch: "main" } } };
  const memory = structuredClone(snapshot);
  memory.projects.demo.notesRemote = "origin";
  const disk = structuredClone(snapshot);
  disk.projects.demo.branch = "next";
  const merged = mergeConfigForSave(disk, memory, snapshot).projects.demo;
  assert.equal(merged.branch, "next", "another command's change to a field this one did not touch is kept");
  assert.equal(merged.notesRemote, "origin", "this process's change is written");
  // A field this process removed is removed; one it did not touch stays.
  delete memory.projects.demo.notesRemote;
  const again = mergeConfigForSave(disk, memory, snapshot).projects.demo;
  assert.equal(again.notesRemote, undefined);
  assert.equal(again.branch, "next");
});

test("former names are joined across memory and disk, so no save drops one", () => {
  const snapshot = { projects: { demo: { path: "/d", formerNames: ["one"] } } };
  const memory = structuredClone(snapshot);
  memory.projects.demo.formerNames = ["one", "two"];
  const disk = structuredClone(snapshot);
  disk.projects.demo.formerNames = ["one", "three"];
  assert.deepEqual(mergeConfigForSave(disk, memory, snapshot).projects.demo.formerNames.sort(), ["one", "three", "two"]);
});

// A process that loaded the config before another renamed old to new, then
// changed old and saved, made old again.
test("a stale save changes the renamed entry and never makes the old name again", (t) => {
  const f = setup(t);
  f.write({ old: { path: f.root, branch: "main" } });
  const snapshot = f.read(), memory = structuredClone(snapshot);
  // Another renames old to new.
  moveProjectEntryOnDisk({}, "old", "new");
  // The first changes old and saves.
  memory.projects.old.notesRemote = "origin";
  saveWholeConfig(memory, snapshot);
  const projects = f.read().projects;
  assert.deepEqual(Object.keys(projects), ["new"], "old is not made again");
  assert.equal(projects.new.notesRemote, "origin", "the change went to the renamed entry");
  assert.deepEqual(projects.new.formerNames, ["old"]);
});

test("projectKey finds an entry by its name or a former name, and the renamed entry wins over a stale one", () => {
  assert.equal(projectKey({ demo: {} }, "demo"), "demo");
  assert.equal(projectKey({ demo: {} }, "other"), null);
  assert.equal(projectKey({ new: { formerNames: ["old"] } }, "old"), "new");
  assert.equal(projectKey({ old: {}, new: { formerNames: ["old"] } }, "old"), "new");
});

test("moveProjectEntry renames an entry and keeps the old name as a former name", () => {
  const projects = { old: { path: "/d", formerNames: ["older"] } };
  assert.deepEqual(moveProjectEntry(projects, "old", "new"), { moved: true });
  assert.deepEqual(projects, { new: { path: "/d", formerNames: ["older", "old"] } });
  assert.deepEqual(moveProjectEntry(projects, "missing", "x"), { moved: false });
  assert.deepEqual(moveProjectEntry(projects, "new", "new"), { moved: false });
});

test("moveProjectEntry into an entry already under the new name keeps that entry and says what the source held", () => {
  const projects = { old: { path: "/old", branch: "dev" }, new: { path: "/new", formerNames: ["x"] } };
  assert.deepEqual(moveProjectEntry(projects, "old", "new"), { moved: true, merged: true, dropped: { path: "/old", branch: "dev" } });
  assert.deepEqual(projects, { new: { path: "/new", formerNames: ["x", "old"] } });
});

test("moveProjectEntryOnDisk moves the entry in the file and in memory, or in memory alone when there is no file", (t) => {
  const f = setup(t);
  const memory = { a: { path: f.root } };
  assert.equal(moveProjectEntryOnDisk(memory, "a", "z").moved, true);
  assert.deepEqual(Object.keys(f.read().projects), ["b", "z"]);
  assert.deepEqual(Object.keys(memory), ["z"], "memory follows the file");
  rmSync(join(f.config, "config.json"));
  const alone = { a: { path: f.root } };
  assert.equal(moveProjectEntryOnDisk(alone, "a", "z").moved, true);
  assert.deepEqual(Object.keys(alone), ["z"]);
  assert.ok(!existsSync(join(f.config, "config.json")), "no file is made");
});

// A stale lock was once removed without checking it was still the one judged
// stale, a live owner lost its lock after thirty seconds, and release removed
// whatever lock was there. Each interleaving is forced with testHold.
const holdPaths = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return (name) => join(dir, name);
};

test("two waiters recovering the same dead lock never both enter", async (t) => {
  const f = setup(t);
  const at = holdPaths(t);
  writeFileSync(f.lock, "999999999 dead-owner\n");
  const env = { ATELIER_CONFIG_DIR: f.config };
  // The first judges the lock stale, and stops before taking it.
  const first = child(setter("a", "note", "first"), { ...env, ATELIER_TEST_HOLD: at("first"), ATELIER_TEST_HOLD_STAGE: "recover" });
  await until(() => existsSync(`${at("first")}.read`));
  // The second recovers it, takes the lock and stops inside.
  const second = child(setter("b", "note", "second"), { ...env, ATELIER_TEST_HOLD: at("second"), ATELIER_TEST_HOLD_STAGE: "update" });
  await until(() => existsSync(`${at("second")}.read`));
  // The first goes on: the lock it finds is the second's, live, so it waits.
  writeFileSync(`${at("first")}.go`, "");
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(first.exited(), false, "the first does not enter while the second holds the lock");
  assert.match(readFileSync(f.lock, "utf8"), new RegExp(`^${second.proc.pid} `), "the second's lock is in place");
  writeFileSync(`${at("second")}.go`, "");
  const [r1, r2] = await Promise.all([first.done, second.done]);
  assert.equal(r1.code, 0, r1.out);
  assert.equal(r2.code, 0, r2.out);
  assert.equal(f.read().projects.a.note, "first");
  assert.equal(f.read().projects.b.note, "second");
  assert.ok(!existsSync(f.lock));
});

test("a live owner keeps its lock however old it is", async (t) => {
  const f = setup(t);
  // This test process is the live owner; its lock is an hour old.
  writeFileSync(f.lock, `${process.pid} live-owner\n`);
  utimesSync(f.lock, new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));
  const r = await child(setter("a", "note", "x"), { ATELIER_CONFIG_DIR: f.config, ATELIER_TEST_LOCK_WAIT_MS: "300" }).done;
  assert.notEqual(r.code, 0);
  assert.match(r.out, /is locked by another Atelier command/);
  assert.equal(readFileSync(f.lock, "utf8"), `${process.pid} live-owner\n`, "its lock is untouched");
  assert.equal(f.read().projects.a.note, undefined);
});

test("releasing a lock never removes a successor's", async (t) => {
  const f = setup(t);
  const at = holdPaths(t);
  const owner = child(setter("a", "note", "x"), { ATELIER_CONFIG_DIR: f.config, ATELIER_TEST_HOLD: at("owner"), ATELIER_TEST_HOLD_STAGE: "update" });
  await until(() => existsSync(`${at("owner")}.read`));
  // Another lock now stands at the path (as after a takeover).
  writeFileSync(f.lock, `${process.pid} successor\n`);
  writeFileSync(`${at("owner")}.go`, "");
  const r = await owner.done;
  assert.equal(r.code, 0, r.out);
  assert.equal(readFileSync(f.lock, "utf8"), `${process.pid} successor\n`, "the successor's lock stays");
  rmSync(f.lock);
});
