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
// head that counts (never a report, never a merged run, and under
// sandboxOnly never a run on someone's machine); and each failing merged run
// that blocks acceptance. A check whose latest run passes is not a failure,
// however many earlier runs failed; one at another head is not read at all.
//
// Which log: a run made in a Cloudflare container keeps its whole output in
// R2 by reference (src/large.ts) when the output outgrew the tail held
// inline, and readCheckLog reads that reference when the run has one; else
// the inline tail. Every log is labelled as what it is: the whole output, an
// inline tail only (a run on someone's machine keeps its last
// LOCAL_OUTPUT_TAIL characters; a container's the last SANDBOX_OUTPUT_TAIL),
// a stored log cut to its last LARGE_MAX characters, or unavailable, when the
// stored log can no longer be read and the inline tail stands in for it.
//
// Which tests: failingTests reads the names of the failing tests from the
// reporter formats below, and from no other. Output no format fits, or that
// fits a format naming no failing test (a suite that could not start, a
// typecheck), says the names are unavailable; no name is ever derived from
// the shape of a line a reporter did not write. The formats, each fixed by
// a fixture:
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
// lines the log holds when more were cut. `atelier check-log ID` prints the
// retained logs whole, for every attempt at the head.

import { LARGE_MAX, type LargeRef } from "./large.ts";
import { blockingMergedRuns, countingRunsAt, evidenceAt, mergedRunsAt, type Evidence, type ProjectPolicy } from "./rules.ts";

// What a check run on someone's machine keeps of its output inline:
// `atelier check` posts the output's last LOCAL_OUTPUT_TAIL characters and a
// sha256 of the whole (cli/atelier.mjs). The container runner keeps the
// last SANDBOX_OUTPUT_TAIL inline and the whole log in R2 beside it when the
// output was longer (src/sandbox/runner.ts).
export const LOCAL_OUTPUT_TAIL = 3500;
export const SANDBOX_OUTPUT_TAIL = 4000;

// The bound on the log tail the failure summary shows, per failed check.
export const SUMMARY_TAIL_LINES = 20;
export const SUMMARY_TAIL_CHARS = 2000;
// How many failing test names the summary lists before it counts the rest.
export const SUMMARY_TEST_NAMES = 20;

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
  attempt: number;         // which run of the check at this head this is, counting from 1
  attempts: number;        // how many runs of the check the head holds, this one included
  outputTail: string;
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
  log: e.log ?? null,
});

// The failed checks at the head, as the gate reads them (see the head of
// this file): the head's own failures first, in the policy's order, then
// the merged runs that block.
export function effectiveFailures(policy: ProjectPolicy, evidence: Evidence[], head: string | null): CheckFailure[] {
  if (!head) return [];
  const out: CheckFailure[] = [];
  for (const c of evidenceAt(policy, evidence, head).checks) {
    if (c.grade !== "observed" || c.passed) continue;
    const runs = countingRunsAt(policy, evidence, head, c.claim);
    out.push(failureOf(runs.at(-1)!, runs.length, runs.length));
  }
  for (const { run } of blockingMergedRuns(policy, evidence, head)) {
    const runs = mergedRunsAt(policy, evidence, head, run.claim);
    out.push(failureOf(run, runs.length, runs.length));
  }
  return out;
}

// ── the log ─────────────────────────────────────────────────────────────────

export type LogReader = (ref: LargeRef) => Promise<string | null>;

export interface CheckLog {
  text: string;                  // the log as read: the stored whole, else the inline tail
  source: "stored" | "inline";
  whole: boolean;                // whether `text` is the check's whole output
  label: string;                 // what `text` is, in words: whole, a tail only, cut, or unavailable
}

// The lines the recorders append after the output itself: the sha256 line
// `atelier check` posts and the `[atelier] …` lines the container adds.
const RECORDER_LINE = /^\[(?:atelier\]|sha256 of full output:)/;
const outputBody = (tail: string): string => tail.split("\n").filter((line) => !RECORDER_LINE.test(line)).join("\n");

const thousands = (n: number) => n.toLocaleString("en-US");

