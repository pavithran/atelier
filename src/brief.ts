// The decision brief: what is being decided, what the evidence points to, and a
// recommendation. A pure function of the record, so it can be tested with
// `node --test`. Every line is drawn from evidence, reviews, the gate or the
// event log; nothing is inferred beyond that.

import { DEFAULT_OWNER, evidenceAt, latestReviews, modelOf, stateLabel } from "./rules.ts";
import type { LedgerEvent } from "./ledger.ts";
import type { Detail } from "./ui.ts";

export type Verdict = "accept" | "merge" | "review" | "wait" | "send back" | "decide";

export interface Brief {
  decided: string;
  summary: string | null;
  evidence: string[];
  recommendation: { verdict: Verdict; reason: string };
}

export const SUMMARY_MAX = 600;

// An agent's summary as stored: plain text, control characters as spaces,
// trimmed, at most 600 characters, or nothing.
export function cleanSummary(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, SUMMARY_MAX).trim();
  return s || undefined;
}

// The latest submission for this head decides the summary: a later submit
// without one leaves none. Events arrive newest first, but order by seq anyway.
export function submission(events: LedgerEvent[], itemId: string, head: string | null): { summary: string; by: string } | null {
  if (!head) return null;
  const last = events
    .filter((ev) => ev.itemId === itemId && ev.kind === "item.submitted" && ev.data.head === head)
    .sort((a, b) => a.seq - b.seq)
    .pop();
  const summary = last && typeof last.data.summary === "string" ? last.data.summary : "";
  return last && summary ? { summary, by: last.actor } : null;
}

