// Pre-review (t524): while one landing holds the project's lease, the next
// landings queued behind it are reviewed at the reviewer's bar against the
// tree their own landing would test — the task's recorded head merged with
// main as a runner captured it, prepared as the landing prepares it — so a
// defect is found before the task's turn rather than after it spends the
// lease. The orchestrator's prereview.brief did this by hand; on 2026-10-11
// it stopped real defects in four of eight tasks before their slot.
//
// Pre-review is evidence beside the gate, never the gate: its requests live
// apart from review requests, its results apart from reviews, and nothing
// here satisfies, rejects or answers a gate review or counts a round. What it
// may change is narrow: a fresh blocking verdict takes the task out of the
// landing queue and fences its landing until the owner or the builder asks
// again (Ledger.unblock), and sends the findings to the builder. Everything
// else — no reviewer, a skipped or failed job, a timeout, a reply no verdict
// is read from — is an unavailable result, which leaves the task's place and
// its landing exactly as they were.
//
// The ledger keeps the state (src/ledger.ts, the prereviews table); this
// module holds what is decided from it without storage: which waiters are
// eligible, the binding a request and its result are judged by, the request
// numbers the review routes carry, the verdict's envelope and the outcome
// notes a runner reports, the views the task detail and landing status show,
// and the brief the runner's reviewer reads (cli/runner.mjs, runPrereview).

import { landingLeaseLapsed, waitingLandingGone, type LandingLease, type WaitingLanding } from "../landing-lease.ts";
import { sameActor, type Evidence, type Finding } from "../rules.ts";
import { DECISIONS_HEADING, DECISIONS_RULE, NO_DECISIONS, decisionLines, type Decision } from "../decisions.ts";

// The job a runner names in its offer to be given pre-reviews, and the job a
// pre-review dispatch carries. A runner that does not advertise it is never
// offered one (assign in src/dispatch/rules.ts).
export const PREREVIEW_JOB = "prereview";

// How many waiters behind the lease's holder are pre-reviewed at once.
export const PREREVIEW_DEPTH = 2;

// Pre-review requests travel through the review routes (review-claim,
// review-renew, review-release, review-unparsable, review-skip and review)
// under numbers no gate request reaches, so the ledger tells the two apart by
// the number alone and a pre-review can never answer, release or renew a
// gate request, nor a gate verdict a pre-review.
export const PREREVIEW_REQUEST_BASE = 1_000_000_000;
export const prereviewRequest = (id: number): number => PREREVIEW_REQUEST_BASE + id;
export const isPrereviewRequest = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > PREREVIEW_REQUEST_BASE;
export const prereviewId = (n: number): number => n - PREREVIEW_REQUEST_BASE;

// Retries are bounded: a binding is asked at most this many times. An
// unavailable result that may clear (retryable) is asked again while the task
// waits: one with no reviewer yet no sooner than PREREVIEW_RETRY_MS after it,
// and a runner failure, a timeout or a malformed reply at the next sweep,
// of another reviewer where one qualifies (askPrereview in src/ledger.ts).
export const PREREVIEW_ATTEMPTS = 3;
export const PREREVIEW_RETRY_MS = 5 * 60_000;

// The live states (open, claimed), and the settled ones a request ends in.
export type PrereviewState = "open" | "claimed" | "passed" | "blocked" | "conflict" | "preparation" | "unavailable" | "stale" | "withdrawn";

// Why a result is unavailable, and the other outcomes a runner reports.
export type UnavailableKind = "no-reviewer" | "skipped" | "timeout" | "malformed" | "runner";
export type PrereviewOutcome = UnavailableKind | "conflict" | "preparation" | "stale";
const OUTCOMES: readonly PrereviewOutcome[] = ["no-reviewer", "skipped", "timeout", "malformed", "runner", "conflict", "preparation", "stale"];

// Outcomes that a later attempt may clear. A conflict or a preparation that
// failed is the merged tree's own, and asking again at the same binding
// meets it again; a skip is the runner's word for this request.
export const retryable = (outcome: PrereviewOutcome): boolean => ["no-reviewer", "timeout", "malformed", "runner"].includes(outcome);

