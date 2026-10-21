// Why a check failed, where the CLI can read it (t436). A failed check once
// reached the owner as a name alone: the brief counted it, the landing named
// it, and the output that said which test broke stayed on the task page or
// in the ledger. This module reads the failure the way the gate reads it and
// says, for each failed check, which run it is, which tests failed, and the
// end of its log, so `atelier show`, the plain landing (cli/land.mjs) and the
// landing Workflow (src/landing-workflow.ts) print one and the same summary.
//
// Pure functions, run with `node --test` (test/check-failure.test.ts). The
// reporter formats are fixed by fixtures under test/fixtures/check-logs.
//
// Which runs: effectiveFailures reads the evidence with the gate's own
// selection (evidenceAt and blockingMergedRuns in src/rules.ts): for each
// required check that applies at the head, the latest observed run at that
// head that counts (never a report, never a merged run); and each failing merged run
// that blocks acceptance. A check whose latest run passes is not a failure,
// however many earlier runs failed; one at another head is not read at all.
//
// Which attempt: a run is numbered once, by attemptNumbers, and `show`, both
// landings and `atelier check-log` print that one number. It counts every
// observed run of the command at the head, oldest first: the head's own
// runs, the runs on the merge with main and not-applicable records alike, so "attempt 3 of 3" in a
// summary is the third block check-log prints for that command. Whether the
// gate counts a run is said beside the number, never by renumbering: a
// summary names only runs the gate reads.
//
// Which log: a run made in a Cloudflare container keeps its whole output in
// R2 by reference (src/large.ts) when the output outgrew the tail held
// inline, and readCheckLog reads that reference when the run has one; else
// the inline tail. Every log is labelled as what it is: the whole output, an
// inline tail only (a run on someone's machine keeps its last
// LOCAL_OUTPUT_TAIL characters; a container's the last SANDBOX_OUTPUT_TAIL),
// a stored log cut to its last LARGE_MAX characters, or unavailable, when the
// stored log can no longer be read and the inline tail stands in for it.
// Whether an inline tail is the whole output is measured on the tail as
// recorded, less only the lines the recorder appended after cutting it; the
// `[atelier]` lines written before the cut (a check that ran out of time)
// are output and count.
//
// Which tests: failingTests reads the names of the failing tests from the
// reporter formats below, and from no other. Output no format fits, or that
// fits a format naming no failing test (a suite that could not start, a
// typecheck), says the names are unavailable; no name is ever derived from
// the shape of a line a reporter did not write. When the log read is a tail
// of the output rather than the whole (an inline tail only, or a stored log
// that was cut), the lines naming the failing tests may have been cut with
// the rest: the summary says so, both when it finds no name and beside the
// names it does find, rather than concluding that the check failed for
// another reason. The formats, each fixed by a fixture:
//   node:test, spec reporter (Node's default): `✖ name (1.2ms)` lines, read
//     from the `✖ failing tests:` summary when the output holds it, where
//     only tests are listed; without that summary (an output cut before its
//     end) every `✖` line is read, and a suite marked failed for its
//     children counts among them.
//   TAP (node:test --test-reporter=tap, tape, Perl's prove, bats): `not ok N
//     - name` lines, at any indent; a `# SKIP` or `# TODO` directive is not a
//     failure.
//   vitest: ` FAIL  file > suite > name` lines (a `|project| ` label before
//     the file is passed over), else the `× name` lines of its file tree.
//   jest: `● suite › name` lines, else `✕ name (N ms)` lines.
//   pytest: `FAILED path::name` and `ERROR path::name` lines of the short
//     test summary.
//   go test: `--- FAIL: Name` lines, subtests included.
//   cargo test: `test path::name ... FAILED` lines.
//   XCTest: `Test Case '-[Module.Class testName]' failed` (and the newer
//     `Test Case 'Module.Class.testName()' failed`); swift-testing: `✘ Test
//     "name" failed` and `✘ Test name() failed`.
//   tsc: `error TSnnnn:` lines are recognised as a typecheck, which names no
//     test: the summary says so instead of reading a name from them.
//
// The summary's log tail is bounded: the last SUMMARY_TAIL_LINES lines and
// at most SUMMARY_TAIL_CHARS characters of the log, and it says how many
// lines the log holds when more were cut. A single line longer than that
// (a minified bundle, a one-line JSON report) is cut to its last
// SUMMARY_TAIL_CHARS characters, and the summary says so, with the line's
// length, rather than calling the log whole. `atelier check-log ID` prints
// the retained logs whole, for every attempt at the head.
//
// Where the summary itself must fit a size (the landing Workflow's record of
// why it failed holds LANDING_DETAIL_MAX characters, src/ledger.ts), it is
// fitted rather than cut at the size: the log tails give way first, then
// the number of test names listed, then the later checks are counted and
// named in one line; the heading, each check kept, and the check-log line
// that points at the whole logs always remain, so a reader of the record
// is never left without the command that prints what was left out.

import { LARGE_MAX, type LargeRef } from "./large.ts";
import { FAILURE_LINES_CHARS } from "./text.ts";
import { blockingMergedRuns, countingRunsAt, evidenceAt, type Evidence, type ProjectPolicy } from "./rules.ts";

