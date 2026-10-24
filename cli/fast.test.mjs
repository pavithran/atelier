import { test } from "node:test";
import assert from "node:assert/strict";

// The fork-less build was removed: finding a spec form left behind would
// list a command that no longer runs, in atelier help and in the usage the
// command prints for an unknown word.
test("atelier fast declares status and close only", async () => {
  const { default: spec } = await import("../src/usage/commands/fast.ts");
  const { COMMAND_USAGE } = await import("./help.mjs");
  assert.deepEqual(Object.keys(spec.subcommands).sort(), ["close", "status"]);
  assert.deepEqual(spec.forms.map((f) => f.form.split(" ").slice(0, 2).join(" ")).sort(), ["fast close", "fast status"]);
  assert.doesNotMatch(COMMAND_USAGE.fast, /fast take|fast ready|fast land\b|fast record|--reviewer|--regen/);
  assert.deepEqual(Object.keys(spec.help.flags), ["--json"]);
});