// What a request and its result are bound to. The head, the criteria and the
// contributors are the task's when the request is made; `generation` counts
// the merges the ledger has recorded (Ledger.mergeGeneration), so a landing
// that moves main moves it; `main` is main's last observed head when requested, captured from
// the baseline again when claimed (null until first observed),
// which the runner must merge and which must still be main's head when the
// verdict comes, so a baseline moved by anything (atelier sync pushes one
// without a merge) makes the result stale; `tree` is the tree the runner
// prepared, null until it reports it.
export interface PrereviewBinding {
  head: string;
  criteria: string;
  contributors: string[];
  generation: number;
  main: string | null;
  tree: string | null;
}

// The key requests are deduplicated by: one request per task and binding,
// whatever became of it, so a waiter's every poll does not ask again.
export function bindingKey(item: string, b: Pick<PrereviewBinding, "head" | "criteria" | "contributors" | "generation" | "main">): string {
  return JSON.stringify([item, b.head, b.criteria, normalContributors(b.contributors), b.generation, b.main]);
}

export const normalContributors = (list: readonly string[]): string[] => [...new Set(list.map((c) => c.toLowerCase()))].sort();

// Which of the binding's inputs changed, in words, or null when none did. A
// result whose binding drifted is stale and changes nothing.
export function bindingDrift(asked: Pick<PrereviewBinding, "head" | "criteria" | "contributors" | "generation">, now: Pick<PrereviewBinding, "head" | "criteria" | "contributors" | "generation">): string | null {
  const why: string[] = [];
  if (asked.head !== now.head) why.push(`the head moved from ${asked.head.slice(0, 8)} to ${now.head ? now.head.slice(0, 8) : "nothing"}`);
  if (asked.generation !== now.generation) why.push("main moved: a landing merged since the request");
  if (asked.criteria !== now.criteria) why.push("the acceptance criteria changed");
  const a = normalContributors(asked.contributors), b = normalContributors(now.contributors);
  if (a.length !== b.length || a.some((c, i) => c !== b[i])) why.push(`the contributors changed (${b.join(", ") || "none"})`);
  return why.length ? why.join("; ") : null;
}

// The waiters to pre-review while `lease` is live: the first PREREVIEW_DEPTH
// rows of the FIFO queue that still count at `now`, its holder excluded. A
// row whose landing stopped asking (expired), left the queue (cancelled) or
// whose task closed is not here, for the queue the ledger reads is already
// pruned of those; the expiry is judged again here so a stale read never
// counts one. No live lease, no pre-review.
export function prereviewCandidates(lease: LandingLease | null, live: boolean, waiting: readonly WaitingLanding[], now: number): WaitingLanding[] {
  if (!lease || !live || landingLeaseLapsed(lease, now)) return [];
  const seen = new Set<string>();
  return waiting.filter((w) => {
    if (w.item === lease.item || seen.has(w.item) || waitingLandingGone(w, now)) return false;
    seen.add(w.item);
    return true;
  }).slice(0, PREREVIEW_DEPTH);
}

// A pre-review verdict is posted through the review route, and its findings
// field carries an envelope: the main head the runner merged, the tree it
// prepared, and the findings themselves. A verdict without one is malformed
// and is recorded as unavailable.
export interface PrereviewReport { main: string; tree: string; findings: Finding[] }

const SHA = /^[a-f0-9]{40,64}$/;

export function prereviewEnvelope(report: PrereviewReport): { prereview: { main: string; tree: string }; findings: Finding[] } {
  return { prereview: { main: report.main, tree: report.tree }, findings: report.findings };
}

