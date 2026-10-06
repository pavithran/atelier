import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const cli = resolve("cli/atelier.mjs");

// Run in an isolated config dir with no server configured: if the CLI tried to
// contact the server it would die with "no server" before any request.
function run(args) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-help-"));
  try {
    return spawnSync(process.execPath, [cli, ...args], {
      cwd: dir, encoding: "utf8",
      env: { ...process.env, ATELIER_CONFIG_DIR: dir },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("models --help prints the usage and exits 0 without contacting the server", () => {
  const r = run(["models", "--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /usage: atelier models/);
  assert.doesNotMatch(r.stderr, /no server|fetch failed|ECONNREFUSED|ENOTFOUND/);
});

test("-h anywhere prints the usage and exits 0", () => {
  const r = run(["models", "add", "m1", "-h"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /usage: atelier models/);
});

test("models frobnicate prints the usage and exits 1 without contacting the server", () => {
  const r = run(["models", "frobnicate"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage: atelier models/);
  assert.match(r.stderr, /unknown models command "frobnicate"/);
  assert.equal(r.stdout, "");
  assert.doesNotMatch(r.stderr, /no server|fetch failed|ECONNREFUSED|ENOTFOUND/);
});

test("projects frobnicate prints its usage and exits 1 without contacting the server", () => {
  const r = run(["projects", "frobnicate"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage: atelier projects remove NAME/);
  assert.doesNotMatch(r.stderr, /no server|fetch failed|ECONNREFUSED|ENOTFOUND/);
});
test("session commands are listed and the guide teaches both boundaries", () => {
  assert.match(run(["help"]).stdout, /Sessions\s+unwrap.*wrap/);
  const guide = run(["guide"]);
  assert.equal(guide.status, 0);
  assert.match(guide.stdout, /1\. Start a session with `atelier unwrap/);
  assert.match(guide.stdout, /2\. End with `atelier wrap/);
  assert.match(run(["wrap", "--help"]).stdout, /usage: atelier wrap/);
  assert.match(run(["unwrap", "--help"]).stdout, /usage: atelier unwrap/);
});

test("guide keeps the rule that the project checkout is never edited directly", () => {
  const text = run(["guide"]).stdout;
  assert.match(text, /Never edit the project checkout directly\./);
  assert.match(text, /For each session the project owner runs in the registered checkout:/, "the session steps say whose checkout work they are for");
});

test("guide teaches filing, relay blocks and private saved copies", () => {
  const text = run(["guide"]).stdout;
  for (const pattern of [/--project atelier/, /Lesson: /, /--found TEXT/, /fenced block/, /bash for a command/, /text for prose/, /~\/Documents\/ai-project-data\/<project>\//, /metadata only/]) assert.match(text, pattern);
});
