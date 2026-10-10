import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { COMMON, FLAGS } from "../cli/atelier.mjs";
import { COMMAND_HELP, COMMAND_USAGE, HELP_FORMS, commandUsage } from "../cli/help.mjs";

// The flag table in cli/atelier.mjs is what the parser accepts; the help in
// cli/help.mjs is what the CLI says it accepts. These tests hold the two
// together: every flag the parser takes is in the command's help, the help
// names no flag the parser refuses, and every command answers --help with
// usage of its own.

const cli = resolve("cli/atelier.mjs");

// Flags the parser accepts only so the command can refuse them with its own
// message (models add says where keys go; done takes its summary as a word).
// The help must not offer them.
const REFUSED = { models: ["key", "api-key", "token"], done: ["summary"] };
// Commands whose --help is not usage of their own: help prints the table,
// and ops hands --help to the atelier-ops toolkit with everything after it.
const OWN = Object.keys(FLAGS).filter((cmd) => cmd !== "help" && cmd !== "ops");

const common = new Set(Object.keys(COMMON));
const accepted = (cmd) => new Set(Object.keys(FLAGS[cmd]).filter((flag) => !(REFUSED[cmd] ?? []).includes(flag)));
const flagsIn = (text) => new Set([...text.matchAll(/--([a-z][a-z-]*)/g)].map((m) => m[1]));
const formsOf = (cmd) => HELP_FORMS.filter((form) => form.split(" ")[0] === cmd);

test("every flag the parser accepts is in the command's help forms, and the forms name none it refuses", () => {
  for (const cmd of Object.keys(FLAGS)) {
    const forms = formsOf(cmd);
    if (cmd !== "help") assert.ok(forms.length, `atelier ${cmd} has no form in the help`);
    const named = flagsIn(forms.join(" "));
    for (const flag of accepted(cmd)) assert.ok(named.has(flag), `atelier ${cmd} takes --${flag}, which its help form does not name`);
    for (const flag of named) assert.ok(accepted(cmd).has(flag) || common.has(flag), `the help form for atelier ${cmd} names --${flag}, which the parser refuses`);
    for (const flag of REFUSED[cmd] ?? []) assert.ok(!named.has(flag), `the help form for atelier ${cmd} offers --${flag}, which the command refuses`);
  }
});

test("each command's flag list describes every flag it takes and no other, and its example runs it", () => {
  for (const cmd of OWN) {
    const help = COMMAND_HELP[cmd];
    assert.ok(help, `atelier ${cmd} has no per-command help`);
    const described = new Map(Object.keys(help.flags ?? {}).map((key) => [/^--([a-z][a-z-]*)/.exec(key)?.[1], key]));
    for (const flag of accepted(cmd)) assert.ok(described.has(flag), `atelier ${cmd} --help does not describe --${flag}`);
    for (const [flag, key] of described) assert.ok(accepted(cmd).has(flag) || common.has(flag), `atelier ${cmd} --help describes ${key}, which the parser refuses`);
    for (const [key, what] of Object.entries(help.flags ?? {})) {
      assert.match(key, /^--[a-z][a-z-]*( \S+)?$/, `${cmd}: ${key} is not a flag with its value`);
      assert.ok(what.length > 8, `${cmd}: ${key} needs a description`);
      assert.doesNotMatch(what, /\s[–—-]\s|[–—]/, `${cmd}: ${key}: use a colon, semicolon or full stop`);
    }
    assert.ok(help.example.startsWith(`atelier ${cmd}`), `${cmd}: the example runs another command: ${help.example}`);
  }
  assert.deepEqual(Object.keys(COMMAND_USAGE).sort(), OWN.slice().sort());
  assert.throws(() => commandUsage("ops"), /no help for atelier ops/);
});

test("every command answers --help with its usage, what it does, its flags and an example, contacting no server", () => {
  // No config.json: a command that reached for the server would die with "no server".
  const dir = mkdtempSync(join(tmpdir(), "atelier-command-help-"));
  try {
    for (const cmd of OWN) {
      const r = spawnSync(process.execPath, [cli, cmd, "--help"], { cwd: dir, encoding: "utf8", env: { ...process.env, ATELIER_CONFIG_DIR: dir } });
      assert.equal(r.status, 0, `${cmd} --help: ${r.stderr}`);
      assert.equal(r.stderr, "", `${cmd} --help wrote to stderr`);
      assert.equal(r.stdout, `${commandUsage(cmd)}\n`, `${cmd} --help`);
      const lines = r.stdout.split("\n");
      assert.ok(lines[0].startsWith(`usage: atelier ${cmd}`), `${cmd}: ${lines[0]}`);
      for (const form of formsOf(cmd)) assert.ok(lines.includes(`usage: atelier ${form}`) || lines.includes(`       atelier ${form}`), `${cmd}: no usage line for ${form}`);
      if (accepted(cmd).size) assert.ok(lines.includes("Flags:"), `${cmd}: no flag list`);
      assert.ok(lines.includes("Every command also takes --project NAME and --as harness/model (or ATELIER_ACTOR); --help prints this."), `${cmd}: no line on the common flags`);
      assert.ok(lines.at(-2).startsWith(`Example: atelier ${cmd}`), `${cmd}: the help does not end with an example`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("merge-main help distinguishes claim-time main from --head dispatch context", () => {
  const usage = commandUsage("dispatch");
  assert.match(usage, /fetches and merges the baseline's current main head at claim time/);
  assert.match(usage, /--head.*full hash recorded as dispatch context/);
  assert.match(usage, /defaults to main's head as the baseline holds it at dispatch/);
  assert.match(usage, /does not pin the merge target/);
  assert.doesNotMatch(usage, /main at the named head|full hash of main's head to merge/);
});