// What a check run on someone's machine keeps of its output inline:
// `atelier check` posts the output's last LOCAL_OUTPUT_TAIL characters and a
// sha256 of the whole (cli/atelier.mjs). The container runner keeps the
// last SANDBOX_OUTPUT_TAIL inline and the whole log in R2 beside it when the
// output was longer; it is kept for the results the container check recorded
// before t768 removed it.
export const LOCAL_OUTPUT_TAIL = 3500;
export const SANDBOX_OUTPUT_TAIL = 4000;

// The failure lines of a failed check run on a machine (t569). Its last
// LOCAL_OUTPUT_TAIL characters can hold only noise: `npm test` writes stdout
// before stderr, and since t568 it runs the vitest pool after a failed node
// pool, so the lines naming a failing node test fall out of the tail (t567
// at 881860ea, evidence #2957: the tail held only a design fixture's stderr,
// and the failing test could not be named without a rerun, which passed).
// `atelier check` therefore reads the whole output for the lines that name
// a failure and posts them beside the tail as `failureLines`: at most
// FAILURE_LINES_MAX lines and FAILURE_LINES_CHARS characters, terminal
// control sequences dropped, each line cut at FAILURE_LINE_CHARS. The Worker
// refuses more than FAILURE_LINES_CHARS rather than cutting it. The sha256
// posted with the tail stays the sha256 of the whole output.
export const FAILURE_LINES_MAX = 40;
export { FAILURE_LINES_CHARS };
const FAILURE_LINE_CHARS = 300;
// How many of them the failure summary shows, per failed check, before it
// points at check-log for the rest.
export const SUMMARY_FAILURE_LINES = 10;

// The bound on the log tail the failure summary shows, per failed check.
export const SUMMARY_TAIL_LINES = 20;
export const SUMMARY_TAIL_CHARS = 2000;
// How many failing test names the summary lists before it counts the rest.
export const SUMMARY_TEST_NAMES = 20;
// What the landing Workflow keeps of a workspace report's reason (its
// waitForWorkspace, src/landing-workflow.ts), the Ledger's LANDING_DETAIL_MAX
// (src/ledger.ts): the local checks mode of `atelier land --workflow` fits
// its failure summary to this with failureDetail before reporting it, so the
// record keeps every failed check and the check-log line (cli/land.mjs).
export const WORKSPACE_REASON_MAX = 2000;

export type Where = "sandbox" | "runner";

// One failed check as the gate reads it: the run that is the check's result
// at the head, named by its command, head and the ledger's evidence id (and
// the container run id when a container made it).
export interface CheckFailure {
  claim: string;
  head: string;
  id: number | null;       // the evidence row (Evidence.id), null for a row read without one
  run: string | null;      // the container run, when one made the result
  at: string;
  by: string;
  where: Where;
  merged: boolean;         // a failing run on the merge with main that blocks acceptance
  mainHead: string | null;
  load: number | null;
  attempt: number;         // which run of the check at this head this is, counting from 1 (attemptNumbers)
  attempts: number;        // how many runs of the check the head holds, this one included (attemptNumbers)
  outputTail: string;
  failureLines: string;    // the failure lines read from the whole output, posted beside the tail; "" when none
  log: LargeRef | null;
}

const failureOf = (e: Evidence, attempt: number, attempts: number): CheckFailure => ({
  claim: e.claim,
  head: e.head,
  id: typeof e.id === "number" ? e.id : null,
  run: typeof e.run === "string" && e.run ? e.run : null,
  at: e.at,
  by: e.by,
  where: e.where === "sandbox" ? "sandbox" : "runner",
  merged: e.merged === true,
  mainHead: e.mainHead ?? null,
  load: typeof e.load === "number" ? e.load : null,
  attempt,
  attempts,
  outputTail: String(e.outputTail ?? ""),
  failureLines: typeof e.failureLines === "string" ? e.failureLines : "",
  log: e.log ?? null,
});

// The one numbering of the runs at a head (see the head of this file):
// every observed run of each command at the head, oldest first (by time,
// then evidence id), numbered from 1 among the runs of its command. Reports
// are not runs and are left out.
export interface AttemptNumber {
  attempt: number;
  attempts: number;
}

const observedAt = (evidence: Evidence[], head: string): Evidence[] =>
  evidence.filter((e) => e.head === head && e.grade === "observed").sort((a, b) => a.at.localeCompare(b.at) || ((a.id ?? 0) - (b.id ?? 0)));

export function attemptNumbers(evidence: Evidence[], head: string | null): Map<Evidence, AttemptNumber> {
  const out = new Map<Evidence, AttemptNumber>();
  if (!head) return out;
  const rows = observedAt(evidence, head);
  const totals = new Map<string, number>(), seen = new Map<string, number>();
  for (const e of rows) totals.set(e.claim, (totals.get(e.claim) ?? 0) + 1);
  for (const e of rows) {
    const attempt = (seen.get(e.claim) ?? 0) + 1;
    seen.set(e.claim, attempt);
    out.set(e, { attempt, attempts: totals.get(e.claim)! });
  }
  return out;
}