// The log of one run: the stored whole log when the run names one and it
// can be read, else the inline tail, each labelled as what it is. A reader
// that throws, or answers nothing, leaves the stored log unavailable.
export async function readCheckLog(e: Pick<Evidence, "outputTail" | "log" | "where">, read: LogReader): Promise<CheckLog> {
  const tail = String(e.outputTail ?? "");
  const kept = e.where === "sandbox" ? SANDBOX_OUTPUT_TAIL : LOCAL_OUTPUT_TAIL;
  const runOn = e.where === "sandbox" ? "a container" : "a check run on a machine";
  const inlineCut = outputBody(tail).length >= kept;
  const inline = (why: string | null): CheckLog => inlineCut
    ? { text: tail, source: "inline", whole: false, label: `${why ? `${why}; ` : ""}inline tail only (${runOn} keeps its last ${thousands(kept)} characters inline, and this output was longer)` }
    : { text: tail, source: "inline", whole: true, label: `${why ? `${why}; ` : ""}whole output, inline` };
  if (!e.log) return inline(null);
  const sha = e.log.sha256.slice(0, 12);
  let stored: string | null = null, failure: string | null = null;
  try { stored = await read(e.log); } catch (error) { failure = String((error as Error)?.message ?? error).split("\n")[0].slice(0, 200); }
  if (stored === null) return inline(`unavailable: the stored log ${sha} could not be read${failure ? ` (${failure})` : ""}`);
  if (e.log.bytes >= LARGE_MAX || stored.length >= LARGE_MAX) {
    return { text: stored, source: "stored", whole: false, label: `stored log ${sha}, cut to its last ${thousands(LARGE_MAX)} characters (${thousands(e.log.bytes)} bytes)` };
  }
  return { text: stored, source: "stored", whole: true, label: `whole log, stored (${thousands(e.log.bytes)} bytes, ${sha})` };
}

// ── the failing tests ───────────────────────────────────────────────────────

export interface FailingTests {
  reporters: string[];   // the formats recognised in the output, in the order above
  names: string[];       // the failing tests they name, in the output's order, each once
  note: string | null;   // why a recognised format names none, when it does not
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
  const lines = plainLines(output);
  const reporters: string[] = [], names: string[] = [], notes: string[] = [];
  for (const r of REPORTERS) {
    if (!r.recognised.test(lines.join("\n"))) continue;
    reporters.push(r.name);
    const found = r.names(lines);
    for (const name of found) if (!names.includes(name)) names.push(name);
    if (!found.length && r.note) { const n = r.note(lines); if (n) notes.push(n); }
  }
  if (!reporters.length) return null;
  return { reporters, names, note: names.length ? null : notes.length ? notes.join("; ") : `the ${reporters.join(" and ")} output names no failing test, so the check failed for another reason` };
}

// What the summary says of the failing tests, in one line.
export function failingTestsLine(tests: FailingTests | null): string {
  if (!tests) return "failing tests: names unavailable (no test reporter format this summary reads was recognised in the output)";
  if (!tests.names.length) return `failing tests: none named (${tests.note})`;
  const shown = tests.names.slice(0, SUMMARY_TEST_NAMES);
  const more = tests.names.length - shown.length;
  return `failing tests (${tests.reporters.join(", ")}): ${shown.map(flatLine).join("; ")}${more ? `; and ${more} more` : ""}`;
}

// ── the summary ─────────────────────────────────────────────────────────────

export interface ResolvedFailure extends CheckFailure {
  logRead: CheckLog;
  tests: FailingTests | null;
}

export async function resolveFailures(failures: CheckFailure[], read: LogReader): Promise<ResolvedFailure[]> {
  const out: ResolvedFailure[] = [];
  for (const f of failures) {
    const logRead = await readCheckLog({ outputTail: f.outputTail, log: f.log ?? undefined, where: f.where }, read);
    out.push({ ...f, logRead, tests: failingTests(logRead.text) });
  }
  return out;
}