export function parsePrereviewReport(value: unknown): { ok: true; report: PrereviewReport } | { ok: false; error: string } {
  const v = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const p = v?.prereview !== null && typeof v?.prereview === "object" ? v.prereview as Record<string, unknown> : null;
  if (!v || !p) return { ok: false, error: "a pre-review verdict carries { prereview: { main, tree }, findings } in its findings field" };
  if (typeof p.main !== "string" || !SHA.test(p.main)) return { ok: false, error: "the pre-review verdict names no main head it merged" };
  if (typeof p.tree !== "string" || !SHA.test(p.tree)) return { ok: false, error: "the pre-review verdict names no prepared tree" };
  const raw = v.findings ?? [];
  if (!Array.isArray(raw) || raw.length > 50) return { ok: false, error: "the pre-review verdict's findings are not a list of at most 50" };
  const findings: Finding[] = [];
  for (const f of raw) {
    const x = f as Record<string, unknown> | null;
    if (!x || typeof x.file !== "string" || typeof x.text !== "string" || (x.severity !== "blocking" && x.severity !== "follow-up") || !(x.line === null || x.line === undefined || (Number.isSafeInteger(x.line) && (x.line as number) >= 0))) {
      return { ok: false, error: "a pre-review finding is not {file, line, severity, text}, severity blocking or follow-up" };
    }
    findings.push({ file: x.file.slice(0, 512), line: typeof x.line === "number" ? x.line : null, severity: x.severity, text: x.text.slice(0, 2000) });
  }
  return { ok: true, report: { main: p.main, tree: p.tree, findings } };
}

// Whether a verdict blocks: a rejection, or any blocking finding.
export const blocks = (approve: boolean, findings: readonly Finding[]): boolean => !approve || findings.some((f) => f.severity === "blocking");

// A verdict whose word and findings disagree — a rejection naming no
// blocking finding, or an approval naming one — says nothing the queue may
// act on. The ledger checks it itself, whatever client posted the verdict,
// and records it as malformed: an unavailable result that fences nothing.
export function verdictContradiction(approve: boolean, findings: readonly Finding[]): string | null {
  const blocking = findings.some((f) => f.severity === "blocking");
  if (!approve && !blocking) return "the pre-review verdict rejects but names no blocking finding; a rejection must name what blocks";
  if (approve && blocking) return "the pre-review verdict approves but names a blocking finding";
  return null;
}

// What a runner reports when it ends a pre-review without a verdict, as the
// note of a review-release: the outcome, what happened, and for a conflict
// the files and the main head it merged. The note is JSON so the ledger can
// record a conflict or a failed preparation apart from an unavailable
// result; a note that is not (an older runner, a hand release) is a runner
// failure, its text kept.
export interface OutcomeNote { outcome: PrereviewOutcome; detail: string; files?: string[]; main?: string }

export function outcomeNote(note: OutcomeNote, max = 2000): string {
  const files = (note.files ?? []).slice(0, 50).map((f) => String(f).slice(0, 300));
  const base = { outcome: note.outcome, ...(files.length ? { files } : {}), ...(note.main ? { main: note.main } : {}) };
  const room = Math.max(0, max - JSON.stringify({ ...base, detail: "" }).length - 8);
  return JSON.stringify({ ...base, detail: String(note.detail ?? "").slice(-room) });
}

export function parseOutcomeNote(note: string): OutcomeNote {
  try {
    const v = JSON.parse(note) as Record<string, unknown>;
    if (v && typeof v === "object" && OUTCOMES.includes(v.outcome as PrereviewOutcome)) {
      return {
        outcome: v.outcome as PrereviewOutcome,
        detail: typeof v.detail === "string" ? v.detail.slice(0, 2000) : "",
        ...(Array.isArray(v.files) ? { files: v.files.filter((f): f is string => typeof f === "string").slice(0, 50).map((f) => f.slice(0, 300)) } : {}),
        ...(typeof v.main === "string" && SHA.test(v.main) ? { main: v.main } : {}),
      };
    }
  } catch { /* plain text: a runner failure */ }
  return { outcome: "runner", detail: note.slice(0, 2000) };
}

// One pre-review as the task detail and landing status show it.
export interface PrereviewView {
  request: number;
  item: string;
  state: PrereviewState;
  reviewer: string | null;
  runner: string | null;
  binding: PrereviewBinding;
  at: string;
  claimedAt: string | null;
  settledAt: string | null;
  attempts: number;
  outcome: PrereviewOutcome | null;
  detail: string | null;
  files: string[];
  verdict: "approve" | "reject" | null;
  note: string | null;
  findings: Finding[];
  // The task took the landing lease before the result came: its result is
  // kept as evidence and controls nothing.
  detached: boolean;
  // A blocking result whose builder could not be given the rework.
  ownerAction: string | null;
  recovery: string;
}