// The failed checks at the head, as the gate reads them (see the head of
// this file): the head's own failures first, in the policy's order, then
// the merged runs that block. Each is numbered by attemptNumbers, as
// check-log numbers it.
export function effectiveFailures(policy: ProjectPolicy, evidence: Evidence[], head: string | null): CheckFailure[] {
  if (!head) return [];
  const numbers = attemptNumbers(evidence, head);
  const numbered = (e: Evidence): CheckFailure => {
    const n = numbers.get(e) ?? { attempt: 1, attempts: 1 };
    return failureOf(e, n.attempt, n.attempts);
  };
  const out: CheckFailure[] = [];
  for (const c of evidenceAt(policy, evidence, head).checks) {
    if (c.grade !== "observed" || c.passed) continue;
    out.push(numbered(countingRunsAt(policy, evidence, head, c.claim).at(-1)!));
  }
  for (const { run } of blockingMergedRuns(policy, evidence, head)) out.push(numbered(run));
  return out;
}

// ── the log ─────────────────────────────────────────────────────────────────

export type LogReader = (ref: LargeRef) => Promise<string | null>;

export interface CheckLog {
  text: string;                  // the log as read: the stored whole, else the inline tail
  source: "stored" | "inline";
  whole: boolean;                // whether `text` is the check's whole output
  label: string;                 // what `text` is, in words: whole, a tail only, cut, or unavailable
  // The failure lines read from the whole output and kept beside an inline
  // tail that is not the whole (t569); absent when there are none, or when
  // the log read is the whole output, which holds them already.
  failureLines?: string[];
}

// The lines a recorder appends after it has cut the tail, which are no part
// of the output measured against what it keeps: the sha256 line `atelier
// check` posts after its cut, and the `[atelier] ran in a Cloudflare
// container…` line the container adds after its own. Every other recorder
// line is written before the cut and is counted as output: the `[atelier]
// check exceeded its time limit…` line of a local check that timed out
// (runCheck in cli/atelier.mjs), a container's `[atelier] stopped after…`
// and its `[atelier] this container has no git…` note. Dropping those too
// measured a cut tail short of what the recorder keeps, and called it whole.
const APPENDED_LINE = /^(?:\[sha256 of full output: [0-9a-f]*\]|\[atelier\] ran in a Cloudflare container\b.*)$/;
const recordedOutput = (tail: string): string => {
  const lines = tail.split("\n");
  while (lines.length > 1 && APPENDED_LINE.test(lines.at(-1)!)) lines.pop();
  return lines.join("\n");
};

const thousands = (n: number) => n.toLocaleString("en-US");

// The log of one run: the stored whole log when the run names one and it
// can be read, else the inline tail, each labelled as what it is. A reader
// that throws, or answers nothing, leaves the stored log unavailable.
export async function readCheckLog(e: Pick<Evidence, "outputTail" | "log" | "where" | "failureLines">, read: LogReader): Promise<CheckLog> {
  const log = await readLog(e, read);
  const lines = typeof e.failureLines === "string" ? plainLines(e.failureLines).filter((line) => line.trim()) : [];
  return lines.length && !log.whole && log.source === "inline" ? { ...log, failureLines: lines } : log;
}

async function readLog(e: Pick<Evidence, "outputTail" | "log" | "where">, read: LogReader): Promise<CheckLog> {
  const tail = String(e.outputTail ?? "");
  const kept = e.where === "sandbox" ? SANDBOX_OUTPUT_TAIL : LOCAL_OUTPUT_TAIL;
  const runOn = e.where === "sandbox" ? "a container" : "a check run on a machine";
  // Measured on the tail as recorded, less only the lines appended after the
  // cut: a tail of the kept length or more was cut from a longer output.
  const inlineCut = recordedOutput(tail).length >= kept;
  const inline = (why: string | null): CheckLog => inlineCut
    ? { text: tail, source: "inline", whole: false, label: `${why ? `${why}; ` : ""}inline tail only (${runOn} keeps its last ${thousands(kept)} characters inline, and this output was longer)` }
    : { text: tail, source: "inline", whole: true, label: `${why ? `${why}; ` : ""}whole output, inline` };
  if (!e.log) return inline(null);
  const sha = e.log.sha256.slice(0, 12);
  let stored: string | null = null, failure: string | null = null;
  try { stored = await read(e.log); } catch (error) { failure = String((error as Error)?.message ?? error).split("\n")[0].slice(0, 200); }
  if (stored === null) return inline(`unavailable: the stored log ${sha} could not be read${failure ? ` (${failure})` : ""}`);
  // The store keeps the last LARGE_MAX characters of a longer log
  // (capLarge), so a cut log is told by its length in characters; its size
  // in bytes is larger wherever a character takes more than one byte.
  if (stored.length >= LARGE_MAX) {
    return { text: stored, source: "stored", whole: false, label: `stored log ${sha}, cut to its last ${thousands(LARGE_MAX)} characters (${thousands(e.log.bytes)} bytes)` };
  }
  return { text: stored, source: "stored", whole: true, label: `whole log, stored (${thousands(e.log.bytes)} bytes, ${sha})` };
}

// ── the failure lines ───────────────────────────────────────────────────────

