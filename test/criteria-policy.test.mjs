import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { helpText, COMMAND_USAGE } from "../cli/help.mjs";
import init from "../src/usage/commands/init.ts";

test("criteria review timing is registered in init and pinned in help and usage", () => {
  assert.equal(typeof init.flags["criteria-review"], "string");
  assert.match(COMMAND_USAGE.init, /--criteria-review parallel\|before/);
  assert.match(COMMAND_USAGE.init, /before \(the default\)/);
  assert.equal(readFileSync(new URL("./fixtures/cli/help.txt", import.meta.url), "utf8"), helpText() + "\n");
  const pinned = JSON.parse(readFileSync(new URL("./fixtures/cli/usage.json", import.meta.url), "utf8"));
  for (const [command, usage] of Object.entries(COMMAND_USAGE)) assert.equal(pinned[command], usage + "\n", command);
});


test("the requirement help explains both timing policies", () => {
  const text = init.help.flags["--require-criteria-review"];
  assert.match(text, /before.*dispatch and claim/);
  assert.match(text, /parallel.*gate review and landing/);
});


test("the introductory requirement help explains both timing policies", () => {
  const text = init.forms[0].about.split("`--require-criteria-review`")[1].split("`--no-override`")[0];
  assert.match(text, /before.*dispatch and claim/);
  assert.match(text, /parallel.*gate review and landing/);
});