// The fence a blocking result leaves on the task's landing, until the owner
// or the builder retries (atelier unblock ID).
export interface PrereviewFence { request: number; head: string; reviewer: string; at: string; blocking: number; builder: string | null; ownerAction: string | null }

export function fenceText(id: string, fence: PrereviewFence): string {
  return `${id}'s pre-review ${fence.request} by ${fence.reviewer} found ${fence.blocking === 1 ? "a blocking finding" : `${fence.blocking} blocking findings`} at ${fence.head.slice(0, 8)}, so it left the landing queue and its landing is fenced. ${fence.ownerAction ?? `Its builder ${fence.builder ?? "(none)"} has the findings to rework.`} Read them with atelier show ${id} --json or GET the task; once they are addressed, retry with atelier unblock ${id}, then atelier land ${id} again`;
}

// What to do about a pre-review, in words, by its state.
export function prereviewRecovery(v: Omit<PrereviewView, "recovery">): string {
  const by = v.reviewer ?? "no reviewer";
  if (v.detached && (v.state === "open" || v.state === "claimed" || v.state === "passed" || v.state === "blocked")) {
    return `none: ${v.item} took the landing lease first, so this result is evidence only and its landing's own checks and review go on without it`;
  }
  switch (v.state) {
    case "open": return `none: waiting for a runner that offers the ${PREREVIEW_JOB} job for ${by}; the landing never waits for it`;
    case "claimed": return `none: ${by} is reviewing the merged tree${v.runner ? ` on ${v.runner}` : ""}; the landing never waits for it`;
    case "passed": return "none: the queue position stands";
    case "blocked": return v.ownerAction
      ? `owner action needed: ${v.ownerAction}; once the findings are addressed, atelier unblock ${v.item}, then atelier land ${v.item}`
      : `rework: the builder addresses the blocking findings; then atelier unblock ${v.item} and atelier land ${v.item} again`;
    case "conflict": return `the landing will meet the same conflict merging main${v.files.length ? ` in ${v.files.join(", ")}` : ""}: resolve it in the workspace, or send it to the builder with atelier dispatch ${v.item} --job merge-main; the queue position stands`;
    case "preparation": return `the merged tree's preparation failed (${v.detail ?? "no detail"}); the landing prepares it again and will stop there if it still fails; the queue position stands`;
    case "unavailable": return v.attempts < PREREVIEW_ATTEMPTS && v.outcome && retryable(v.outcome)
      ? `none: no result (${v.outcome}); asked again while the task waits, at most ${PREREVIEW_ATTEMPTS} times, and the landing goes on as normal`
      : `none: no result (${v.outcome ?? "unknown"}); the landing goes on with its normal checks and review`;
    case "stale": return `none: ${v.detail ?? "its inputs changed"}; it changes nothing, and a new pre-review is asked while the task waits`;
    case "withdrawn": return `none: ${v.detail ?? "the task is no longer an eligible waiter"}`;
  }
}

// A pre-review in words, for `atelier show` and the task page (criterion 9):
// its state and reviewer, the binding it was asked under, its verdict or the
// reason it has none, each finding, and the recovery action. One line each.
export function prereviewLines(v: PrereviewView): string[] {
  const b = v.binding;
  const short = (sha: string | null, none: string) => sha ? sha.slice(0, 8) : none;
  const lines = [
    `Pre-review ${v.request}: ${v.state}${v.outcome ? ` (${v.outcome})` : ""}${v.detached ? ", detached from the queue" : ""}; reviewer ${v.reviewer ?? "none yet"}${v.runner ? ` on ${v.runner}` : ""}; attempt ${v.attempts} of ${PREREVIEW_ATTEMPTS}`,
    `Binding: head ${short(b.head, "unknown")} merged with main ${short(b.main, "not captured yet")}, tree ${short(b.tree, "not prepared yet")}, criteria ${b.criteria.slice(0, 12)}, contributors ${b.contributors.join(", ") || "none"}`,
  ];
  if (v.verdict) lines.push(`Verdict: ${v.verdict}${v.note ? `: ${v.note}` : ""}`);
  if (v.detail) lines.push(`Detail: ${v.detail}`);
  if (v.files.length) lines.push(`Files: ${v.files.join(", ")}`);
  for (const f of v.findings) lines.push(`  ${f.file}${f.line ? `:${f.line}` : ""} · ${f.severity} · ${f.text}`);
  lines.push(`Recovery: ${v.recovery}`);
  return lines;
}

