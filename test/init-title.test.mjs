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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});