import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// The showcase command, run with an isolated config and no server: help,
// flag parsing and argument checks are answered before any request.

const cli = resolve("cli/atelier.mjs");

function run(args) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-showcase-"));
  try {
    return spawnSync(process.execPath, [cli, ...args], {
      cwd: dir, encoding: "utf8",
      env: { ...process.env, ATELIER_CONFIG_DIR: dir },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the help lists the showcase command and its forms", () => {
  const r = run(["help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /showcase set NAME \[--named\|--anonymous\] · showcase remove NAME/);
  assert.match(r.stdout, /one owner per task/);
});

test("showcase --help prints its usage without contacting a server", () => {
  for (const args of [["showcase", "--help"], ["showcase", "set", "-h"]]) {
    const r = run(args);
    assert.equal(r.status, 0, args.join(" "));
    assert.match(r.stdout, /usage: atelier showcase set NAME \[--named\|--anonymous\] · showcase remove NAME/);
    assert.doesNotMatch(r.stderr, /no server|fetch failed|ECONNREFUSED|ENOTFOUND/);
  }
});

test("showcase refuses a set without a name, an unknown flag and both modes at once", () => {
  const bare = run(["showcase", "set"]);
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /usage: atelier showcase set NAME/);
  assert.doesNotMatch(bare.stderr, /no server/);
  const flag = run(["showcase", "set", "x", "--bogus"]);
  assert.equal(flag.status, 1);
  assert.match(flag.stderr, /showcase does not take --bogus/);
  assert.doesNotMatch(flag.stderr, /no server/);
  const both = run(["showcase", "set", "x", "--named", "--anonymous"]);
  assert.equal(both.status, 1);
  assert.match(both.stderr, /give either --named or --anonymous, not both/);
  assert.doesNotMatch(both.stderr, /no server/);
  const remove = run(["showcase", "remove"]);
  assert.equal(remove.status, 1);
  assert.match(remove.stderr, /atelier showcase set NAME \[--named\|--anonymous\] · showcase remove NAME/);
});