const WHERE_LABEL = { sandbox: "in a Cloudflare container", runner: "on the agent's machine" } as const;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
// The project owner is not a model; the gate keeps them apart, and so do these lines.
const reviewer = (d: Detail, by: string) => (by === (d.ownerActor ?? DEFAULT_OWNER) ? "the project owner" : modelOf(by));
// Only "the project owner" opens a sentence in capitals; a model keeps its own spelling.
const upper = (s: string) => (s.startsWith("the ") ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function briefFor(detail: Detail, events: LedgerEvent[] = detail.events): Brief {
  const { item, policy, gate } = detail;
  const view = evidenceAt(policy, detail.evidence, item.head);
  const reviews = latestReviews(detail.reviews, item.head);
  const rejections = reviews.filter((r) => !r.approve);
  const failed = view.checks.filter((c) => c.grade === "observed" && !c.passed);
  const pending = view.checks.filter((c) => c.grade === "pending");
  const passed = view.checks.filter((c) => c.grade === "observed" && c.passed);
  const rev = item.head ? `at ${item.head.slice(0, 8)}` : "with nothing pushed";
  const title = item.title.trim().replace(/[.!?]+$/, "");

  // Evidence lines carry a rank. Over five, the least important go first: gate
  // flags and rejections rank highest, then checks, then reviews, then reports.
  // Lines keep their reading order.
  const lines: { rank: number; text: string }[] = [];
  if (view.checks.length) {
    const parts: string[] = [];
    for (const where of ["sandbox", "runner"] as const) {
      const n = passed.filter((c) => (c.where ?? "runner") === where).length;
      if (n) parts.push(`${n} passed ${WHERE_LABEL[where]}`);
    }
    for (const where of ["sandbox", "runner"] as const) {
      const n = failed.filter((c) => (c.where ?? "runner") === where).length;
      if (n) parts.push(`${n} failed ${WHERE_LABEL[where]}`);
    }
    if (pending.length) parts.push(`${pending.length} waiting`);
    lines.push({ rank: 1, text: `Required checks at this revision: ${parts.join(", ")}.` });
  }
  if (reviews.length) {
    lines.push({ rank: 2, text: `Reviews at this revision: ${reviews.map((r) => `${reviewer(detail, r.by)} ${r.approve ? "approved" : "asked for changes"}`).join(", ")}.` });
  }
  // A rejection is answered when a push was observed after it, as the stuck
  // rules read it; the head alone cannot say, since a head can return.
  const pushed = events
    .filter((ev) => ev.itemId === item.id && ev.kind === "push.observed")
    .map((ev) => ev.at)
    .sort()
    .pop() ?? item.lastPushAt;
  const unanswered = rejections.filter((r) => !(pushed && pushed > r.at));
  if (unanswered.length) {
    const models = [...new Set(unanswered.filter((r) => reviewer(detail, r.by) !== "the project owner").map((r) => modelOf(r.by)))];
    const asked = [
      ...(unanswered.some((r) => reviewer(detail, r.by) === "the project owner") ? ["the project owner"] : []),
      ...(models.length > 1 ? [`${models.length} models (${models.join(", ")})`] : models),
    ];
    const who = upper(asked.join(" and "));
    const note = [...unanswered].sort((a, b) => a.at.localeCompare(b.at)).reverse().find((r) => r.note.trim())?.note.trim();
    lines.push({ rank: 0, text: `${who} asked for changes and no push is recorded since.${note ? ` Note: ${clip(note, 120)}` : ""}` });
  }
  if (gate.outOfScope.length) {
    const shown = gate.outOfScope.slice(0, 3).join(", ");
    lines.push({ rank: 0, text: `Changes outside the task's scope: ${shown}${gate.outOfScope.length > 3 ? `, and ${gate.outOfScope.length - 3} more` : ""}.` });
  }
  if (gate.needsAssessor) lines.push({ rank: 0, text: "It touches a protected path and no different model or the project owner has approved this revision." });
  if (view.reports.length) lines.push({ rank: 3, text: `${plural(view.reports.length, "report")} recorded, not verified.` });
  while (lines.length > 5) {
    let drop = 0;
    lines.forEach((l, i) => { if (l.rank >= lines[drop].rank) drop = i; });
    lines.splice(drop, 1);
  }

  const recommendation = recommend(detail, { passed: passed.length, total: view.checks.length, failed, pending, rejections, unmeasured: view.changedPaths === null && !!item.head });

  // The sentence follows the recommendation, so the heading never contradicts it.
  const subject = `${item.id} ${rev}: ${title}.`;
  const decided =
    item.state === "merged" || item.state === "abandoned" ? `${item.id} is ${stateLabel[item.state].toLowerCase()} ${rev}: ${title}.`
    : recommendation.verdict === "merge" ? `Merge ${subject}`
    : recommendation.verdict === "send back" ? `Send ${item.id} back ${rev}: ${title}.`
    : recommendation.verdict === "review" ? `Review ${subject}`
    : recommendation.verdict === "accept" ? `Accept ${subject}`
    : recommendation.verdict === "wait" ? `Wait on ${subject}`
    : `Decide ${subject}`;

  const submitted = submission(events, item.id, item.head);
  return {
    decided,
    summary: submitted?.summary ?? null,
    evidence: lines.map((l) => l.text),
    recommendation,
  };
}

interface Picture {
  passed: number;
  total: number;
  failed: { claim: string }[];
  pending: { claim: string }[];
  rejections: { by: string }[];
  unmeasured: boolean;
}

// accept when the gate is ready; merge when accepted; send back when a review
// at this head rejects or a required check failed; review when only an
// independent approval of a protected change is missing; wait while checks are
// pending; decide otherwise.
function recommend(d: Detail, p: Picture): Brief["recommendation"] {
  const { item, gate } = d;
  const state = item.state === "claimed" ? "in progress" : stateLabel[item.state].toLowerCase();
  if (item.state === "accepted") {
    return { verdict: "merge", reason: "Approval is recorded for this revision, and the merge runs in your local checkout." };
  }
  if (item.state === "merged" || item.state === "abandoned") {
    return { verdict: "decide", reason: `The task is ${state}, so nothing is waiting on you.` };
  }
  if (item.state !== "submitted") {
    return { verdict: "wait", reason: `The task is ${state} and has not been submitted for a decision.` };
  }
  if (gate.ready) {
    return {
      verdict: "accept",
      reason: p.total ? `${p.passed} of ${p.total} required checks passed at this revision and nothing blocks it.` : "The project requires no checks, and nothing blocks it.",
    };
  }
  const against = [
    ...p.rejections.map((r) => `${reviewer(d, r.by)} asked for changes at this revision`),
    ...p.failed.map((c) => `\`${c.claim}\` failed at this revision`),
  ];
  if (against.length) return { verdict: "send back", reason: `${upper(against.join(" and "))}.` };
  if (gate.needsAssessor && !p.pending.length) {
    return { verdict: "review", reason: "This revision touches a protected path and needs an approval from a different model or the project owner." };
  }
  const waiting = [
    ...p.pending.map((c) => `\`${c.claim}\` to be observed at this revision`),
    ...(gate.needsAssessor ? ["an approval of this revision from a different model or the project owner"] : []),
    ...(p.unmeasured && !p.pending.length ? ["the changed paths to be measured"] : []),
  ];
  if (waiting.length) return { verdict: "wait", reason: `Waiting for ${waiting.join(" and ")}.` };
  return { verdict: "decide", reason: `The record does not settle it: ${(gate.blockers[0] ?? "no blocker is recorded").replace(/[.!?]+$/, "")}.` };
}
