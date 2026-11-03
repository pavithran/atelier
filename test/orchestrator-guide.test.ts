import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { COMMANDS, commandFor, rolePrompt } from "../src/usage.ts";

// All command examples stay in backticks, on one line, so this checks the
// handbook people read against the declarations the CLI parser reads.
function checkCommands(text: string) {
  const examples = [...text.matchAll(/`atelier ([^`]+)`/g)];
  assert.ok(examples.length > 0);
  for (const [, example] of examples) {
    const words = example!.split(/\s+/);
    const name = commandFor(words[0]!);
    assert.ok(name, `unknown command: ${example}`);
    const spec = COMMANDS[name]!;
    const sub = spec.subcommands?.[words[1]!];
    const flags = { ...spec.flags, ...sub?.flags, project: false, as: false, help: true };
    for (const flag of example!.matchAll(/--([a-z][a-z-]*)/g)) {
      assert.ok(Object.hasOwn(flags, flag[1]!), `unknown flag --${flag[1]}: ${example}`);
      if (sub?.takes) assert.ok(["project", "as", "help", ...sub.takes].includes(flag[1]!), `refused subcommand flag: ${example}`);
    }
    if (spec.subcommands) assert.ok(sub, `unknown subcommand: ${example}`);
  }
}

test("the orchestrator handbook is short and its commands and flags exist", () => {
  const guide = rolePrompt("orchestrate");
  assert.ok(guide.split("\n").length <= 200);
  checkCommands(guide);
  assert.match(guide, /criteria review only for large or risky tasks/i);
  assert.match(guide, /atelier-pulse/);
  assert.match(guide, /full suite\s+passing/i);
  const reference = readFileSync(new URL("../docs/orchestrating.md", import.meta.url), "utf8");
  assert.match(reference, /This is the reference/);
  assert.match(reference, /flow.*updates the guide in the same landing/);
});

test("the handbook check rejects removed commands, flags and subcommands", () => {
  assert.throws(() => checkCommands("`atelier vanished`"), /unknown command/);
  assert.throws(() => checkCommands("`atelier ship --vanished`"), /unknown flag/);
  assert.throws(() => checkCommands("`atelier plan vanished`"), /unknown subcommand/);
});