// The same in one clause, for the line `atelier land --wait` prints while
// the task waits for the landing lease.
export function prereviewClause(v: PrereviewView): string {
  const blocking = v.findings.filter((f) => f.severity === "blocking").length;
  const found = v.findings.length ? `, ${v.findings.length} finding${v.findings.length === 1 ? "" : "s"}${blocking ? ` (${blocking} blocking)` : ""}` : "";
  return `pre-review ${v.request} ${v.state}${v.outcome ? ` (${v.outcome})` : ""} by ${v.reviewer ?? "no reviewer yet"} at ${v.binding.head.slice(0, 8)}${v.binding.main ? ` with main ${v.binding.main.slice(0, 8)}` : ""}${found}; recovery: ${v.recovery}`;
}

// Whether `actor` is the reviewer a pre-review dispatch asked for.
export const askedOf = (dispatch: { agent: string | null; model: string | null }, actor: string): boolean =>
  !!dispatch.agent && !!dispatch.model && sameActor(`${dispatch.agent}/${dispatch.model}`, actor);

// ── the reviewer's brief ────────────────────────────────────────────────

// Test files the merged tree holds that bear on the change: those it changed,
// and those whose name carries the stem of a source file it changed
// (src/landing-lease.ts → test/landing-lease.test.ts). At most `max`.
const TEST = /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
export function relevantTests(changed: readonly string[], tree: readonly string[], max = 40): string[] {
  const tests = tree.filter((p) => TEST.test(p));
  const stems = new Set(changed.filter((p) => !TEST.test(p)).map((p) => p.split("/").pop()!.replace(/\.[^.]+$/, "").toLowerCase()).filter((s) => s.length >= 3));
  const named = tests.filter((t) => {
    const base = t.split("/").pop()!.toLowerCase().replace(/\.(test|spec)\.[cm]?[jt]sx?$/, "").replace(/\.[^.]+$/, "");
    return [...stems].some((s) => base === s || base.startsWith(`${s}-`) || base.startsWith(`${s}.`));
  });
  return [...new Set([...changed.filter((p) => TEST.test(p) && tree.includes(p)), ...named])].sort().slice(0, max);
}

export interface PrereviewBriefInput {
  item: { id: string; title: string; brief?: string | null; accept?: readonly string[] };
  project: string;
  request: number;
  binding: PrereviewBinding;
  reviewer: string;
  contributors: readonly string[];
  bar: string | null;
  // The project's required checks, as commands, run in the merged checkout.
  checks: readonly string[];
  changed: readonly string[];
  tests: readonly string[];
  // The task's evidence as the claim gave it (evidence recorded at the head,
  // on the task's own tree, never the merged one), or null from a server
  // that sent none.
  evidence: { runs: readonly Evidence[] } | null;
  // The owner's standing decisions (src/decisions.ts), as the claim carries
  // them, which bind this reviewer as they bind the gate's; null or absent
  // from a server that sent none, rendered as the gate's brief renders it.
  decisions?: readonly Pick<Decision, "id" | "text" | "quote" | "at">[] | null;
  // What the runner's preparation did: the route level it raised, whether
  // the fixtures were regenerated, conflicts settled by regeneration.
  preparation: string[];
  diffFile: string;
  diffOmitted: string | null;
  slotNote: string;
  // The reply format the verdict is read in (replyFormat in
  // src/review/verdict.ts, which the runner passes, so this module calls no
  // review code).
  replyFormat: string;
}

const line1 = (s: string) => s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ");

