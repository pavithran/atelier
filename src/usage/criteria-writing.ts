// How well the criteria were written (t536): what the findings of the last 7
// days say about the criteria themselves, per project and overall, computed
// from the events the ledger already records and from nothing else. A
// blocking finding carries the criterion it concerns and a cause (src/review/
// verdict.ts); `atelier finding --cause` corrects a cause and a failed
// required check records its failing test names, with a cause the
// orchestrator sets. `atelier flow --bars` prints this beside the bars.
//
// A finding recorded before causes were asked for, or whose reply gave none,
// has cause unknown. It is counted, and left out of every share.
import { FINDING_CAUSES, type FindingCause } from "./finding-causes.ts";

export interface WritingEvent { seq: number; at: string; itemId?: string | null; kind: string; data?: Record<string, unknown> | null }

export const WRITING_WINDOW_DAYS = 7;
const DAY_MS = 86_400_000;
const CAUSES: readonly FindingCause[] = [...FINDING_CAUSES, "unknown"];

export type CauseCounts = Record<FindingCause, number>;
const noCauses = (): CauseCounts => Object.fromEntries(CAUSES.map((c) => [c, 0])) as CauseCounts;

export interface CriteriaWriting {
  scope: string;
  findings: number;
  // Findings by their cause as it stands, a correction in place of the reviewer's.
  byCause: CauseCounts;
  // Findings whose cause is known: the base of every share.
  known: number;
  specShare: number | null;
  // Criteria that drew two or more blocking findings in the window.
  multiFindingCriteria: { task: string; criterion: number; findings: number }[];
  // Blocking findings that repeat an earlier blocking finding of the same task.
  repeats: number;
  // Tasks whose first criteria review came in the window, and how many of them were approved.
  firstCriteriaReview: { tasks: number; approved: number; share: number | null };
  // Required checks that failed at landing or on main, each with its failing test names.
  checkFailures: { total: number; byCause: CauseCounts };
  sources: { byCause: string; specShare: string; multiFindingCriteria: string; repeats: string; firstCriteriaReview: string; checkFailures: string };
}
export interface CriteriaWritingReport { windowDays: number; since: string; observedAt: string; scopes: CriteriaWriting[] }

const SOURCES: CriteriaWriting["sources"] = {
  byCause: "review.rejected events' blocking findings, with review.finding_cause corrections (atelier finding --cause)",
  specShare: "the spec findings over the findings with a known cause",
  multiFindingCriteria: "review.rejected events' blocking findings, grouped by task and criterion number",
  repeats: "review.rejected events: a blocking finding with the file and text of an earlier blocking finding of the same task",
  firstCriteriaReview: "criteria_review.approved and criteria_review.rejected events: each task's first of either",
  checkFailures: "check.failed_tests events (a required check failing at landing or on main), with check.cause events",
};

const causeOf = (v: unknown): FindingCause => (typeof v === "string" && (CAUSES as readonly string[]).includes(v) ? v as FindingCause : "unknown");
// What tells one finding from another, as findingKey in src/rules.ts does.
const keyOf = (f: { file: string; text: string }) => `${f.file.trim().replace(/^\.\//, "")}\n${f.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()}`;

function measure(scope: string, input: readonly WritingEvent[], now: number): CriteriaWriting {
  const from = now - WRITING_WINDOW_DAYS * DAY_MS;
  const events = [...input].sort((a, b) => a.seq - b.seq);
  const inWindow = (e: WritingEvent) => Date.parse(e.at) >= from && Date.parse(e.at) <= now;
  // The latest correction of each finding's cause, and of each failed check's.
  const corrected = new Map<string, FindingCause>(), checkCause = new Map<number, FindingCause>();
  for (const e of events) {
    if (e.kind === "review.finding_cause") corrected.set(`${e.data?.review}#${e.data?.index}`, causeOf(e.data?.cause));
    else if (e.kind === "check.cause" && typeof e.data?.failure === "number") checkCause.set(e.data.failure, causeOf(e.data.cause));
  }

  const byCause = noCauses(), perCriterion = new Map<string, { task: string; criterion: number; findings: number }>();
  const seen = new Map<string, Set<string>>();
  let findings = 0, repeats = 0;
  for (const e of events) {
    if (e.kind !== "review.rejected" || !Array.isArray(e.data?.findings)) continue;
    const task = e.itemId ?? "";
    const earlier = seen.get(task) ?? new Set<string>();
    seen.set(task, earlier);
    const here: string[] = [];
    (e.data.findings as Record<string, unknown>[]).forEach((f, i) => {
      if (f?.severity !== "blocking" || typeof f.file !== "string" || typeof f.text !== "string") return;
      const key = keyOf({ file: f.file, text: f.text });
      if (inWindow(e)) {
        findings++;
        byCause[corrected.get(`${e.seq}#${i + 1}`) ?? causeOf(f.cause)]++;
        if (earlier.has(key)) repeats++;
        if (typeof f.criterion === "number") {
          const at = `${task}#${f.criterion}`;
          const row = perCriterion.get(at) ?? { task, criterion: f.criterion, findings: 0 };
          row.findings++;
          perCriterion.set(at, row);
        }
      }
      here.push(key);
    });
    for (const key of here) earlier.add(key);
  }
  const known = findings - byCause.unknown;

  const first = new Map<string, WritingEvent>();
  for (const e of events) if ((e.kind === "criteria_review.approved" || e.kind === "criteria_review.rejected") && e.itemId && !first.has(e.itemId)) first.set(e.itemId, e);
  const firsts = [...first.values()].filter(inWindow);
  const approved = firsts.filter((e) => e.kind === "criteria_review.approved").length;

  const failures = noCauses();
  let failed = 0;
  for (const e of events) {
    if (e.kind !== "check.failed_tests" || !inWindow(e)) continue;
    failed++;
    failures[checkCause.get(e.seq) ?? causeOf(e.data?.cause)]++;
  }
  return {
    scope, findings, byCause, known,
    specShare: known ? byCause.spec / known : null,
    multiFindingCriteria: [...perCriterion.values()].filter((r) => r.findings >= 2).sort((a, b) => b.findings - a.findings || a.task.localeCompare(b.task) || a.criterion - b.criterion),
    repeats,
    firstCriteriaReview: { tasks: firsts.length, approved, share: firsts.length ? approved / firsts.length : null },
    checkFailures: { total: failed, byCause: failures },
    sources: SOURCES,
  };
}