// The lines that name a failure, by the formats failingTests reads: a
// failing test's own line (node:test's `✖`, TAP's `not ok`, vitest's ` FAIL `
// and `×`, jest's `●`, pytest's `FAILED`/`ERROR`, go's `--- FAIL:`), with
// the assertion or error line that follows it, and the summary counts that
// say how many failed (`ℹ fail N`, TAP's `# fail N`, vitest's `Test Files …
// failed` and `Tests … failed`). Read from the whole output, in its order,
// each line once, within FAILURE_LINES_MAX lines and FAILURE_LINES_CHARS
// characters; a last `[atelier]` line counts the lines left out.
const FAILED_TEST = /^\s*(?:not ok \d+|✖ |FAIL {1,2}\S|× |● |FAILED \S|ERROR \S+::|--- FAIL: )/;
const FAIL_COUNT = /^\s*(?:ℹ fail [1-9]\d*\b|# fail [1-9]\d*\b|Test Files\b.*\b\d+ failed\b|Tests\b.*\b\d+ failed\b|Tests: .*\b\d+ failed\b)/;
const ASSERTION = /\b(?:AssertionError|[A-Z]\w*Error)\b|^\s*(?:error|expected|actual|Expected|Received):/;
const SKIPPED = /^\s*not ok \d+.*# (?:SKIP|TODO)\b/i;

// t176: progress and captured stdout can contain whole failing fixtures.
// Prefer the last completed outer report. A transcript cannot authenticate
// an unframed fixture that copies that final report; uncertain counts name none.
function outerReports(lines: string[]): { lines: string[]; reporters: string[]; uncertain: boolean } | null {
  const last = (pattern: RegExp) => lines.findLastIndex((line) => pattern.test(line));
  const nodeCount = last(/^ℹ fail \d+\s*$/);
  const viteCount = last(/^\s{2,}Tests\s{2,}.*\d+ (?:failed|passed|skipped)/);
  const viteRun = last(/^ RUN  /);
  const nodeSeen = nodeCount >= 0 || lines.some((line) => /^✖ failing tests:|^ℹ tests \d+|^[✔✖] .+ \(\d/.test(line));
  const viteSeen = viteCount >= 0 || lines.some((line) => /^ RUN  |^ Test Files |^ FAIL {2}|^ ❯ \S+ \(\d+ tests?/.test(line));
  if (!nodeSeen && !viteSeen) return null;
  const selected: string[] = [], reporters: string[] = [];
  let uncertain = false;
  // A Node summary printed inside a later-running Vitest suite is fixture output.
  if (nodeSeen && !(viteRun >= 0 && viteRun < nodeCount && nodeCount < viteCount)) {
    reporters.push("node:test");
    const count = nodeCount < 0 ? NaN : Number(lines[nodeCount].match(/\d+/)![0]);
    const marker = last(/^✖ failing tests:\s*$/);
    const end = viteRun > nodeCount ? viteRun : lines.length;
    const diagnostics = marker > nodeCount && marker < end ? lines.slice(marker + 1, end) : [];
    const named = diagnostics.filter((line) => /^✖ .+ \(\d[\d.]*m?s\)\s*$/.test(line));
    const cancelled = lines.slice(nodeCount + 1, marker > nodeCount ? marker : end).some((line) => /^ℹ cancelled [1-9]/.test(line));
    if (count === 0 && !cancelled) selected.push(lines[nodeCount]);
    else if (count > 0 && named.length === count && !cancelled) selected.push(lines[nodeCount], "✖ failing tests:", ...diagnostics);
    else uncertain = true;
  }
  // The final Node summary supersedes a Vitest fixture printed by a Node test.
  if (viteSeen && !(nodeCount > viteCount && viteRun < nodeCount)) {
    reporters.push("vitest");
    const count = viteCount < 0 ? NaN : Number(lines[viteCount].match(/(\d+) failed/)?.[1] ?? 0);
    const marker = last(/^[⎯─-]+ Failed Tests \d+ [⎯─-]+\s*$/);
    const diagnostics = marker >= 0 && marker < viteCount && marker > viteRun ? lines.slice(marker + 1, viteCount) : [];
    const named = diagnostics.filter((line) => /^ FAIL {2}(?:\|[^|]+\| )?\S+ > .+/.test(line));
    const declared = marker < 0 ? NaN : Number(lines[marker].match(/Failed Tests (\d+)/)![1]);
    if (count === 0) selected.push(lines[viteCount]);
    else if (count > 0 && named.length === count && declared === count) selected.push(lines[marker], ...diagnostics, lines[viteCount]);
    else uncertain = true;
  }
  return { lines: selected, reporters, uncertain };
}

export function collectFailureLines(output: string): string {
  const raw = plainLines(output);
  const outer = outerReports(raw);
  const all = (outer?.lines ?? raw).map((line) => line.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").trimEnd());
  const picked: string[] = [];
  const seen = new Set<string>();
  const take = (line: string) => {
    const kept = line.length > FAILURE_LINE_CHARS ? `${line.slice(0, FAILURE_LINE_CHARS - 1)}…` : line;
    if (!seen.has(kept)) { seen.add(kept); picked.push(kept); }
  };
  for (let i = 0; i < all.length; i++) {
    const line = all[i];
    if (/^✖ failing tests:|^[⎯─-]+ Failed Tests /.test(line)) { take(line); continue; }
    if (FAIL_COUNT.test(line)) { take(line); continue; }
    if (!FAILED_TEST.test(line) || SKIPPED.test(line)) continue;
    take(line);
    // The assertion that follows a failing test's line: its first error
    // line within the next few, before the next test's line.
    for (let j = i + 1; j < Math.min(all.length, i + 8); j++) {
      if (FAILED_TEST.test(all[j]) || FAIL_COUNT.test(all[j])) break;
      if (ASSERTION.test(all[j])) { take(all[j]); break; }
    }
  }
  if (picked.length <= FAILURE_LINES_MAX && picked.join("\n").length <= FAILURE_LINES_CHARS) return picked.join("\n");
  // Too many: the first ones, leaving room for the line that counts the rest.
  const kept: string[] = [];
  let size = 0;
  for (const line of picked) {
    if (kept.length >= FAILURE_LINES_MAX - 1 || size + line.length + 1 > FAILURE_LINES_CHARS - 80) break;
    kept.push(line);
    size += line.length + 1;
  }
  const left = picked.length - kept.length;
  if (left) kept.push(`[atelier] and ${count(left, "more failure line")} not kept`);
  return kept.join("\n");
}

// ── the failing tests ───────────────────────────────────────────────────────

export interface FailingTests {
  reporters: string[];   // the formats recognised in the output, in the order above
  names: string[];       // the failing tests they name, in the output's order, each once
  note: string | null;   // what a format that names no test says the output holds (a typecheck's errors); null otherwise
}

interface Reporter {
  name: string;
  recognised: RegExp;                         // the output is this reporter's
  names: (lines: string[]) => string[];
  note?: (lines: string[]) => string | null;  // what the output holds when it names no test
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const matching = (lines: string[], re: RegExp, pick: (m: RegExpMatchArray) => string | null) =>
  lines.flatMap((line) => { const m = re.exec(line); const v = m ? pick(m) : null; return v ? [v.trim()] : []; });

const NODE_FAIL = /^\s*✖ (.+?) \(\d[\d.]*m?s\)\s*$/;
const REPORTERS: Reporter[] = [
  {
    name: "node:test",
    recognised: /^\s*[✔✖] .+ \(\d[\d.]*m?s\)\s*$|^ℹ (?:tests|pass|fail) \d+/m,
    names: (lines) => {
      const summary = lines.findIndex((line) => /^✖ failing tests:\s*$/.test(line));
      return matching(summary >= 0 ? lines.slice(summary + 1) : lines, NODE_FAIL, (m) => m[1]);
    },
  },
  {
    name: "tap",
    recognised: /^\s*(?:not ok|ok) \d+/m,
    names: (lines) => matching(lines, /^\s*not ok \d+(?: - | )?(.*?)\s*$/, (m) => /# (?:SKIP|TODO)\b/i.test(m[1]) ? null : m[1].replace(/\s*#.*$/, "")),
  },
  {
    name: "vitest",
    recognised: /^ (?:FAIL|❯) {1,2}\S.* > |^ ❯ \S+ \(\d+ tests?\b|^ {4,}Tests {2}\d|^ Test Files {2}\d/m,
    names: (lines) => {
      const failed = matching(lines, /^ FAIL {2}(?:\|[^|]+\| )?(\S+ > .+?)\s*$/, (m) => m[1]);
      return failed.length ? failed : matching(lines, /^\s*× (.+?)(?: \d+m?s)?\s*$/, (m) => m[1]);
    },
  },
  {
    name: "jest",
    recognised: /^Tests: {7}\d|^(?:PASS|FAIL) \S+\.(?:test|spec)\.[cm]?[jt]sx?\b/m,
    names: (lines) => {
      const bullets = matching(lines, /^\s*● (.+?)\s*$/, (m) => /^(?:Test suite failed to run|Console)$/.test(m[1]) ? null : m[1]);
      return bullets.length ? bullets : matching(lines, /^\s*✕ (.+?) \(\d+ m?s\)\s*$/, (m) => m[1]);
    },
  },
  {
    name: "pytest",
    recognised: /^=+ .*(?:passed|failed|errors?|no tests ran).* =+$|^=+ short test summary info =+$/m,
    names: (lines) => matching(lines, /^(?:FAILED|ERROR) (\S+::\S+)/, (m) => m[1]),
  },
  {
    name: "go test",
    recognised: /^\s*--- (?:FAIL|PASS): \S+|^(?:ok|FAIL)\s+\S+\s+[\d.]+s$/m,
    names: (lines) => matching(lines, /^\s*--- FAIL: (\S+)/, (m) => m[1]),
  },
  {
    name: "cargo test",
    recognised: /^test result: (?:ok|FAILED)\. \d+ passed/m,
    names: (lines) => matching(lines, /^test (\S+) \.\.\. FAILED$/, (m) => m[1]),
  },
  {
    name: "xctest",
    recognised: /^Test Case '.+' (?:passed|failed|started)|^\s*[✔✘] Test .+ (?:passed|failed) after/m,
    names: (lines) => [
      ...matching(lines, /^Test Case '-\[(\S+) (\w+)\]' failed/, (m) => `${m[1]}.${m[2]}`),
      ...matching(lines, /^Test Case '([^'\]]+)' failed/, (m) => m[1]),
      ...matching(lines, /^\s*✘ Test (?:"([^"]+)"|(\S+\(\))) (?:failed|recorded)/, (m) => m[1] ?? m[2]),
    ],
  },
  {
    name: "tsc",
    recognised: /\berror TS\d{4,5}:/,
    names: () => [],
    note: (lines) => `the output holds ${count(lines.filter((line) => /\berror TS\d{4,5}:/.test(line)).length, "TypeScript error")}, which name no test`,
  },
];

// Terminal control sequences dropped, so a reporter's colour codes never
// hide a name or pose as one.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;
export const plainLines = (text: string): string[] => text.replace(ANSI, "").split(/\r?\n/);

// The failing tests the output names, or null when no reporter format is
// recognised in it. Several formats may be read from one output, since one
// check can run more than one suite (this project's `npm test` runs
// node:test and then vitest).
export function failingTests(output: string): FailingTests | null {
  const raw = plainLines(output);
  const outer = outerReports(raw);
  const lines = outer?.lines ?? raw;
  const reporters: string[] = outer?.reporters.slice() ?? [], names: string[] = [], notes: string[] = [];
  for (const r of REPORTERS) {
    if (!r.recognised.test(lines.join("\n"))) continue;
    if (!reporters.includes(r.name)) reporters.push(r.name);
    const found = r.names(lines);
    for (const name of found) if (!names.includes(name)) names.push(name);
    if (!found.length && r.note) { const n = r.note(lines); if (n) notes.push(n); }
  }
  if (!reporters.length) return null;
  return { reporters, names, note: outer?.uncertain ? "outer reporter diagnostics are incomplete or inconsistent; failing-test names unavailable" : names.length || !notes.length ? null : notes.join("; ") };
}

// What the summary says of the failing tests, in one line. `whole` says
// whether the log the names were read from is the check's whole output: a
// tail may have lost the lines naming the tests, and the line says so
// instead of concluding that the check failed for another reason. At most
// `names` names are listed; the rest are counted.
export function failingTestsLine(tests: FailingTests | null, whole = true, names = SUMMARY_TEST_NAMES, fromLines = false): string {
  if (!tests) {
    return whole
      ? "failing tests: names unavailable (no test reporter format this summary reads was recognised in the output)"
      : "failing tests: names unavailable (no test reporter format this summary reads was recognised in the tail of the output that was kept; the lines naming them may have been cut with the rest)";
  }
  if (!tests.names.length) {
    if (tests.note) return `failing tests: none named${whole || !tests.note.includes("unavailable") ? "" : " in the tail of the output that was kept"} (${tests.note})`;
    const reporters = tests.reporters.join(" and ");
    return whole
      ? `failing tests: none named (the ${reporters} output names no failing test, so the check failed for another reason)`
      : `failing tests: none named in the tail of the output that was kept (the ${reporters} output in it names no failing test; the lines naming them may have been cut with the rest, or the check failed for another reason)`;
  }
  const shown = tests.names.slice(0, Math.max(1, names));
  const more = tests.names.length - shown.length;
  const from = whole ? "" : fromLines ? ", read from the failure lines kept from the whole output and from its tail" : ", read from a tail of the output, so names cut with the rest are not listed";
  return `failing tests (${tests.reporters.join(", ")}${from}): ${shown.map(flatLine).join("; ")}${more ? `; and ${more} more` : ""}`;
}

// ── the summary ─────────────────────────────────────────────────────────────

export interface ResolvedFailure extends CheckFailure {
  logRead: CheckLog;
  tests: FailingTests | null;
}

export async function resolveFailures(failures: CheckFailure[], read: LogReader): Promise<ResolvedFailure[]> {
  const out: ResolvedFailure[] = [];
  for (const f of failures) {
    const logRead = await readCheckLog({ outputTail: f.outputTail, log: f.log ?? undefined, where: f.where, failureLines: f.failureLines }, read);
    // The failure lines read from the whole output come first: they name
    // the tests a tail of the output may have lost.
    out.push({ ...f, logRead, tests: failingTests(logRead.failureLines ? logRead.failureLines.join("\n") : logRead.text) });
  }
  return out;
}

// A line of a log or a name as the summary prints it: control characters
// dropped, so no line of a check's output can pose as a line of the summary.
export const flatLine = (s: string): string => s.replace(ANSI, "").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").trim();

// The last SUMMARY_TAIL_LINES lines of a log, within SUMMARY_TAIL_CHARS
// characters, each line flattened, with how many lines the log holds. A
// line longer than `chars` is kept as its last `chars` characters behind a
// `…`, and only ever alone (it fills the budget): `cut` is that line's
// whole length, so the caller can say the line was cut rather than report
// it whole; 0 when every retained line is whole.
export interface BoundedTail {
  lines: string[];
  total: number;
  cut: number;
}

export function boundedTail(text: string, lines = SUMMARY_TAIL_LINES, chars = SUMMARY_TAIL_CHARS): BoundedTail {
  const all = plainLines(text).map(flatLine).filter((line) => line.length);
  const kept: string[] = [];
  let size = 0;
  let cut = 0;
  for (const line of all.slice(-lines).reverse()) {
    const shown = line.length > chars ? `…${line.slice(-(chars - 1))}` : line;
    if (size + shown.length > chars && kept.length) break;
    kept.unshift(shown);
    size += shown.length;
    if (shown.length < line.length) cut = line.length;
  }
  return { lines: kept, total: all.length, cut };
}

export const WHERE_TEXT: Record<Where, string> = { sandbox: "in a Cloudflare container", runner: "on a runner, in a clean clone" };
const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 8) : "—");
const when = (at: string) => `${at.slice(0, 16).replace("T", " ")} UTC`;

// What one failed check's block may be fitted to: how many test names it
// lists and how many of its bounded tail's lines it shows (the last ones).
export interface FailureFit {
  names?: number;
  tailLines?: number;
  failLines?: number;   // how many of the failure lines kept beside the tail it shows (the first ones)
}

const summaryFailureLines = (f: ResolvedFailure): string[] => (f.logRead.failureLines ?? []).slice(0, SUMMARY_FAILURE_LINES).map(flatLine).filter((line) => line.length);

// One failed check's lines of the summary, as every caller prints them.
export function failureLines(f: ResolvedFailure, fit: FailureFit = {}): string[] {
  const ident = [f.id !== null ? `evidence #${f.id}` : "evidence row without an id", ...(f.run ? [`run ${flatLine(f.run)}`] : []), `attempt ${f.attempt} of ${f.attempts} at this head`].join(", ");
  const on = f.merged ? ` on the merge with main at ${short(f.mainHead)}` : "";
  const tail = boundedTail(f.logRead.text);
  const lines = fit.tailLines === undefined ? tail.lines : fit.tailLines > 0 ? tail.lines.slice(-fit.tailLines) : [];
  const fitted = lines.length < tail.lines.length;
  // A retained line cut to the summary's size is said so, with its length:
  // the log is not whole in the summary, however few lines it holds.
  const cut = tail.cut && lines.length ? `, cut to its last ${thousands(lines[lines.length - 1].length - 1)} of ${thousands(tail.cut)} characters` : "";
  const shown = !tail.total ? "no output"
    : !lines.length ? `${count(tail.total, "line")}, left out of this summary for its size`
    : lines.length < tail.total ? `last ${lines.length} of ${thousands(tail.total)} lines${fitted ? " (fewer, for this summary's size)" : ""}${cut}`
    : tail.cut ? `${count(tail.total, "line")}${cut}`
    : `${count(tail.total, "line")}, whole`;
  const failing = summaryFailureLines(f);
  const fails = fit.failLines === undefined ? failing : failing.slice(0, Math.max(0, fit.failLines));
  const all = f.logRead.failureLines?.length ?? 0;
  return [
    `\`${flatLine(f.claim)}\` failed${on} ${WHERE_TEXT[f.where]} at ${when(f.at)}${f.load !== null ? `, load ${f.load}` : ""}: ${ident}`,
    `  ${failingTestsLine(f.tests, f.logRead.whole, fit.names, all > 0)}`,
    ...(all ? [`  failure lines, read from the whole output: ${fails.length < all ? `first ${fails.length} of ${all}` : `${count(all, "line")}`}${fails.length ? ":" : ""}`, ...fails.map((line) => `    ${line}`)] : []),
    `  log: ${f.logRead.label}; ${shown}${lines.length ? ":" : ""}`,
    ...lines.map((line) => `    ${line}`),
  ];
}

// The line every summary ends with: the command that prints the whole logs.
export const checkLogPointer = (id: string): string => `  Whole logs of every attempt at this head: atelier check-log ${id}`;

// The summary as the landing Workflow records it: `why`, the line naming the
// failed checks, then the summary fitted to what remains of `max`. A `why`
// so long that the summary would have less room than its check-log line
// (the bare `…` and the line) is cut first, so the record, held at `max`,
// still ends with the command that prints the whole logs.
export function failureDetail(why: string, id: string, head: string, failures: ResolvedFailure[], max: number): string {
  const floor = checkLogPointer(id).length + 2;
  const line = why.length + 1 + floor > max ? `${why.slice(0, Math.max(0, max - floor - 2))}…` : why;
  return `${line}\n${failureSummary(id, head, failures, max - line.length - 1)}`;
}

// The failure summary of a task at a head, as `atelier show`, the plain
// landing and the landing Workflow all print it: the gate's reading, one
// block per failed check, and the command that prints the whole logs.
// Given `maxChars`, the summary is fitted to it (see the head of this file):
// the tails give way first, then the names, then the later checks, which
// one line then counts and names; the heading, every check kept and the
// check-log line remain.
export function failureSummary(id: string, head: string, failures: ResolvedFailure[], maxChars = Infinity): string {
  if (!failures.length) return `No required check fails at ${short(head)} as the gate reads it.`;
  const heading = `Failed checks at ${short(head)}, as the gate reads them (the latest counting run of each required check at this head):`;
  const pointer = checkLogPointer(id);
  const tails = failures.map((f) => boundedTail(f.logRead.text).lines.length);
  const fails = failures.map((f) => summaryFailureLines(f).length);
  const text = (kept: number, names: number, shown: number[], failShown: number[] = fails): string => {
    const left = failures.slice(kept);
    return [
      heading,
      ...failures.slice(0, kept).flatMap((f, i) => failureLines(f, { names, tailLines: shown[i], failLines: failShown[i] }).map((line) => `  ${line}`)),
      ...(left.length ? [`  And ${count(left.length, "more failed check")}, left out of this summary for its size: ${left.map((f) => `\`${flatLine(f.claim)}\``).join(", ")}`] : []),
      pointer,
    ].join("\n");
  };
  const full = text(failures.length, SUMMARY_TEST_NAMES, tails);
  if (full.length <= maxChars) return full;
  for (let kept = failures.length; kept >= 1; kept--) {
    for (const names of [SUMMARY_TEST_NAMES, 10, 5, 2, 1]) {
      const shown = failures.map(() => 0), failShown = failures.map(() => 0);
      if (text(kept, names, shown, failShown).length > maxChars) continue;
      // The bare blocks fit: the failure lines read from the whole output
      // are given back first, the first ones one at a time, each check in
      // turn, then the tails' last lines, while the whole still fits.
      for (const [given, most] of [[failShown, fails], [shown, tails]] as [number[], number[]][]) {
        const done = new Set<number>();
        while (done.size < kept) {
          for (let i = 0; i < kept; i++) {
            if (done.has(i)) continue;
            if (given[i] >= most[i]) { done.add(i); continue; }
            given[i]++;
            if (text(kept, names, shown, failShown).length > maxChars) { given[i]--; done.add(i); }
          }
        }
      }
      return text(kept, names, shown, failShown);
    }
  }
  // Not even one check's bare block fits: the first check, cut at the size,
  // and the check-log line kept whole.
  const bare = text(1, 1, failures.map(() => 0), failures.map(() => 0));
  return `${bare.slice(0, Math.max(0, maxChars - pointer.length - 2))}…\n${pointer}`;
}

// One failed check as `atelier show --json` carries it: the same facts the
// summary prints, with the bounded tail as lines.
export function failureJson(f: ResolvedFailure) {
  const tail = boundedTail(f.logRead.text);
  return {
    claim: f.claim, head: f.head, id: f.id, run: f.run, at: f.at, by: f.by, where: f.where,
    merged: f.merged, mainHead: f.mainHead, load: f.load, attempt: f.attempt, attempts: f.attempts,
    log: { source: f.logRead.source, whole: f.logRead.whole, label: f.logRead.label, sha256: f.log?.sha256 ?? null, bytes: f.log?.bytes ?? null },
    failingTests: f.tests,
    ...(f.logRead.failureLines ? { failureLines: f.logRead.failureLines } : {}),
    tail: tail.lines, lines: tail.total, cut: tail.cut,
  };
}

// ── every attempt at a head, for atelier check-log ──────────────────────────

export interface CheckAttempt {
  claim: string;
  attempt: number;         // which run of the check at the head, counting from 1 (attemptNumbers), as show numbers it
  attempts: number;
  outcome: "passed" | "failed" | "not applicable";
  merged: boolean;
  mainHead: string | null;
  where: Where;
  at: string;
  by: string;
  id: number | null;
  run: string | null;
  load: number | null;
  evidence: Evidence;
}

// Every observed check at the head, in the order they were recorded, each
// numbered by attemptNumbers, as `show` and the landings number it: the
// retained logs `atelier check-log` prints. Reports are not checks and are
// left out.
export function checkAttemptsAt(evidence: Evidence[], head: string | null): CheckAttempt[] {
  if (!head) return [];
  const numbers = attemptNumbers(evidence, head);
  return observedAt(evidence, head).map((e) => {
    const { attempt, attempts } = numbers.get(e)!;
    return {
      claim: e.claim, attempt, attempts,
      outcome: e.notApplicable ? "not applicable" : e.passed ? "passed" : "failed",
      merged: e.merged === true, mainHead: e.mainHead ?? null,
      where: e.where === "sandbox" ? "sandbox" : "runner", at: e.at, by: e.by,
      id: typeof e.id === "number" ? e.id : null, run: typeof e.run === "string" && e.run ? e.run : null,
      load: typeof e.load === "number" ? e.load : null, evidence: e,
    };
  });
}

// The heads that hold observed checks, newest first, with how many: what
// `atelier check-log` offers when the head asked for holds none.
export function headsWithChecks(evidence: Evidence[]): { head: string; runs: number; last: string }[] {
  const byHead = new Map<string, { head: string; runs: number; last: string }>();
  for (const e of evidence) {
    if (e.grade !== "observed") continue;
    const row = byHead.get(e.head) ?? { head: e.head, runs: 0, last: e.at };
    row.runs++;
    if (e.at > row.last) row.last = e.at;
    byHead.set(e.head, row);
  }
  return [...byHead.values()].sort((a, b) => b.last.localeCompare(a.last));
}

// The header of one attempt as check-log prints it.
export function attemptHeader(a: CheckAttempt): string {
  const ident = [a.id !== null ? `evidence #${a.id}` : null, a.run ? `run ${flatLine(a.run)}` : null].filter(Boolean).join(", ");
  return `── \`${flatLine(a.claim)}\` · attempt ${a.attempt} of ${a.attempts} · ${a.outcome}${a.merged ? ` on the merge with main at ${short(a.mainHead)}` : ""} · ${WHERE_TEXT[a.where]} · ${when(a.at)}${a.load !== null ? ` · load ${a.load}` : ""}${ident ? ` · ${ident}` : ""}`;
}
