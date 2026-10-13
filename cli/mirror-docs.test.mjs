// The owner docs describe publication as the code does (t433): the policy is
// the registered commit identity, set with init flags, not a checkout file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const owner = readFileSync(new URL("../docs/owner.md", import.meta.url), "utf8");
const setup = readFileSync(new URL("../docs/setup.md", import.meta.url), "utf8");
const init = readFileSync(new URL("./commands/init.mjs", import.meta.url), "utf8");

test("owner.md documents the registered policy, not .atelier/publication.json", () => {
  assert.doesNotMatch(owner, /publication\.json/);
  for (const flag of ["--public-mirror REMOTE", "--public-mirror-destination REMOTE=URL", "--private-path GLOB", "--private-pattern REGEX"]) assert.ok(owner.includes(flag), flag);
  assert.match(owner, /`wrap --push` trusts no remote by its URL/);
});

test("setup.md lists every publication flag init takes, and the migration to destinations", () => {
  for (const flag of ["public-mirror", "public-mirror-destination", "private-path", "private-pattern"]) {
    assert.ok(init.includes(`"${flag}"`), `init takes --${flag}`);
    assert.ok(setup.includes(`- \`--${flag}`), `setup.md lists --${flag}`);
  }
  for (const field of ["publicMirrorDestinations", "privatePaths", "privatePatterns"]) assert.ok(setup.includes(`\`${field}\``), field);
  assert.match(setup, /atelier init --public-mirror-destination REMOTE=URL/);
  assert.match(setup, /`wrap --push` gives every\s+checkout remote this check/);
});

test("init's help and setup.md say what a declared mirror changes and that a named capability, not a route level, carries the fields", async () => {
  const { default: spec } = await import("../src/usage/commands/init.ts");
  const help = spec.help.flags["--public-mirror REMOTE"];
  assert.match(spec.forms[0].about, /checks every other checkout remote/);
  assert.doesNotMatch(help, /pushed as before/);
  assert.match(help, /every other checkout remote the same check/);
  // Since t522 the route level is frozen and new capabilities take none, so
  // a server reporting only level 28 would drop the fields; init refuses it.
  const declarations = readFileSync(new URL("../src/capability-declarations.ts", import.meta.url), "utf8");
  const line = declarations.split("\n").find((l) => l.includes('"projects.publication-policy.v1"'));
  assert.ok(line, "capability-declarations.ts declares the t433 fields");
  assert.doesNotMatch(line, /level:/);
  assert.ok(spec.capabilities.includes("projects.publication-policy.v1"));
  assert.doesNotMatch(setup, /raise the route level to 24/);
  assert.doesNotMatch(setup, /`privatePatterns` with\s+route level/);
  assert.match(setup, /`privatePatterns` with the named capability\s+`projects\.publication-policy\.v1`/);
});
