import assert from "node:assert/strict";
import { test } from "node:test";
import { errorLine, tailEvents, tailFailure } from "./commands/server-errors.mjs";

// Recorded in the shape `wrangler tail --format json` prints: a banner line,
// then each event pretty-printed over many lines, with request headers, a
// query string and a body that must never reach the output.
const HEADER_VALUE = ["Bearer sk", "secret", "token", "123"].join("-");
const tail = `Successfully created tail, expires at 2026-10-25T20:00:00Z
${JSON.stringify({
  outcome: "exception",
  eventTimestamp: Date.parse("2026-10-25T18:30:00Z"),
  event: { request: { url: "https://atelier.example.dev/api/p/x/review-request?token=abc123&x=1", method: "POST", headers: { authorization: HEADER_VALUE, cookie: "session=zzz" }, body: "secret-body" } },
  logs: [{ level: "log", message: ["fine"] }, { level: "error", message: ["review request failed {", "} at https://h.dev/x?key=k9 with Bearer abc"] }],
  exceptions: [{ name: "TypeError", message: "cannot read x\nof undefined", timestamp: 1 }],
}, null, 2)}
${JSON.stringify({ outcome: "ok", eventTimestamp: 1, event: { request: { url: "https://atelier.example.dev/ok", method: "GET", headers: { authorization: HEADER_VALUE } } }, logs: [{ level: "info", message: ["all good"] }], exceptions: [] }, null, 2)}
${JSON.stringify({ eventTimestamp: Date.parse("2026-10-25T18:31:00Z"), event: { request: { url: "https://atelier.example.dev/api/queue", method: "GET", headers: { "x-token": HEADER_VALUE } } }, logs: [{ level: "error", message: [{ message: "queue timed out" }] }], exceptions: [] }, null, 2)}
`;

test("multi-line tail output gives one line per event that logged an error or threw", () => {
  const events = tailEvents(tail);
  assert.equal(events.length, 3);
  const lines = events.map(errorLine).filter(Boolean);
  assert.deepEqual(lines, [
    "2026-10-25T18:30:00.000Z POST /api/p/x/review-request TypeError: cannot read x of undefined | review request failed { } at https://h.dev/x with Bearer [removed]",
    "2026-10-25T18:31:00.000Z GET /api/queue queue timed out",
  ]);
});

test("no header, query string or body appears in the lines", () => {
  const out = tailEvents(tail).map(errorLine).filter(Boolean).join("\n");
  for (const bad of ["sk-secret", "authorization", "cookie", "session=zzz", "token=abc123", "?", "secret-body", "k9", "abc123"]) assert.ok(!out.includes(bad), `${bad} in ${out}`);
});

test("braces inside strings and text around events do not break the reading", () => {
  const e = { logs: [{ level: "error", message: ['bad "}" {'] }], event: { request: { url: "https://a.dev/p", method: "GET" } }, eventTimestamp: 0 };
  const events = tailEvents(`noise\n${JSON.stringify(e, null, 1)}\ntrailing`);
  assert.equal(events.length, 1);
  assert.match(errorLine(events[0]), /^1970-01-01T00:00:00.000Z GET \/p bad "}" \{$/);
});

test("an error object holding headers, a body and a relative URL query prints only its message", () => {
  const e = {
    eventTimestamp: 0,
    event: { request: { url: "/x?token=secret#frag", method: "GET" } },
    logs: [{ level: "error", message: [{ message: "failed at /x?token=secret", headers: { cookie: "sid=c00kie" }, body: "the-body" }, { headers: { cookie: "sid=c00kie" }, body: "the-body" }] }],
  };
  const out = errorLine(e);
  assert.equal(out, "1970-01-01T00:00:00.000Z GET /x failed at /x [object]");
  for (const bad of ["secret", "c00kie", "the-body", "cookie", "headers", "frag"]) assert.ok(!out.includes(bad), `${bad} in ${out}`);
});

test("any nonzero wrangler close code is a failed tail", () => {
  assert.match(tailFailure(1, false), /exit 1/);
  assert.match(tailFailure(-1, false), /could not run/);
  assert.match(tailFailure(1, true), /exit 1/);
  assert.equal(tailFailure(0, false), null);
  assert.equal(tailFailure(null, true), null);
});
