import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  attemptHeader, attemptNumbers, boundedTail, checkAttemptsAt, checkLogPointer, collectFailureLines, effectiveFailures, FAILURE_LINES_CHARS, FAILURE_LINES_MAX, failingTests, failingTestsLine, failureDetail, failureJson, failureSummary,
  headsWithChecks, LOCAL_OUTPUT_TAIL, readCheckLog, resolveFailures, SANDBOX_OUTPUT_TAIL, SUMMARY_TAIL_CHARS, SUMMARY_TAIL_LINES, SUMMARY_TEST_NAMES,
} from "../src/check-failure.ts";
import { LARGE_MAX, type LargeRef } from "../src/large.ts";
import { gate, type Evidence, type Item, type ProjectPolicy } from "../src/rules.ts";

// The failure summary (t436, src/check-failure.ts): the failed checks as the
// gate reads them at a head, each log read by reference or inline and
// labelled as what it is, the failing tests read from fixed reporter
// formats and from nothing else, and one text every caller prints.

const fixture = (name: string) => readFileSync(resolve("test/fixtures/check-logs", name), "utf8");
const H1 = "a".repeat(40), H2 = "b".repeat(40), M1 = "1".repeat(40), M2 = "2".repeat(40);
const policy: ProjectPolicy = { checks: ["npm test", "npm run typecheck"], protected: [] };
let n = 0;
const at = (i: number) => new Date(Date.UTC(2026, 9, 10, 12, 0, i)).toISOString();
const ev = (over: Partial<Evidence> = {}): Evidence => {
  n++;
  return { itemId: "t1", claim: "npm test", grade: "observed", head: H1, passed: false, by: "codex/test", at: at(n), changedPaths: ["src/a.ts"], where: "runner", outputTail: "", id: n, ...over };
};
const item = (over: Partial<Item> = {}): Item => ({
  id: "t1", title: "Fix the thing", scope: ["src/**"], state: "submitted", owner: "codex/test", fork: "p--t1", base: "0".repeat(40), head: H1, acceptedHead: null,
  createdAt: at(0), updatedAt: at(0), lastPushAt: at(0), ...over,
});
const ref = (over: Partial<LargeRef> = {}): LargeRef => ({ key: "logs/p/t1/" + "c".repeat(64), bytes: 12_000, sha256: "c".repeat(64), ...over });
const none = async () => null;

// ── the reporter formats, fixed by fixtures ────────────────────────────────

const FORMATS: [string, string[], string[]][] = [
  ["node-spec.txt", ["node:test"], ["fails: the cap is enforced", "fails inside: names are read"]],
  // Cut before its summary, the spec output lists every ✖ line, the failed suite among them.
  ["node-spec-cut.txt", ["node:test"], ["fails: the cap is enforced", "fails inside: names are read", "a suite"]],
  ["tap.txt", ["tap"], ["fails: the cap is enforced", "fails inside: names are read", "a suite"]],
  ["vitest.txt", ["vitest"], ["test/sample.spec.ts > fails: the cap is enforced", "test/sample.spec.ts > a suite > fails inside: names are read"]],
  ["vitest-tree-only.txt", ["vitest"], ["fails: the cap is enforced", "a suite > fails inside: names are read"]],
  ["jest.txt", ["jest"], ["cap › fails: the cap is enforced", "a suite › fails inside: names are read"]],
  ["pytest.txt", ["pytest"], ["tests/test_cap.py::test_cap_is_enforced", "tests/test_cap.py::test_names[are-read]", "tests/test_cap.py::test_fixture"]],
  ["go.txt", ["go test"], ["TestCapIsEnforced", "TestSuite", "TestSuite/names_are_read"]],
  ["cargo.txt", ["cargo test"], ["tests::cap_is_enforced", "suite::names_are_read"]],
  ["xctest.txt", ["xctest"], ["CapTests.CapTests.testCapIsEnforced", "CapTests.SuiteTests.testNamesAreRead()", "the cap is enforced", "namesAreRead()"]],
];

for (const [file, reporters, names] of FORMATS) test(`failing tests are read from ${file}`, () => {
  const read = failingTests(fixture(file));
  assert.ok(read, `${file} is recognised`);
  assert.deepEqual(read.reporters, reporters);
  assert.deepEqual(read.names, names);
  assert.equal(read.note, null);
  const line = failingTestsLine(read);
  assert.ok(line.startsWith(`failing tests (${reporters.join(", ")}): `), line);
  for (const name of names) assert.ok(line.includes(name), `${line} names ${name}`);
});

test("a TAP skip or todo directive is not a failure, and names are each listed once", () => {
  const read = failingTests(fixture("tap.txt"))!;
  assert.ok(!read.names.some((name) => /skipped one|later/.test(name)));
  assert.equal(new Set(read.names).size, read.names.length);
});

test("output of no reporter this summary reads says the names are unavailable, and invents none", () => {
  assert.equal(failingTests(fixture("plain.txt")), null);
  assert.equal(failingTests(""), null);
  assert.equal(failingTestsLine(null), "failing tests: names unavailable (no test reporter format this summary reads was recognised in the output)");
  assert.ok(!failingTestsLine(null).includes("ok 42"));
});

test("a typecheck, and a reporter naming no failing test, say none is named rather than reading a name from the failure", () => {
  const tsc = failingTests(fixture("tsc.txt"))!;
  assert.deepEqual(tsc, { reporters: ["tsc"], names: [], note: "the output holds 2 TypeScript errors, which name no test" });
  assert.equal(failingTestsLine(tsc), "failing tests: none named (the output holds 2 TypeScript errors, which name no test)");
  const tap = failingTests(fixture("tap-no-failure.txt"))!;
  assert.deepEqual(tap.reporters, ["tap"]);
  assert.deepEqual(tap.names, []);
  assert.equal(failingTestsLine(tap), "failing tests: none named (the tap output names no failing test, so the check failed for another reason)");
});

