import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
