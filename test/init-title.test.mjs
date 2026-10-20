import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const cli = resolve("cli/atelier.mjs");

test("a bare --title is refused, not treated as an empty title", () => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-init-"));
  try {
    const r = spawnSync(process.execPath, [cli, "init", "--title"], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /give the title as --title TEXT, or --title "" to clear it/);
    // The refusal happens before anything is sent: the test runs without a
    // server, so a request would fail with a network error, and nothing is
    // printed on stdout.
    assert.doesNotMatch(r.stderr, /fetch failed|ECONNREFUSED|ENOTFOUND/);
    assert.equal(r.stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a bare --review-bar is refused, not treated as clearing the bar", () => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-init-"));
  try {
    const r = spawnSync(process.execPath, [cli, "init", "--review-bar"], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--review-bar needs text: atelier init --review-bar "what may block a review", or --review-bar "" to restore the default/);
    assert.equal(r.stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const { initName } = await import("../cli/atelier.mjs");

test("init reuses the registered name when the checkout folder differs", () => {
  const projects = { weblog: { path: "/work/ikon weblog" }, photograph: { path: "/work/Photograph" } };
  assert.deepEqual(initName(projects, "/work/ikon weblog", undefined, false), { name: "weblog", existing: "weblog" });
  assert.equal(initName(projects, "/work/Photograph", undefined, false).name, "photograph");
  assert.equal(initName(projects, "/work/new", undefined, false).name, "new");
  assert.equal(initName(projects, "/work/ikon weblog", "weblog", false).name, "weblog");
  assert.throws(() => initName(projects, "/work/ikon weblog", "other", false), /registered as weblog/);
  assert.deepEqual(initName(projects, "/work/ikon weblog", "other", true), { name: "other", existing: "weblog" });
  assert.throws(() => initName(projects, "/work/ikon weblog", "photograph", true), /already registered locally/);
  assert.throws(() => initName(projects, "/work/new", "other", true), /registered checkout/);
  assert.throws(() => initName(projects, "/work/ikon weblog", undefined, true), /--name NAME/);
  assert.throws(() => initName(projects, "/work/ikon weblog", true, false), /needs a project name/);
});

// t136's finding: initName called real(p.path) for every local config entry,
// so one entry without a path (a project with no checkout on this Mac)
// stopped every command with "The paths[0] argument must be of type string.
// Received undefined", and an entry with an empty path matched the current
// folder, since resolve("") is the cwd.
test("initName skips entries whose path is missing, empty or not a string", () => {
  const projects = { none: {}, empty: { path: "" }, number: { path: 7 }, weblog: { path: "/work/ikon weblog" } };
  assert.deepEqual(initName(projects, "/work/ikon weblog", undefined, false), { name: "weblog", existing: "weblog" });
});

test("initName matches no entry when every path is unusable, and falls back to the folder name", () => {
  assert.deepEqual(initName({ none: {}, empty: { path: "" }, number: { path: 7 } }, "/work/new", undefined, false), { name: "new", existing: undefined });
});

test("an entry with an empty path never matches the current folder, though resolve of it is the cwd", () => {
  const cwd = process.cwd();
  const { name, existing } = initName({ ghost: { path: "" } }, cwd, undefined, false);
  assert.equal(existing, undefined);
  assert.equal(name, cwd.split("/").pop());
});

test("initName still matches a checkout registered under a symlinked path", () => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-init-link-"));
  try {
    const real = join(dir, "real");
    mkdirSync(real);
    symlinkSync(real, join(dir, "link"));
    assert.deepEqual(initName({ weblog: { path: join(dir, "link") } }, real, undefined, false), { name: "weblog", existing: "weblog" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
