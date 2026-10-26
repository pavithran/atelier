import { test } from "node:test";
import assert from "node:assert/strict";
import { fastRefusal } from "../cli/commands/mode.mjs";

// Astra's audit of 2026-10-13, finding 3: atelier mode fast is refused
// without the developer's permission from the Settings page. The refusal
// keeps the server's words, which name the page and the factor, and adds the
// command to run again; any other refusal is passed on as it is.
test("atelier mode fast's refusal says what to run on the developer's yes, and names no page", () => {
  const server = 'fast_mode_unconfirmed: fast mode needs the developer\'s confirmation, as an override of the independent review does: ask the developer, and on their yes run: atelier mode fast --reason TEXT --quote "the developer\'s words" --as H/M --project demo; the developer token alone does not confirm it';
  const said = fastRefusal(server, "demo", "forks fail");
  assert.ok(said.startsWith(server));
  assert.match(said, /\nOn the developer's yes, run: atelier mode fast --reason "forks fail" --quote "the developer's words" --as H\/M --project demo$/);
  assert.doesNotMatch(said, /Settings|Allow fast mode/);
  const forbidden = "fast_mode_forbidden: this project forbids overrides of the independent review (atelier init --no-override), and fast mode lands without that review, so fast mode is refused";
  assert.equal(fastRefusal(forbidden, "demo", "x"), forbidden);
});