test("one output can hold two reporters, as this project's npm test does, and colour codes hide no name", () => {
  const both = failingTests(`${fixture("node-spec.txt")}\n${fixture("vitest.txt")}`)!;
  assert.deepEqual(both.reporters, ["node:test", "vitest"]);
  assert.deepEqual(both.names, ["fails: the cap is enforced", "fails inside: names are read", "test/sample.spec.ts > fails: the cap is enforced", "test/sample.spec.ts > a suite > fails inside: names are read"]);
  const coloured = failingTests("\x1b[31m✖ \x1b[1mred test\x1b[0m (1.2ms)\x1b[0m\nℹ fail 1\n")!;
  assert.deepEqual(coloured.names, ["red test"]);
});

test("the summary lists at most SUMMARY_TEST_NAMES names and counts the rest, or fewer when asked", () => {
  const output = Array.from({ length: SUMMARY_TEST_NAMES + 3 }, (_, i) => `not ok ${i + 1} - test ${i + 1}`).join("\n");
  const line = failingTestsLine(failingTests(output));
  assert.ok(line.endsWith(`test ${SUMMARY_TEST_NAMES}; and 3 more`), line);
  assert.equal(failingTestsLine(failingTests(output), true, 2), `failing tests (tap): test 1; test 2; and ${SUMMARY_TEST_NAMES + 1} more`);
  assert.equal(failingTestsLine(failingTests(output), true, 0), `failing tests (tap): test 1; and ${SUMMARY_TEST_NAMES + 2} more`);
});

// The vitest summary lines alone, as the end of an output whose FAIL lines
// and file tree were cut with the rest: recognised as vitest, naming no test.
const VITEST_SUMMARY_ONLY = "\n Test Files  1 failed (1)\n      Tests  2 failed | 1 passed (3)\n   Start at  12:00:00\n   Duration  1.20s\n";

test("a log kept as a tail says the names may have been cut with the rest, instead of concluding the check failed for another reason", async () => {
  // Whole output: no FAIL line means no test is named, and the check failed for another reason.
  const whole = failingTests(VITEST_SUMMARY_ONLY)!;
  assert.deepEqual([whole.reporters, whole.names, whole.note], [["vitest"], [], null]);
  assert.equal(failingTestsLine(whole), "failing tests: none named (the vitest output names no failing test, so the check failed for another reason)");
  // The same lines at the end of a tail: the FAIL lines may be in the part cut.
  assert.equal(failingTestsLine(whole, false), "failing tests: none named in the tail of the output that was kept (the vitest output in it names no failing test; the lines naming them may have been cut with the rest, or the check failed for another reason)");
  assert.equal(failingTestsLine(null, false), "failing tests: names unavailable (no test reporter format this summary reads was recognised in the tail of the output that was kept; the lines naming them may have been cut with the rest)");
  // Names found in a tail are listed, with the caveat that others may be cut.
  const some = failingTests(`${VITEST_SUMMARY_ONLY} FAIL  test/sample.spec.ts > a suite > names are read\n`)!;
  assert.equal(failingTestsLine(some, false), "failing tests (vitest, read from a tail of the output, so names cut with the rest are not listed): test/sample.spec.ts > a suite > names are read");
  // A typecheck names no test whether or not its output was cut.
  assert.equal(failingTestsLine(failingTests(fixture("tsc.txt")), false), "failing tests: none named (the output holds 2 TypeScript errors, which name no test)");
  // As the summary reads it: an inline tail of a check run on a machine is a tail, a short inline output is whole.
  const filler = `${"x".repeat(LOCAL_OUTPUT_TAIL)}\n`;
  const [cut, wholeRun] = await resolveFailures(effectiveFailures(policy, [
    ev({ passed: false, outputTail: `${filler}${VITEST_SUMMARY_ONLY}` }),
    ev({ claim: "npm run typecheck", passed: false, outputTail: VITEST_SUMMARY_ONLY }),
  ], H1), none);
  assert.equal(cut.logRead.whole, false);
  assert.ok(failureSummary("t1", H1, [cut]).includes("    failing tests: none named in the tail of the output that was kept (the vitest output in it names no failing test; the lines naming them may have been cut with the rest, or the check failed for another reason)\n    log: inline tail only"));
  assert.ok(failureSummary("t1", H1, [wholeRun]).includes("    failing tests: none named (the vitest output names no failing test, so the check failed for another reason)\n    log: whole output, inline"));
  // A stored log that was itself cut is a tail too.
  const capped = `${"x".repeat(LARGE_MAX - VITEST_SUMMARY_ONLY.length - 1)}\n${VITEST_SUMMARY_ONLY}`;
  const [stored] = await resolveFailures(effectiveFailures(policy, [ev({ passed: false, where: "sandbox", log: ref({ bytes: LARGE_MAX }), outputTail: "t" })], H1), async () => capped);
  assert.ok(failureSummary("t1", H1, [stored]).includes("none named in the tail of the output that was kept"));
});

// ── which runs: the gate's own selection ───────────────────────────────────

test("a check whose latest run at the head passes is no failure, however many earlier runs failed (retries)", () => {
  const evidence = [ev({ passed: false }), ev({ passed: false }), ev({ passed: true }), ev({ claim: "npm run typecheck", passed: true })];
  assert.deepEqual(effectiveFailures(policy, evidence, H1), []);
  assert.deepEqual(gate(item(), policy, evidence, []).blockers, []);
});

