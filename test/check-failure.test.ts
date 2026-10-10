import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  attemptHeader, boundedTail, checkAttemptsAt, effectiveFailures, failingTests, failingTestsLine, failureJson, failureSummary,
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

test("the summary lists at most SUMMARY_TEST_NAMES names and counts the rest", () => {
  const output = Array.from({ length: SUMMARY_TEST_NAMES + 3 }, (_, i) => `not ok ${i + 1} - test ${i + 1}`).join("\n");
  const line = failingTestsLine(failingTests(output));
  assert.ok(line.endsWith(`test ${SUMMARY_TEST_NAMES}; and 3 more`), line);
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

test("under sandboxOnly a failure on someone's machine does not count, as the gate does not count it; a container's does", () => {
  const only: ProjectPolicy = { ...policy, sandboxOnly: true };
  assert.deepEqual(effectiveFailures(only, [ev({ passed: false }), ev({ claim: "npm run typecheck", passed: false })], H1), []);
  const failures = effectiveFailures(only, [ev({ passed: false }), ev({ passed: false, where: "sandbox" })], H1);
  assert.deepEqual(failures.map((f) => [f.claim, f.where, f.attempts]), [["npm test", "sandbox", 1]]);
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
  // A stored log that was itself capped says so.
  const capped = await readCheckLog({ outputTail: "t", log: ref({ bytes: LARGE_MAX }), where: "sandbox" }, async () => "the end");
  assert.deepEqual([capped.whole, capped.source], [false, "stored"]);
  assert.match(capped.label, /^stored log c{12}, cut to its last 33,554,432 characters/);
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
  const oneLine = boundedTail("z".repeat(SUMMARY_TAIL_CHARS + 10));
  assert.equal(oneLine.lines[0].length, SUMMARY_TAIL_CHARS);
  assert.ok(oneLine.lines[0].startsWith("…"));
  assert.deepEqual(boundedTail("\x1b[31mred\x1b[0m\tx\r\n\n\x07bell").lines, ["red x", "bell"]);
  assert.deepEqual(boundedTail(""), { lines: [], total: 0 });
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
  assert.ok(text.includes(`\`npm test\` failed on the merge with main at 22222222 on a runner, in a clean clone at 2026-10-10 12:00 UTC: evidence #${merged.id}, attempt 1 of 1 at this head`), text);
  assert.ok(text.includes("    failing tests: names unavailable (no test reporter format this summary reads was recognised in the output)"), text);
  assert.ok(text.includes("    log: whole output, inline; 5 lines, whole:"), text);
  assert.ok(text.includes("      make: *** [Makefile:12: build] Error 1"), text);
  const empty = await resolveFailures(effectiveFailures(policy, [ev({ passed: false, outputTail: "" }), ownType], H1), none);
  assert.ok(failureSummary("t1", H1, empty).includes("    log: whole output, inline; no output\n"), failureSummary("t1", H1, empty));
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
    tail: undefined, lines: undefined, failingTests: undefined,
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