const add = (a: CauseCounts, b: CauseCounts): CauseCounts => Object.fromEntries(CAUSES.map((c) => [c, a[c] + b[c]])) as CauseCounts;

export function computeCriteriaWriting(projects: readonly { name: string; events: readonly WritingEvent[] }[], now: number): CriteriaWritingReport {
  const per = projects.map((p) => measure(p.name, p.events, now));
  const overall: CriteriaWriting = per.reduce((sum, m) => ({
    ...sum,
    findings: sum.findings + m.findings, known: sum.known + m.known, byCause: add(sum.byCause, m.byCause),
    multiFindingCriteria: [...sum.multiFindingCriteria, ...m.multiFindingCriteria.map((r) => ({ ...r, task: `${m.scope}/${r.task}` }))],
    repeats: sum.repeats + m.repeats,
    firstCriteriaReview: { tasks: sum.firstCriteriaReview.tasks + m.firstCriteriaReview.tasks, approved: sum.firstCriteriaReview.approved + m.firstCriteriaReview.approved, share: null },
    checkFailures: { total: sum.checkFailures.total + m.checkFailures.total, byCause: add(sum.checkFailures.byCause, m.checkFailures.byCause) },
  }), { scope: "overall", findings: 0, byCause: noCauses(), known: 0, specShare: null, multiFindingCriteria: [], repeats: 0, firstCriteriaReview: { tasks: 0, approved: 0, share: null }, checkFailures: { total: 0, byCause: noCauses() }, sources: SOURCES });
  overall.specShare = overall.known ? overall.byCause.spec / overall.known : null;
  overall.firstCriteriaReview.share = overall.firstCriteriaReview.tasks ? overall.firstCriteriaReview.approved / overall.firstCriteriaReview.tasks : null;
  return {
    windowDays: WRITING_WINDOW_DAYS, since: new Date(now - WRITING_WINDOW_DAYS * DAY_MS).toISOString(), observedAt: new Date(now).toISOString(),
    scopes: [...per, overall],
  };
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
const counts = (c: CauseCounts) => FINDING_CAUSES.map((k) => `${k} ${c[k]}`).join(", ");

export function formatCriteriaWriting(report: CriteriaWritingReport): string[] {
  const out = [`Criteria writing for the last ${report.windowDays} days (since ${report.since}, observed ${report.observedAt})`];
  for (const s of report.scopes) {
    const src = s.sources;
    out.push("", `${s.scope}: ${s.findings} blocking finding(s)`);
    out.push(`  findings by cause: ${counts(s.byCause)} [source: ${src.byCause}]`);
    if (s.byCause.unknown) out.push(`  ${s.byCause.unknown} finding(s) have cause unknown (recorded before causes were asked for, or the reply gave none) and are left out of the shares`);
    out.push(`  spec share: ${s.specShare === null ? "no findings with a known cause" : `${pct(s.specShare)} (${s.byCause.spec} of ${s.known} findings with a known cause)`} [source: ${src.specShare}]`);
    out.push(`  criteria with two or more findings: ${s.multiFindingCriteria.length ? s.multiFindingCriteria.map((r) => `${r.task} criterion ${r.criterion}: ${r.findings} findings`).join("; ") : "none"} [source: ${src.multiFindingCriteria}]`);
    out.push(`  repeats: ${s.repeats} [source: ${src.repeats}]`);
    const f = s.firstCriteriaReview;
    out.push(`  first criteria review: ${f.share === null ? "no task had one" : `${f.approved} of ${f.tasks} tasks (${pct(f.share)}) passed it`} [source: ${src.firstCriteriaReview}]`);
    out.push(`  failed required checks: ${s.checkFailures.total}${s.checkFailures.total ? ` (${counts(s.checkFailures.byCause)}, unknown ${s.checkFailures.byCause.unknown})` : ""} [source: ${src.checkFailures}]`);
  }
  return out;
}