test("the latest run decides: a failure after a pass is the failure, named by its evidence id and its place among the attempts", () => {
  const evidence = [ev({ passed: true }), ev({ passed: false, outputTail: "not ok 1 - the cap" }), ev({ claim: "npm run typecheck", passed: true })];
  const failures = effectiveFailures(policy, evidence, H1);
  assert.equal(failures.length, 1);
  const f = failures[0];
  assert.equal(f.claim, "npm test");
  assert.equal(f.head, H1);
  assert.equal(f.id, evidence[1].id);
  assert.equal(f.run, null);
  assert.deepEqual([f.attempt, f.attempts], [2, 2]);
  assert.equal(f.where, "runner");
  assert.equal(f.merged, false);
  assert.equal(f.outputTail, "not ok 1 - the cap");
  // The same run the gate names.
  assert.deepEqual(gate(item(), policy, evidence, []).blockers, ["`npm test` failed when observed"]);
});

test("the failures follow the policy's order and keep the container run id, where it ran and its load", () => {
  const evidence = [
    ev({ claim: "npm run typecheck", passed: false, where: "sandbox", run: "key:t1:aaaaaaaaaaaa:1", load: undefined }),
    ev({ passed: false, load: 7.5 }),
  ];
  const failures = effectiveFailures(policy, evidence, H1);
  assert.deepEqual(failures.map((f) => f.claim), ["npm test", "npm run typecheck"]);
  assert.deepEqual([failures[0].load, failures[0].run], [7.5, null]);
  assert.deepEqual([failures[1].where, failures[1].run, failures[1].load], ["sandbox", "key:t1:aaaaaaaaaaaa:1", null]);
});

test("runs at another head, reports and not-applicable records never make a failure at this head (historical heads)", () => {
  const evidence = [
    ev({ head: H2, passed: false }),
    ev({ grade: "reported", passed: null, outputTail: undefined }),
    ev({ claim: "npm run typecheck", passed: null, notApplicable: true }),
    ev({ passed: true }),
  ];
  assert.deepEqual(effectiveFailures(policy, evidence, H1), []);
  // At the older head, read as the head of its own time, the failure is there.
  assert.equal(effectiveFailures(policy, evidence, H2).length, 1);
  assert.deepEqual(effectiveFailures(policy, evidence, null), []);
});

test("a failing run on the merge with main is a failure exactly when the gate counts it as a blocker", () => {
  const own = ev({ passed: true, mainHead: M1 }), ownType = ev({ claim: "npm run typecheck", passed: true, mainHead: M1 });
  // Main moved after the head's own check passed: the merged failure blocks.
  const blocking = ev({ passed: false, merged: true, mainHead: M2, changedPaths: null });
  const failures = effectiveFailures(policy, [own, ownType, blocking], H1);
  assert.equal(failures.length, 1);
  assert.deepEqual([failures[0].merged, failures[0].mainHead, failures[0].id], [true, M2, blocking.id]);
  assert.match(gate(item(), policy, [own, ownType, blocking], []).blockers.join("\n"), /failed on the merge with main at 22222222/);
  // The same main as the head's own check saw: shown, not counted, so not a failure.
  const same = ev({ passed: false, merged: true, mainHead: M1, changedPaths: null });
  assert.deepEqual(effectiveFailures(policy, [own, ownType, same], H1), []);
});

// ── which log ──────────────────────────────────────────────────────────────

test("the stored log is read by its reference and labelled whole", async () => {
  const log = await readCheckLog({ outputTail: "tail", log: ref(), where: "sandbox" }, async (r) => `whole ${r.sha256.slice(0, 4)}`);
  assert.deepEqual(log, { text: "whole cccc", source: "stored", whole: true, label: `whole log, stored (12,000 bytes, ${"c".repeat(12)})` });
});

test("a stored log that cannot be read is labelled unavailable, and the inline tail stands in", async () => {
  const gone = await readCheckLog({ outputTail: "the tail", log: ref(), where: "sandbox" }, none);
  assert.equal(gone.source, "inline");
  assert.equal(gone.text, "the tail");
  assert.equal(gone.label, `unavailable: the stored log ${"c".repeat(12)} could not be read; whole output, inline`);
  const failed = await readCheckLog({ outputTail: "the tail", log: ref(), where: "sandbox" }, async () => { throw new Error("server request failed: ECONNREFUSED"); });
  assert.equal(failed.label, `unavailable: the stored log ${"c".repeat(12)} could not be read (server request failed: ECONNREFUSED); whole output, inline`);
});

test("an inline tail is labelled a tail only when the output was longer than what the recorder keeps", async () => {
  const sha = `\n[sha256 of full output: ${"0".repeat(64)}]`;
  const short = await readCheckLog({ outputTail: `short output${sha}`, where: "runner" }, none);
  assert.deepEqual([short.whole, short.label], [true, "whole output, inline"]);
  const cut = await readCheckLog({ outputTail: `${"x".repeat(LOCAL_OUTPUT_TAIL)}${sha}`, where: "runner" }, none);
  assert.deepEqual([cut.whole, cut.source], [false, "inline"]);
  assert.equal(cut.label, "inline tail only (a check run on a machine keeps its last 3,500 characters inline, and this output was longer)");
  const container = await readCheckLog({ outputTail: `${"y".repeat(SANDBOX_OUTPUT_TAIL)}\n[atelier] ran in a Cloudflare container in 9s, exit 1`, where: "sandbox" }, none);
  assert.equal(container.label, "inline tail only (a container keeps its last 4,000 characters inline, and this output was longer)");
  // A whole output that ends in a recorder's line of its own, written before
  // any cut, is measured with that line and stays whole.
  const stopped = await readCheckLog({ outputTail: `line 1\nline 2\n[atelier] check exceeded its time limit of 600 s${sha}`, where: "runner" }, none);
  assert.deepEqual([stopped.whole, stopped.label], [true, "whole output, inline"]);
});

