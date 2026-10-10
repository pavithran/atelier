import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The owner's standing for a model (paused, reserved, roles) holds at every
// place that creates a dispatch or a review request, not only at the ones a
// test happens to drive: each goes through Ledger.standingDispatch, which
// refuses a model held from the job. This scans the source, so a new call
// site that builds its dispatch some other way fails here before review.

const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []);
const ledger = readFileSync("src/ledger.ts", "utf8").split("\n");

// The Ledger's methods, each from its declaration at class indent to the next.
const METHOD = /^ {2}(?:(?:private|public|async|static|get)\s+)*([A-Za-z_]\w*)\s*\(/;
const methods = [];
ledger.forEach((line, i) => {
  const m = METHOD.exec(line);
  if (m && !["if", "for", "while", "switch"].includes(m[1])) methods.push({ name: m[1], start: i });
});
methods.forEach((m, i) => { m.body = ledger.slice(m.start, methods[i + 1]?.start ?? ledger.length).join("\n"); });
const methodAt = (line) => methods.findLast((m) => m.start <= line);

// The lines of the ledger matching a pattern, with the method each is in.
const sites = (pattern) => ledger.flatMap((line, i) => (pattern.test(line) ? [{ line: i + 1, method: methodAt(i) }] : []));

test("makeDispatch is called only by standingDispatch", () => {
  const calls = files("src").flatMap((f) => readFileSync(f, "utf8").split("\n").flatMap((line, i) =>
    /\bmakeDispatch\(/.test(line) && !/export function makeDispatch\(/.test(line) && !/typeof makeDispatch/.test(line) ? [`${f}:${i + 1}`] : []));
  const allowed = sites(/\bmakeDispatch\(/).filter((s) => s.method.name === "standingDispatch").map((s) => `src/ledger.ts:${s.line}`);
  assert.equal(allowed.length, 1, "standingDispatch calls makeDispatch once");
  assert.deepEqual(calls, allowed);
});

test("standingDispatch and planDispatch check the owner's standing", () => {
  const standing = methods.find((m) => m.name === "standingDispatch");
  assert.match(standing.body, /this\.assertStanding\(/);
  const plan = methods.find((m) => m.name === "planDispatch");
  assert.match(plan.body, /this\.standingDispatch\([^]*"plan"/);
});

// Helpers that write a dispatch their caller made; each of their calls is a
// site in its own right, checked in the caller.
const PASS_THROUGH = ["writeDispatch", "askPlanner"];

test("every review request and every dispatch written is built by the standing check", () => {
  const writers = [
    ...sites(/INSERT INTO review_requests/),
    ...sites(/UPDATE items SET dispatch = \?/),
    ...sites(/this\.planDispatch\(/),
    ...PASS_THROUGH.flatMap((name) => sites(new RegExp(`this\\.${name}\\(`))),
  ];
  // The review requests, the owner's dispatch, the plan job and its retries,
  // the parts and the integrator's jobs: none may be missed by the scan.
  assert.ok(writers.filter((s) => /INSERT INTO review_requests/.test(ledger[s.line - 1])).length >= 5);
  assert.ok(writers.length >= 17, `found ${writers.length} sites`);
  const unchecked = writers
    .filter((s) => !PASS_THROUGH.includes(s.method.name))
    .filter((s) => !/this\.(standingDispatch|planDispatch)\(/.test(s.method.body))
    .map((s) => `src/ledger.ts:${s.line} in ${s.method.name}`);
  assert.deepEqual(unchecked, []);
  // A pass-through helper writes only what it is given, never a dispatch of
  // its own making.
  for (const name of PASS_THROUGH) assert.doesNotMatch(methods.find((m) => m.name === name).body, /makeDispatch\(|to: "(home|cloud|any)"/, name);
});
