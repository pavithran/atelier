// The decision brief: what is being decided, what the evidence points to, and a
// recommendation. A pure function of the record, so it can be tested with
// `node --test`. Every line is drawn from evidence, reviews, the gate or the
// event log; nothing is inferred beyond that.

import { evidenceAt, latestReviews, modelOf, stateLabel } from "./rules.ts";
import type { LedgerEvent } from "./ledger.ts";
import type { Detail } from "./ui.ts";

export type Verdict = "accept" | "merge" | "wait" | "send back" | "decide";

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
export function submission(events: LedgerEvent[], head: string | null): { summary: string; by: string } | null {
  if (!head) return null;
  const last = events
    .filter((ev) => ev.kind === "item.submitted" && ev.data.head === head)
    .sort((a, b) => a.seq - b.seq)
    .pop();
  const summary = last && typeof last.data.summary === "string" ? last.data.summary : "";
  return last && summary ? { summary, by: last.actor } : null;
}

const WHERE_LABEL = { sandbox: "in a Cloudflare container", runner: "on the agent's machine" } as const;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
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
    lines.push({ rank: 2, text: `Reviews at this revision: ${reviews.map((r) => `${modelOf(r.by)} ${r.approve ? "approved" : "asked for changes"}`).join(", ")}.` });
  }
  if (rejections.length) {
    // Rejections at the current head: the ledger records no push since, because a push changes the head.
    const latest = [...rejections].sort((a, b) => a.at.localeCompare(b.at)).pop()!;
    const who = [...new Set(rejections.map((r) => modelOf(r.by)))].join(" and ");
    lines.push({ rank: 0, text: `${who} asked for changes and no push is recorded since.${latest.note ? ` Note: ${clip(latest.note, 120)}` : ""}` });
  }
  if (gate.outOfScope.length) {
    const shown = gate.outOfScope.slice(0, 3).join(", ");
    lines.push({ rank: 0, text: `Changes outside the task's scope: ${shown}${gate.outOfScope.length > 3 ? `, and ${gate.outOfScope.length - 3} more` : ""}.` });
  }
  if (gate.needsAssessor) lines.push({ rank: 0, text: "It touches a protected path and no different model or the project owner has approved." });
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
    : item.state === "submitted" && gate.needsAssessor ? `Review ${subject}`
    : recommendation.verdict === "accept" ? `Accept ${subject}`
    : recommendation.verdict === "wait" ? `Wait on ${subject}`
    : `Decide ${subject}`;

  const submitted = submission(events, item.head);
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
// at this head rejects or a required check failed; wait while checks or a
// required review are pending; decide otherwise.
function recommend({ item, gate }: Detail, p: Picture): Brief["recommendation"] {
  if (item.state === "accepted") {
    return { verdict: "merge", reason: "Approval is recorded for this revision, and the merge runs in your local checkout." };
  }
  if (item.state === "merged" || item.state === "abandoned") {
    return { verdict: "decide", reason: `The task is ${stateLabel[item.state].toLowerCase()}, so nothing is waiting on you.` };
  }
  if (item.state !== "submitted") {
    return { verdict: "wait", reason: `The task is ${stateLabel[item.state].toLowerCase()} and has not been submitted for a decision.` };
  }
  if (gate.ready) {
    return { verdict: "accept", reason: `${p.passed} of ${plural(p.total, "required check")} passed at this revision and nothing blocks it.` };
  }
  const against = [
    ...p.rejections.map((r) => `${modelOf(r.by)} asked for changes at this revision`),
    ...p.failed.map((c) => `\`${c.claim}\` failed at this revision`),
  ];
  if (against.length) return { verdict: "send back", reason: `${against.join(" and ")}.` };
  const waiting = [
    ...p.pending.map((c) => `\`${c.claim}\` to be observed at this revision`),
    ...(gate.needsAssessor ? ["an approval from a different model or the project owner"] : []),
    ...(p.unmeasured && !p.pending.length ? ["the changed paths to be measured"] : []),
  ];
  if (waiting.length) return { verdict: "wait", reason: `Waiting for ${waiting.join(" and ")}.` };
  return { verdict: "decide", reason: `The record does not settle it: ${(gate.blockers[0] ?? "no blocker is recorded").replace(/[.!?]+$/, "")}.` };
}