test("a cut tail that ends in the recorder's time-limit line is still a tail: the lines written before the cut count as output", async () => {
  const sha = `\n[sha256 of full output: ${"0".repeat(64)}]`;
  // As atelier check records a local check that timed out (cli/atelier.mjs
  // runCheck): the `[atelier] check …` line is appended to the output, the
  // last LOCAL_OUTPUT_TAIL characters are kept, and the sha256 line follows.
  // A 12,336-character output read as whole once the [atelier] line was
  // dropped before measuring; it is a tail.
  const lines = Array.from({ length: 650 }, (_, i) => `✔ test ${i} (1.2ms)`).join("\n");
  const output = `${lines}\n[atelier] check exceeded its time limit of 600 s`;
  assert.ok(output.length > 12_000, String(output.length));
  const local = await readCheckLog({ outputTail: `${output.slice(-LOCAL_OUTPUT_TAIL)}${sha}`, where: "runner" }, none);
  assert.deepEqual([local.whole, local.source], [false, "inline"]);
  assert.equal(local.label, "inline tail only (a check run on a machine keeps its last 3,500 characters inline, and this output was longer)");
  // The same in a container: its `stopped after` line comes before the cut,
  // its `ran in` line after.
  const inContainer = `${lines}\n[atelier] stopped after 900s`;
  const container = await readCheckLog({ outputTail: `${inContainer.slice(-SANDBOX_OUTPUT_TAIL)}\n[atelier] ran in a Cloudflare container in 900s, exit 124`, where: "sandbox" }, none);
  assert.deepEqual([container.whole, container.source], [false, "inline"]);
  assert.equal(container.label, "inline tail only (a container keeps its last 4,000 characters inline, and this output was longer)");
  // The summary then says the names were read from a tail, not that the check failed for another reason.
  const [f] = await resolveFailures(effectiveFailures(policy, [ev({ passed: false, outputTail: `${output.slice(-LOCAL_OUTPUT_TAIL)}${sha}` })], H1), none);
  assert.ok(failureSummary("t1", H1, [f]).includes("read from a tail of the output") || failureSummary("t1", H1, [f]).includes("in the tail of the output that was kept"), failureSummary("t1", H1, [f]));
  // A stored log that was itself capped says so.
  const capped = await readCheckLog({ outputTail: "t", log: ref({ bytes: LARGE_MAX }), where: "sandbox" }, async () => `${"x".repeat(LARGE_MAX - 8)}\nthe end`);
  assert.deepEqual([capped.whole, capped.source], [false, "stored"]);
  assert.match(capped.label, /^stored log c{12}, cut to its last 33,554,432 characters/);
  // The cap is in characters (capLarge): a log of fewer characters is whole,
  // though its multi-byte characters take LARGE_MAX bytes or more.
  const wide = await readCheckLog({ outputTail: "t", log: ref({ bytes: LARGE_MAX + 2 }), where: "sandbox" }, async () => "é the end");
  assert.deepEqual([wide.whole, wide.source], [true, "stored"]);
  assert.equal(wide.label, `whole log, stored (33,554,434 bytes, ${"c".repeat(12)})`);
});

test("the shown tail is bounded by lines and characters, flattened, with the log's length said", () => {
  const long = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
  const tail = boundedTail(long);
  assert.equal(tail.total, 50);
  assert.equal(tail.lines.length, SUMMARY_TAIL_LINES);
  assert.deepEqual([tail.lines[0], tail.lines.at(-1)], ["line 31", "line 50"]);
  const wide = boundedTail(Array.from({ length: 5 }, (_, i) => `${i}${"w".repeat(900)}`).join("\n"));
  assert.ok(wide.lines.join("").length <= SUMMARY_TAIL_CHARS);
  assert.ok(wide.lines.length < 5 && wide.lines.at(-1)!.startsWith("4"));
  assert.equal(wide.cut, 0);
  const oneLine = boundedTail("z".repeat(SUMMARY_TAIL_CHARS + 10));
  assert.equal(oneLine.lines[0].length, SUMMARY_TAIL_CHARS);
  assert.ok(oneLine.lines[0].startsWith("…"));
  assert.deepEqual([oneLine.total, oneLine.cut], [1, SUMMARY_TAIL_CHARS + 10]);
  assert.deepEqual(boundedTail("\x1b[31mred\x1b[0m\tx\r\n\n\x07bell").lines, ["red x", "bell"]);
  assert.deepEqual(boundedTail(""), { lines: [], total: 0, cut: 0 });
});

test("a line longer than the summary's characters is cut to its last characters and said to be cut, never reported whole", async () => {
  // One 2,500-character line: the tail keeps its last SUMMARY_TAIL_CHARS
  // characters behind a `…` and says the line's whole length.
  const line = `${"y".repeat(2_400)}${"z".repeat(100)}`;
  const tail = boundedTail(line);
  assert.deepEqual([tail.lines.length, tail.total, tail.cut], [1, 1, 2_500]);
  assert.equal(tail.lines[0], `…${line.slice(-(SUMMARY_TAIL_CHARS - 1))}`);
  // A long line that is not the last is left out whole rather than cut: the
  // lines after it fill the budget first, and nothing retained is cut.
  const notLast = boundedTail(`${line}\nnot ok 1 - the cap is enforced`);
  assert.deepEqual([notLast.lines, notLast.total, notLast.cut], [["not ok 1 - the cap is enforced"], 2, 0]);
  // In the summary: a whole output of that one line is not "1 line, whole".
  const typecheck = ev({ claim: "npm run typecheck", passed: true });
  const [one] = await resolveFailures(effectiveFailures(policy, [ev({ passed: false, outputTail: line }), typecheck], H1), none);
  const text = failureSummary("t1", H1, [one]);
  assert.ok(text.includes(`    log: whole output, inline; 1 line, cut to its last ${(SUMMARY_TAIL_CHARS - 1).toLocaleString("en-US")} of 2,500 characters:\n      …${"y".repeat(SUMMARY_TAIL_CHARS - 101)}${"z".repeat(100)}\n`), text);
  assert.ok(!text.includes("whole:"), text);
  // Among more lines, the count of lines shown is said with the cut.
  const [last] = await resolveFailures(effectiveFailures(policy, [ev({ passed: false, outputTail: `one\ntwo\n${line}` }), typecheck], H1), none);
  assert.ok(failureSummary("t1", H1, [last]).includes(`    log: whole output, inline; last 1 of 3 lines, cut to its last ${(SUMMARY_TAIL_CHARS - 1).toLocaleString("en-US")} of 2,500 characters:\n`), failureSummary("t1", H1, [last]));
  // Fitted to a size that leaves no tail, the line is left out and not called cut.
  const fitted = failureSummary("t1", H1, [one], 700);
  assert.ok(fitted.includes("    log: whole output, inline; 1 line, left out of this summary for its size\n"), fitted);
  assert.ok(fitted.length <= 700 && fitted.endsWith(checkLogPointer("t1")), fitted);
  // The JSON form carries the cut line's length.
  assert.deepEqual([failureJson(one).cut, failureJson(one).lines, failureJson(one).tail.length], [2_500, 1, 1]);
  assert.equal(failureJson(last).cut, 2_500);
});