export function prereviewBrief(input: PrereviewBriefInput): string {
  const { item, binding } = input;
  const accept = item.accept ?? [];
  const required = input.checks;
  const runs = input.evidence?.runs ?? [];
  const atHead = runs.filter((r) => r.head === binding.head);
  const results = atHead.map((r) => `- ${line1(r.claim)}: ${r.passed ? "passed" : "failed"} (${r.grade}${r.where ? `, ${r.where}` : ""}) at ${r.head.slice(0, 8)}, on the task's own tree`);
  const missing = required.filter((c) => !atHead.some((r) => r.claim === c && r.grade === "observed"));
  const omitted = [
    "- No check has run on this merged tree: every result above is the task's own head's. Run the commands below here before judging.",
    ...(input.evidence === null ? ["- The server sent no evidence with the claim; read it with atelier show " + item.id + "."] : []),
    ...missing.map((c) => `- ${line1(c)}: no observed result at ${binding.head.slice(0, 8)}.`),
    ...(input.diffOmitted ? [`- The diff is not inline: ${input.diffOmitted}`] : []),
    ...(input.tests.length ? [] : ["- No test file in the merged tree is named for the changed files; find the ones that cover them before judging a criterion met."]),
  ];
  return [
    `# Pre-review of ${item.id} in ${input.project}: ${line1(item.title)}`,
    "",
    `You pre-review this task at the reviewer's bar while another landing holds the project's lease: it waits in the landing queue, and a defect you find now is fixed before its turn instead of after it spends the lease. Your verdict is pre-review evidence (request ${input.request}). It is not the gate's review and does not accept or reject the task; a blocking finding takes the task out of the landing queue and back to its builder.`,
    "",
    "## The tree under review",
    "",
    `This checkout is ${item.id}'s recorded head ${binding.head} merged with main at ${binding.main ?? "(not captured)"}, prepared as atelier land prepares it; its tree is ${binding.tree ?? "(not recorded)"}. It is a scratch copy: nothing here is pushed, and the builder's workspace is untouched. Make no commits and push nothing.`,
    "",
    `Contributors: ${input.contributors.join(", ") || "none recorded"}. You, ${input.reviewer}, are independent of them under the project's rules.`,
    `Criteria binding: ${binding.criteria}.`,
    ...(input.preparation.length ? ["", "Preparation:", ...input.preparation.map((p) => `- ${line1(p)}`)] : []),
    "",
    "## The task",
    "",
    ...(item.brief ? [item.brief.trim(), ""] : []),
    ...(accept.length ? ["Acceptance criteria:", ...accept.map((c, i) => `${i + 1}. ${line1(c)}`)] : ["The task states no acceptance criteria."]),
    "",
    "## Merged-tree tests",
    "",
    `The change touches ${input.changed.length} file${input.changed.length === 1 ? "" : "s"}${input.changed.length ? `: ${input.changed.slice(0, 60).join(", ")}${input.changed.length > 60 ? ", …" : ""}` : ""}.`,
    ...(input.tests.length ? ["Test files in this merged tree that bear on them:", ...input.tests.map((t) => `- ${t}`)] : []),
    ...(required.length ? ["The project's required checks, run here in this merged checkout:", ...required.map((c) => `- ${line1(c)}`)] : ["The project declares no required checks; run the tests above directly."]),
    input.slotNote,
    "",
    "## Available results",
    "",
    ...(results.length ? results : ["- None recorded at this head."]),
    "",
    "## Omitted or unavailable evidence",
    "",
    ...omitted,
    "",
    "## The change",
    "",
    `The diff from the merge base with main to the task's head is in ${input.diffFile}.`,
    "",
    `## ${DECISIONS_HEADING}`,
    "",
    DECISIONS_RULE,
    "",
    ...(input.decisions?.length ? decisionLines(input.decisions).map(line1) : [NO_DECISIONS]),
    "",
    "## The bar",
    "",
    input.bar ?? "Block only for a defect a reviewer would block the landing for: a correctness, security or data-loss defect, a behaviour without a test, docs that now contradict the code, or a breaking change without a migration. Anything else is a follow-up.",
    "",
    "## Reply format",
    "",
    input.replyFormat,
  ].join("\n");
}

// What a pre-review claim adds to the review claim's answer: the request,
// its binding, the reviewer, the contributors it is independent of, the
// commands the merged tree is checked with and the command that regenerates
// the project's fixtures, which the runner's preparation runs as a landing's
// does (cli/runner.mjs, runPrereview).
export interface PrereviewClaim {
  request: number;
  binding: PrereviewBinding;
  reviewer: string;
  contributors: string[];
  checks: string[];
  regenerate: string | null;
  attempts: number;
}
