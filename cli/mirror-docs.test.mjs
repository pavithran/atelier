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