// ── the summary every caller prints ────────────────────────────────────────

test("the failure summary names each failed check by command, head and evidence id, the failing tests and a labelled bounded tail", async () => {
  const stored = ref();
  const evidence = [
    ev({ passed: true }),
    ev({ passed: false, outputTail: `${fixture("node-spec.txt")}`, load: 3.2 }),
    ev({ claim: "npm run typecheck", passed: false, where: "sandbox", run: "k:t1:aaaaaaaaaaaa:7", log: stored, outputTail: "tail only" }),
  ];
  const failures = await resolveFailures(effectiveFailures(policy, evidence, H1), async (r) => (r.sha256 === stored.sha256 ? fixture("tsc.txt") : null));
  const text = failureSummary("t1", H1, failures);
  const lines = text.split("\n");
  assert.equal(lines[0], "Failed checks at aaaaaaaa, as the gate reads them (the latest counting run of each required check at this head):");
  assert.equal(lines[1], `  \`npm test\` failed on a runner, in a clean clone at 2026-10-10 12:00 UTC, load 3.2: evidence #${evidence[1].id}, attempt 2 of 2 at this head`);
  assert.equal(lines[2], "    failing tests (node:test): fails: the cap is enforced; fails inside: names are read");
  assert.match(lines[3], /^    log: whole output, inline; last 20 of \d+ lines:$/);
  assert.equal(lines[4 + SUMMARY_TAIL_LINES], `  \`npm run typecheck\` failed in a Cloudflare container at 2026-10-10 12:00 UTC: evidence #${evidence[2].id}, run k:t1:aaaaaaaaaaaa:7, attempt 1 of 1 at this head`);
  assert.equal(lines[5 + SUMMARY_TAIL_LINES], "    failing tests: none named (the output holds 2 TypeScript errors, which name no test)");
  assert.equal(lines[6 + SUMMARY_TAIL_LINES], `    log: whole log, stored (12,000 bytes, ${"c".repeat(12)}); 5 lines, whole:`);
  assert.ok(lines.slice(7 + SUMMARY_TAIL_LINES, -1).every((line) => line.startsWith("      ")));
  assert.equal(lines.at(-1), "  Whole logs of every attempt at this head: atelier check-log t1");
  // The tail is the stored log, not the inline tail.
  assert.ok(text.includes("error TS2322") && !text.includes("tail only"));
  assert.equal(failureSummary("t1", H1, []), "No required check fails at aaaaaaaa as the gate reads it.");
});

test("a failure with no test names and no stored log says so, and a merged failure says which main it merged", async () => {
  const own = ev({ passed: true, mainHead: M1 }), ownType = ev({ claim: "npm run typecheck", passed: true, mainHead: M1 });
  const merged = ev({ passed: false, merged: true, mainHead: M2, changedPaths: null, outputTail: fixture("plain.txt") });
  const [f] = await resolveFailures(effectiveFailures(policy, [own, ownType, merged], H1), none);
  const text = failureSummary("t1", H1, [f]);
  assert.ok(text.includes(`\`npm test\` failed on the merge with main at 22222222 on a runner, in a clean clone at 2026-10-10 12:00 UTC: evidence #${merged.id}, attempt 2 of 2 at this head`), text);
  assert.ok(text.includes("    failing tests: names unavailable (no test reporter format this summary reads was recognised in the output)"), text);
  assert.ok(text.includes("    log: whole output, inline; 5 lines, whole:"), text);
  assert.ok(text.includes("      make: *** [Makefile:12: build] Error 1"), text);
  const empty = await resolveFailures(effectiveFailures(policy, [ev({ passed: false, outputTail: "" }), ownType], H1), none);
  assert.ok(failureSummary("t1", H1, empty).includes("    log: whole output, inline; no output\n"), failureSummary("t1", H1, empty));
});

