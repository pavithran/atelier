// t326: a task blocked by a validation_blocked build is listed by atelier
// status under what waits on the developer, with the run's reason and the
// unblock that lets it go on. The Ledger's inbox entry for it is tested in
// test/validation-blocked-task.spec.ts; here the same entry, from the same
// rule, goes through the status formatter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatStatus } from "../cli/status.mjs";
import { inboxFor, REASON_MAX, VALIDATION_BLOCKED, validationBlockReason } from "../src/rules.ts";

const A = "claude-code/opus-5.5";
const T = "2026-10-26T12:00:00.000Z";
const NOTE = `${VALIDATION_BLOCKED}npm test could not run: listen EPERM 127.0.0.1`;
// The task as Ledger.release leaves it after the holder's marked release.
const item = {
  id: "t5", title: "Wire the keys", scope: ["src/**"], state: "blocked", owner: A, runner: "home:studio",
  fork: "demo--t5", base: "0".repeat(40), head: "a".repeat(40), acceptedHead: null,
  createdAt: T, updatedAt: T, lastPushAt: T, dispatch: { at: T, to: "home" },
  blocked: { reason: validationBlockReason(NOTE), by: A, at: T, from: "claimed" },
};

test("atelier status lists a validation_blocked task under what waits on the developer, with the run's reason", () => {
  const inbox = inboxFor("demo", [item], { checks: ["npm test"] }, [], [], new Date(T));
  const out = formatStatus([{ name: "demo", title: "Demo", items: [item], inbox }], { now: new Date(T) }).split("\n");
  const waiting = out.indexOf("  Waiting for you");
  assert.notEqual(waiting, -1, out.join("\n"));
  const row = out.findIndex((l) => l.startsWith("    t5  Unblock  Wire the keys"));
  assert.ok(row > waiting, out.join("\n"));
  assert.ok(out.includes(`      why: blocked by ${A}: ${NOTE}`), out.join("\n"));
  assert.ok(out.includes("      next: atelier unblock t5 --project demo"), out.join("\n"));
});

test("a validation_blocked block's reason is the note as one line, cut at the block's limit with its start kept", () => {
  assert.equal(validationBlockReason(`${NOTE}\nthe rest`), `${NOTE} the rest`);
  const long = validationBlockReason(`${NOTE} ${"x".repeat(2000)}`);
  assert.equal(long.length, REASON_MAX);
  assert.ok(long.startsWith(NOTE));
  assert.ok(long.endsWith("…"));
});
