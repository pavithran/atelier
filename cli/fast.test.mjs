import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { shellQuote } from "./fast.mjs";

test("shellQuote quotes a path for a POSIX shell (t646)", () => {
  for (const path of ["/tmp/plain", "/tmp/project-$batch", "/tmp/`x`", "/tmp/it's", "/tmp/a b\\c\"d", ""]) {
    assert.equal(spawnSync("sh", ["-c", `printf %s ${shellQuote(path)}`], { encoding: "utf8" }).stdout, path);
  }
});

// t767: fast land and fast record were removed. Finding they would have
// caught: a spec form left behind lists a command that no longer runs, in
// atelier help and in the usage the command prints for an unknown word.
test("atelier fast declares take, ready, status and close, and no longer land or record (t767)", async () => {
  const { default: spec } = await import("../src/usage/commands/fast.ts");
  const { COMMAND_USAGE } = await import("./help.mjs");
  assert.deepEqual(Object.keys(spec.subcommands).sort(), ["close", "ready", "status", "take"]);
  assert.deepEqual(spec.forms.map((f) => f.form.split(" ").slice(0, 2).join(" ")).sort(), ["fast close", "fast ready", "fast status", "fast take"]);
  assert.doesNotMatch(COMMAND_USAGE.fast, /fast land\b|fast record|--reviewer|--regen/);
  assert.deepEqual(Object.keys(spec.help.flags).sort(), ["--commit SHA", "--dispatch AT", "--json", "--runner home:NAME"]);
});