test("fitted to a size, the summary keeps its heading, every failed check and the check-log line, giving up the tails, then names, then later checks", async () => {
  const claims = ["npm test", "npm run typecheck", "npm run lint", "npm run build"];
  // Each output is whole (shorter than what the recorder keeps inline): 30 failing tests, then 20 lines of log.
  const log = (claim: string) => Array.from({ length: 20 }, (_, i) => `${claim} line ${i + 1} ${"#".repeat(20)}`).join("\n");
  const names = Array.from({ length: 30 }, (_, i) => `not ok ${i + 1} - test ${i + 1} of the many`).join("\n");
  const evidence = claims.map((claim) => ev({ claim, passed: false, outputTail: `${names}\n${log(claim)}` }));
  const failures = await resolveFailures(effectiveFailures({ ...policy, checks: claims }, evidence, H1), none);
  assert.ok(failures.every((f) => f.logRead.whole));
  const pointer = "  Whole logs of every attempt at this head: atelier check-log t1";
  const full = failureSummary("t1", H1, failures);
  assert.ok(full.length > 4000, String(full.length));
  assert.equal(failureSummary("t1", H1, failures, full.length), full);
  assert.equal(failureSummary("t1", H1, failures, Infinity), full);
  const named = (text: string) => claims.filter((claim) => text.includes(`\`${claim}\` failed on a runner`));
  // Within the landing Workflow's record: the tails give way, every check stays, the pointer ends it.
  const fitted = failureSummary("t1", H1, failures, 1800);
  assert.ok(fitted.length <= 1800 && fitted.length > 1500, String(fitted.length));
  assert.ok(fitted.startsWith("Failed checks at aaaaaaaa, as the gate reads them"));
  assert.ok(fitted.endsWith(`\n${pointer}`), fitted);
  assert.deepEqual(named(fitted), claims);
  assert.match(fitted, /log: whole output, inline; (?:50 lines, left out of this summary for its size|last \d+ of 50 lines \(fewer, for this summary's size\):)/);
  assert.ok(!fitted.includes("And "), fitted);
  // Tighter: fewer names are listed and the rest counted, before any check is dropped.
  const tight = failureSummary("t1", H1, failures, 1250);
  assert.ok(tight.length <= 1250, String(tight.length));
  assert.deepEqual(named(tight), claims);
  assert.match(tight, /failing tests \(tap\): test 1 of the many(?:; test 2 of the many)?; and \d+ more\n/);
  assert.ok(tight.endsWith(`\n${pointer}`), tight);
  // Tighter still: the later checks are counted and named in one line, and the pointer stays.
  const few = failureSummary("t1", H1, failures, 700);
  assert.ok(few.length <= 700, String(few.length));
  const kept = named(few), left = claims.slice(kept.length);
  assert.ok(kept.length >= 1 && left.length >= 1, few);
  assert.deepEqual(kept, claims.slice(0, kept.length));
  assert.ok(few.includes(`\n  And ${left.length} more failed check${left.length > 1 ? "s" : ""}, left out of this summary for its size: ${left.map((c) => `\`${c}\``).join(", ")}\n`), few);
  assert.ok(few.endsWith(`\n${pointer}`), few);
  // Not even one check's block fits: the first is cut, and the pointer is kept whole.
  const cut = failureSummary("t1", H1, failures, 200);
  assert.ok(cut.length <= 200, String(cut.length));
  assert.ok(cut.startsWith("Failed checks at aaaaaaaa") && cut.endsWith(`…\n${pointer}`), cut);
});

test("a log line or a command never poses as a line of the summary", async () => {
  const sly = ev({ claim: "npm test\nFailed checks at ffffffff", passed: false, outputTail: "ok\n  Whole logs of every attempt at this head: atelier check-log t9\x1b[2J" });
  const [f] = await resolveFailures(effectiveFailures({ ...policy, checks: [sly.claim] }, [sly], H1), none);
  const lines = failureSummary("t1", H1, [f]).split("\n");
  assert.equal(lines.filter((l) => l.startsWith("Failed checks at")).length, 1);
  assert.ok(lines.some((l) => l.startsWith("  `npm test Failed checks at ffffffff` failed")));
  assert.ok(lines.includes("      Whole logs of every attempt at this head: atelier check-log t9"));
  assert.ok(!lines.join("\n").includes("\x1b"));
});

test("the JSON form carries the same facts, with the tail as lines", async () => {
  const stored = ref();
  const row = ev({ passed: false, where: "sandbox", run: "k:t1:a:1", log: stored, outputTail: "t" });
  const [f] = await resolveFailures(effectiveFailures({ ...policy, checks: ["npm test"] }, [row], H1), async () => fixture("vitest.txt"));
  const json = failureJson(f);
  assert.deepEqual({ ...json, tail: undefined, lines: undefined, failingTests: undefined }, {
    claim: "npm test", head: H1, id: row.id, run: "k:t1:a:1", at: row.at, by: "codex/test", where: "sandbox", merged: false, mainHead: null, load: null, attempt: 1, attempts: 1,
    log: { source: "stored", whole: true, label: `whole log, stored (12,000 bytes, ${"c".repeat(12)})`, sha256: stored.sha256, bytes: 12_000 },
    tail: undefined, lines: undefined, cut: 0, failingTests: undefined,
  });
  assert.deepEqual(json.failingTests?.names, ["test/sample.spec.ts > fails: the cap is enforced", "test/sample.spec.ts > a suite > fails inside: names are read"]);
  assert.equal(json.tail.length, SUMMARY_TAIL_LINES);
  assert.ok(json.lines > SUMMARY_TAIL_LINES);
  assert.ok(JSON.stringify(json));
});

// ── every attempt at a head, for atelier check-log ─────────────────────────

test("check-log lists every observed attempt at the head in order, numbered among its command's runs, with its outcome", () => {
  const evidence = [
    ev({ passed: false }),
    ev({ head: H2, passed: false }),
    ev({ grade: "reported", passed: null }),
    ev({ claim: "npm run typecheck", passed: null, notApplicable: true }),
    ev({ passed: true, merged: true, mainHead: M1, changedPaths: null, where: "sandbox", run: "k:t1:a:3" }),
    ev({ passed: true, load: 1.5 }),
  ];
  const attempts = checkAttemptsAt(evidence, H1);
  assert.deepEqual(attempts.map((a) => [a.claim, a.attempt, a.attempts, a.outcome, a.merged, a.id]), [
    ["npm test", 1, 3, "failed", false, evidence[0].id],
    ["npm run typecheck", 1, 1, "not applicable", false, evidence[3].id],
    ["npm test", 2, 3, "passed", true, evidence[4].id],
    ["npm test", 3, 3, "passed", false, evidence[5].id],
  ]);
  assert.equal(attemptHeader(attempts[0]), `── \`npm test\` · attempt 1 of 3 · failed · on a runner, in a clean clone · 2026-10-10 12:00 UTC · evidence #${evidence[0].id}`);
  assert.equal(attemptHeader(attempts[2]), `── \`npm test\` · attempt 2 of 3 · passed on the merge with main at 11111111 · in a Cloudflare container · 2026-10-10 12:00 UTC · evidence #${evidence[4].id}, run k:t1:a:3`);
  assert.equal(attemptHeader(attempts[3]), `── \`npm test\` · attempt 3 of 3 · passed · on a runner, in a clean clone · 2026-10-10 12:00 UTC · load 1.5 · evidence #${evidence[5].id}`);
  // An earlier head keeps its own attempts, read with --head.
  assert.deepEqual(checkAttemptsAt(evidence, H2).map((a) => [a.attempt, a.attempts, a.outcome]), [[1, 1, "failed"]]);
  assert.deepEqual(checkAttemptsAt(evidence, null), []);
  assert.deepEqual(headsWithChecks(evidence).map((h) => [h.head, h.runs]), [[H1, 4], [H2, 1]]);
});

// ── one numbering of the attempts, in show, the landings and check-log ─────

// The number a summary line prints for a run, and the number check-log prints for the same run.
const summaryAttempt = (text: string) => /attempt (\d+) of (\d+) at this head/.exec(text)?.slice(1).join(" of ");
const logAttempt = (attempts: ReturnType<typeof checkAttemptsAt>, id: number | null) => {
  const a = attempts.find((x) => x.id === id)!;
  return /· attempt (\d+) of (\d+) ·/.exec(attemptHeader(a))?.slice(1).join(" of ");
};

test("show, the landings and check-log number a run alike: own, merged, own at one head", async () => {
  const first = ev({ passed: false, mainHead: M1 }), typecheck = ev({ claim: "npm run typecheck", passed: true, mainHead: M1 });
  const merged = ev({ passed: true, merged: true, mainHead: M1, changedPaths: null, where: "sandbox", run: "k:t1:a:2" });
  const third = ev({ passed: false, mainHead: M1, outputTail: "not ok 1 - the cap" });
  const evidence = [first, typecheck, merged, third];
  const [f] = await resolveFailures(effectiveFailures(policy, evidence, H1), none);
  assert.deepEqual([f.id, f.attempt, f.attempts], [third.id, 3, 3]);
  const text = failureSummary("t1", H1, [f]);
  assert.ok(text.includes(`evidence #${third.id}, attempt 3 of 3 at this head`), text);
  const attempts = checkAttemptsAt(evidence, H1);
  assert.equal(summaryAttempt(text), "3 of 3");
  assert.equal(logAttempt(attempts, third.id), "3 of 3");
  assert.deepEqual(attempts.filter((a) => a.claim === "npm test").map((a) => [a.id, a.attempt, a.attempts]), [[first.id, 1, 3], [merged.id, 2, 3], [third.id, 3, 3]]);
  assert.deepEqual(failureJson(f).attempt, 3);
  // One helper numbers both: the number of every row is the one attemptNumbers gives it.
  const numbers = attemptNumbers(evidence, H1);
  for (const a of attempts) assert.deepEqual(numbers.get(a.evidence), { attempt: a.attempt, attempts: a.attempts });
  // A blocking merged failure is numbered among the head's own runs too.
  const own = ev({ passed: true, mainHead: M1 }), blocking = ev({ passed: false, merged: true, mainHead: M2, changedPaths: null });
  const rows = [own, typecheck, blocking];
  const [m] = await resolveFailures(effectiveFailures(policy, rows, H1), none);
  assert.equal(summaryAttempt(failureSummary("t1", H1, [m])), "2 of 2");
  assert.equal(logAttempt(checkAttemptsAt(rows, H1), blocking.id), "2 of 2");
});

test("a container run recorded before t768 is numbered after the machine run before it, everywhere", async () => {
  const machine = ev({ passed: false }), container = ev({ passed: false, where: "sandbox", run: "k:t1:a:2" });
  const typecheck = ev({ claim: "npm run typecheck", passed: true, where: "sandbox" });
  const evidence = [machine, container, typecheck];
  const [f] = await resolveFailures(effectiveFailures(policy, evidence, H1), none);
  assert.deepEqual([f.id, f.attempt, f.attempts], [container.id, 2, 2]);
  const text = failureSummary("t1", H1, [f]);
  const attempts = checkAttemptsAt(evidence, H1);
  assert.equal(summaryAttempt(text), "2 of 2");
  assert.equal(logAttempt(attempts, container.id), "2 of 2");
  assert.equal(attemptHeader(attempts[0]), `── \`npm test\` · attempt 1 of 2 · failed · on a runner, in a clean clone · ${machine.at.slice(0, 16).replace("T", " ")} UTC · evidence #${machine.id}`);
  assert.match(attemptHeader(attempts[1]), /in a Cloudflare container/);
});

test("a why line longer than the landing record leaves the summary its check-log line", async () => {
  const [f] = await resolveFailures(effectiveFailures(policy, [ev({ passed: false, outputTail: "not ok 1 - the cap" }), ev({ claim: "npm run typecheck", passed: true })], H1), none);
  const why = `the required checks failed: ${"npm test; ".repeat(400)}`;
  const detail = failureDetail(why, "t1", H1, [f], 2000);
  assert.ok(detail.length <= 2000, String(detail.length));
  assert.ok(detail.endsWith(`…\n${checkLogPointer("t1")}`), detail.slice(-200));
  assert.ok(detail.startsWith("the required checks failed: npm test; "));
  // A why that leaves room is kept whole, and the summary fitted after it.
  const short = failureDetail("the required checks failed: npm test.", "t1", H1, [f], 2000);
  assert.ok(short.startsWith("the required checks failed: npm test.\nFailed checks at aaaaaaaa"), short);
  assert.equal(short, `the required checks failed: npm test.\n${failureSummary("t1", H1, [f], 2000 - 38)}`);
});

// t567 at 881860ea, evidence #2957 (2026-10-13 01:59 UTC): a failed `npm
// test` run on a machine kept a tail that held only a design fixture's
// stderr, so the failing test could not be named without a rerun, which
// passed. `npm test` writes stdout before stderr, and since t568 runs the
// vitest pool after a failed node pool, so the lines naming a node failure
// fall out of the last 3,500 characters. The run now keeps the lines naming
// the failure, read from the whole output, beside the tail (t569).
test("a failed run on a machine keeps the lines naming its failure beside a tail of stderr noise, and both check-log and the summary name the failing test", async () => {
  const stdout = [
    "\x1b[32m✔ the cap holds (1.1ms)\x1b[39m",
    "\x1b[31m✖ fails: the release waits for its review (2.3ms)\x1b[39m",
    "  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:",
    "",
    "  1 !== 2",
    "ℹ tests 2",
    "ℹ pass 1",
    "ℹ fail 1",
    " RUN  v3.2.4 /repo",
    " ✓ test/sample.spec.ts (1 test) 3ms",
    " Test Files  1 passed (1)",
    "      Tests  1 passed (1)",
  ].join("\n");
  const noise = Array.from({ length: 120 }, (_, i) => `[design fixture] warning: rendered sample ${i} without a theme`).join("\n");
  const output = `${stdout}\n${noise}\n`;
  assert.ok(noise.length > LOCAL_OUTPUT_TAIL, String(noise.length));
  const sha = `\n[sha256 of full output: ${"0".repeat(64)}]`;
  const outputTail = `${output.slice(-LOCAL_OUTPUT_TAIL)}${sha}`;
  assert.ok(!outputTail.includes("✖"), "the tail alone holds no failure line");

  const failureLines = collectFailureLines(output);
  assert.equal(failureLines, [
    "✖ fails: the release waits for its review (2.3ms)",
    "  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:",
    "ℹ fail 1",
  ].join("\n"));

  // What check-log prints first.
  const log = await readCheckLog({ outputTail, where: "runner", failureLines }, none);
  assert.equal(log.whole, false);
  assert.deepEqual(log.failureLines, failureLines.split("\n"));
  // Without them, the tail names nothing; with them, the summary names the test.
  const [bare] = await resolveFailures(effectiveFailures(policy, [ev({ passed: false, outputTail })], H1), none);
  assert.equal(bare.tests, null);
  const [f] = await resolveFailures(effectiveFailures(policy, [ev({ passed: false, outputTail, failureLines })], H1), none);
  assert.deepEqual(f.tests?.names, ["fails: the release waits for its review"]);
  const summary = failureSummary("t1", H1, [f]);
  assert.ok(summary.includes("failing tests (node:test, read from the failure lines kept from the whole output and from its tail): fails: the release waits for its review"), summary);
  const lines = summary.split("\n");
  const at = lines.findIndex((line) => line.includes("failure lines, read from the whole output: 3 lines:"));
  assert.ok(at > 0 && at < lines.findIndex((line) => line.includes("log: inline tail only")), summary);
  // Fitted to the landing's record, the failure lines give way after the
  // tail and before the names: the failing test is still named.
  const fitted = failureSummary("t1", H1, [f], 900);
  assert.ok(fitted.length <= 900 && fitted.includes("59 lines, left out of this summary for its size") && fitted.includes("fails: the release waits for its review (2.3ms)"), fitted);
  // A whole log in the tail holds the lines already: none are added.
  const whole = await readCheckLog({ outputTail: `${stdout}${sha}`, where: "runner", failureLines }, none);
  assert.equal(whole.failureLines, undefined);
  // TAP's summary count (`# fail 2`) is kept too, so the failure count
  // survives a tail of noise (Astra's review of t569 of 2026-10-13).
  const tap = `${fixture("tap.txt")}\n${noise}\n`;
  assert.ok(!tap.slice(-LOCAL_OUTPUT_TAIL).includes("# fail"), "the tail alone holds no failure count");
  const tapLines = collectFailureLines(tap).split("\n");
  assert.ok(tapLines.includes("# fail 2"), tapLines.join("\n"));
  assert.ok(!tapLines.some((line) => /^# (?:pass|tests|cancelled|skipped|todo)\b/.test(line)), tapLines.join("\n"));
});

test("the failure lines are bounded in lines and characters, read vitest's and TAP's formats, and count what they leave out", () => {
  const vitest = collectFailureLines([
    " FAIL  test/a.spec.ts > a suite > it breaks",
    "AssertionError: expected 1 to be 2",
    " Test Files  1 failed | 3 passed (4)",
    "      Tests  1 failed | 9 passed (10)",
    "not ok 3 - a tap test",
    "  error: 'boom'",
    "not ok 4 - skipped # SKIP later",
  ].join("\n"));
  assert.equal(vitest.split("\n").length, 6);
  assert.ok(!vitest.includes("SKIP"));
  const many = collectFailureLines(Array.from({ length: 500 }, (_, i) => `not ok ${i} - test ${i} ${"x".repeat(150)}`).join("\n"));
  const kept = many.split("\n");
  assert.ok(kept.length <= FAILURE_LINES_MAX && many.length <= FAILURE_LINES_CHARS, `${kept.length} ${many.length}`);
  assert.match(kept.at(-1)!, /^\[atelier\] and \d+ more failure lines not kept$/);
  assert.equal(collectFailureLines("all fine\nℹ fail 0"), "");
  assert.equal(collectFailureLines("# tests 3\n# pass 3\n# fail 0"), "");
});