// A line of a log or a name as the summary prints it: control characters
// dropped, so no line of a check's output can pose as a line of the summary.
export const flatLine = (s: string): string => s.replace(ANSI, "").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").trim();

// The last SUMMARY_TAIL_LINES lines of a log, within SUMMARY_TAIL_CHARS
// characters, each line flattened, with how many lines the log holds.
export function boundedTail(text: string, lines = SUMMARY_TAIL_LINES, chars = SUMMARY_TAIL_CHARS): { lines: string[]; total: number } {
  const all = plainLines(text).map(flatLine).filter((line) => line.length);
  const kept: string[] = [];
  let size = 0;
  for (const line of all.slice(-lines).reverse()) {
    const cut = line.length > chars ? `…${line.slice(-(chars - 1))}` : line;
    if (size + cut.length > chars && kept.length) break;
    kept.unshift(cut);
    size += cut.length;
  }
  return { lines: kept, total: all.length };
}

export const WHERE_TEXT: Record<Where, string> = { sandbox: "in a Cloudflare container", runner: "on a runner, in a clean clone" };
const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 8) : "—");
const when = (at: string) => `${at.slice(0, 16).replace("T", " ")} UTC`;

// One failed check's lines of the summary, as every caller prints them.
export function failureLines(f: ResolvedFailure): string[] {
  const ident = [f.id !== null ? `evidence #${f.id}` : "evidence row without an id", ...(f.run ? [`run ${flatLine(f.run)}`] : []), `attempt ${f.attempt} of ${f.attempts} at this head`].join(", ");
  const on = f.merged ? ` on the merge with main at ${short(f.mainHead)}` : "";
  const tail = boundedTail(f.logRead.text);
  const shown = tail.lines.length < tail.total ? `last ${tail.lines.length} of ${thousands(tail.total)} lines` : tail.total ? `${count(tail.total, "line")}, whole` : "no output";
  return [
    `\`${flatLine(f.claim)}\` failed${on} ${WHERE_TEXT[f.where]} at ${when(f.at)}${f.load !== null ? `, load ${f.load}` : ""}: ${ident}`,
    `  ${failingTestsLine(f.tests)}`,
    `  log: ${f.logRead.label}; ${shown}${tail.lines.length ? ":" : ""}`,
    ...tail.lines.map((line) => `    ${line}`),
  ];
}

// The failure summary of a task at a head, as `atelier show`, the plain
// landing and the landing Workflow all print it: the gate's reading, one
// block per failed check, and the command that prints the whole logs.
export function failureSummary(id: string, head: string, failures: ResolvedFailure[]): string {
  if (!failures.length) return `No required check fails at ${short(head)} as the gate reads it.`;
  const lines = [`Failed checks at ${short(head)}, as the gate reads them (the latest counting run of each required check at this head):`];
  for (const f of failures) lines.push(...failureLines(f).map((line) => `  ${line}`));
  lines.push(`  Whole logs of every attempt at this head: atelier check-log ${id}`);
  return lines.join("\n");
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
    tail: tail.lines, lines: tail.total,
  };
}

// ── every attempt at a head, for atelier check-log ──────────────────────────

export interface CheckAttempt {
  claim: string;
  attempt: number;         // which run of the check at the head, counting from 1, merged runs in the same count
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
// numbered among the runs of its command: the retained logs `atelier
// check-log` prints. Reports are not checks and are left out.
export function checkAttemptsAt(evidence: Evidence[], head: string | null): CheckAttempt[] {
  if (!head) return [];
  const rows = evidence.filter((e) => e.head === head && e.grade === "observed").sort((a, b) => a.at.localeCompare(b.at) || ((a.id ?? 0) - (b.id ?? 0)));
  const seen = new Map<string, number>();
  const totals = new Map<string, number>();
  for (const e of rows) totals.set(e.claim, (totals.get(e.claim) ?? 0) + 1);
  return rows.map((e) => {
    const attempt = (seen.get(e.claim) ?? 0) + 1;
    seen.set(e.claim, attempt);
    return {
      claim: e.claim, attempt, attempts: totals.get(e.claim) ?? 1,
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
