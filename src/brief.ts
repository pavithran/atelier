// The decision brief: what is being decided, what the evidence points to, and a
// recommendation. A pure function of the record, so it can be tested with
// `node --test`. Every line is drawn from evidence, reviews, the gate or the
// event log; nothing is inferred beyond that.

import { DEFAULT_OWNER, evidenceAt, countingReviews, gate as gateOf, mergedBlockers, modelOf, recordedText, stateLabel, type Review } from "./rules.ts";
import { assertLength } from "./text.ts";
import type { LedgerEvent } from "./ledger.ts";
import type { Detail } from "./ui.ts";

export type Verdict = "accept" | "merge" | "review" | "wait" | "send back" | "decide" | "none";

export interface Brief {
  decided: string;
  summary: string | null;
  // The owner's framing, as the item records it: an agent reading the brief
  // sees what the task is not to do, when to stop and ask, and the next gate.
  nonGoals: string[];
  stopWhen: string[];
  nextGate: string | null;
  evidence: string[];
  recommendation: { verdict: Verdict; reason: string };
}

export const SUMMARY_MAX = 600;

// An agent's summary as stored: plain text, control characters as spaces,
// trimmed, or nothing. A summary still longer than SUMMARY_MAX is refused
// with the limit named, not cut short.
export function cleanSummary(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  assertLength(s, SUMMARY_MAX, "the summary");
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
  const reviews = countingReviews(detail.reviews, item.head, policy, detail.ownerActor ?? DEFAULT_OWNER);
  const rejections = reviews.filter((r) => !r.approve);
  const failed = view.checks.filter((c) => c.grade === "observed" && !c.passed);
  const pending = view.checks.filter((c) => c.grade === "pending");
  const passed = view.checks.filter((c) => c.grade === "observed" && c.passed);
  // A failing check on the merge with main that blocks, read as the gate
  // reads it, without the step it asks for.
  const onMerge = mergedBlockers(policy, detail.evidence, item.head).map((b) => b.split(";")[0]);
  const rev = item.head ? `at ${item.head.slice(0, 8)}` : "with nothing pushed";
  const title = item.title.trim().replace(/[.!?]+$/, "");

  // Evidence lines carry a rank. Over five, the least important go first: gate
  // flags and rejections rank highest, then checks, then reviews, then reports.
  // Lines keep their reading order.
  const lines: { rank: number; text: string }[] = [];
  if (view.checks.length || view.notApplicable.length) {
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
    if (view.notApplicable.length) parts.push(`${view.notApplicable.length} not applicable to this change`);
    lines.push({ rank: 1, text: `Required checks at this revision: ${parts.join(", ")}.` });
  }
  if (onMerge.length) lines.push({ rank: 0, text: `On the merge with main: ${onMerge.join("; ")}.` });
  if (reviews.length) {
    // Each review says who recorded it, where it says (recordedText).
    const recorded = (r: Review) => { const t = recordedText(r, detail.ownerActor ?? DEFAULT_OWNER); return t ? ` (${t})` : ""; };
    lines.push({ rank: 2, text: `Reviews at this revision: ${reviews.map((r) => `${reviewer(detail, r.by)} ${r.approve ? "approved" : "asked for changes"}${r.tier ? " as the tier review" : r.topTier ? " as the gate review, top tier" : ""}${recorded(r)}`).join(", ")}.` });
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
    const noted = [...unanswered].sort((a, b) => a.at.localeCompare(b.at)).reverse().find((r) => r.note.trim());
    lines.push({ rank: 0, text: `${who} asked for changes and no push is recorded since.${noted ? ` Note from ${reviewer(detail, noted.by)}: ${clip(noted.note.trim(), 120)}` : ""}` });
  }
  if (gate.outOfScope.length) {
    const shown = gate.outOfScope.slice(0, 3).join(", ");
    lines.push({ rank: 0, text: `Changes outside the task's scope: ${shown}${gate.outOfScope.length > 3 ? `, and ${gate.outOfScope.length - 3} more` : ""}.` });
  }
  if (gate.requirement) lines.push({ rank: -1, text: `${gate.requirement}. Project owner acceptance is required.` });
  if (gate.needsAssessor && !gate.requirement) lines.push({ rank: 0, text: "It touches a protected path and no model of another family than every contributor has approved this revision." });
  const overridden = overrideOf(detail);
  if (overridden) lines.push({ rank: -1, text: `The project owner overrode the independent review at this revision: ${clip(overridden.reason, 200).replace(/[.\s]*$/, "")}.` });
  if (view.reports.length) lines.push({ rank: 3, text: `${plural(view.reports.length, "report")} recorded, not verified.` });
  while (lines.length > 5) {
    let drop = 0;
    lines.forEach((l, i) => { if (l.rank >= lines[drop].rank) drop = i; });
    lines.splice(drop, 1);
  }

  const recommendation = recommend(detail, { passed: passed.length, total: view.checks.length, notApplicable: view.notApplicable.length, failed, onMerge, pending, rejections, unmeasured: view.changedPaths === null && !!item.head });

  // The sentence follows the recommendation, so the heading never contradicts it.
  const subject = `${item.id} ${rev}: ${title}.`;
  const decided =
    item.state === "merged" || item.state === "abandoned" ? `Nothing to decide: ${item.id} is ${stateLabel[item.state].toLowerCase()} ${rev}: ${title}.`
    : recommendation.verdict === "none" ? `Nothing to decide: ${subject}`
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
    nonGoals: item.nonGoals ?? [],
    stopWhen: item.stopWhen ?? [],
    nextGate: item.nextGate ?? null,
    evidence: lines.map((l) => l.text),
    recommendation,
  };
}

interface Picture {
  passed: number;
  total: number;
  notApplicable: number;  // required checks whose paths this change does not touch
  failed: { claim: string }[];
  onMerge: string[];      // checks failing on the merge with main that block, as the gate words them
  pending: { claim: string }[];
  rejections: { by: string }[];
  unmeasured: boolean;
}

// The owner's override that stands in for the independent review at this
// revision, read as accept() reads an accepted item: as if still submitted.
function overrideOf(d: Detail) {
  if (d.item.state === "accepted") return gateOf({ ...d.item, state: "submitted" }, d.policy, d.evidence, d.reviews, d.ownerActor ?? DEFAULT_OWNER).overridden ?? null;
  return d.gate.overridden ?? null;
}

// accept when the gate is ready; merge when accepted; send back when a review
// at this head rejects or a required check failed, at the head or on its
// merge with main where that blocks; review when only an
// independent approval of a protected change is missing; wait while checks are
// pending; decide otherwise. A closed task gets none: it is closed, so nothing
// is waiting on the owner.
function recommend(d: Detail, p: Picture): Brief["recommendation"] {
  const { item, gate } = d;
  const state = item.state === "claimed" ? "in progress" : stateLabel[item.state].toLowerCase();
  if (item.state === "accepted") {
    return overrideOf(d)
      ? { verdict: "merge", reason: "You accepted this revision with the independent review overridden, and the merge runs in your local checkout." }
      : { verdict: "merge", reason: "Approval is recorded for this revision, and the merge runs in your local checkout." };
  }
  if (item.state === "merged" || item.state === "abandoned") {
    // A merged task's own event carries the merge commit, when the record has it.
    const merge = d.events.find((ev) => ev.itemId === item.id && ev.kind === "item.merged");
    const commit = typeof merge?.data.mergeCommit === "string" ? merge.data.mergeCommit : "";
    const closed = item.state === "abandoned" ? "abandoned" : commit ? `merged as ${commit.slice(0, 8)}` : "merged";
    return { verdict: "none", reason: `The task is closed (${closed}), so nothing is waiting on you.` };
  }
  if (item.state === "submitted" && gate.ready) {
    return {
      verdict: "accept",
      reason: p.total ? `${p.passed} of ${p.total} required checks passed at this revision and nothing blocks it.`
        : p.notApplicable ? "No required check applies to this revision's changes, and nothing blocks it." : "The project requires no checks, and nothing blocks it.",
    };
  }
  // The order is the page's: a failed check comes first, then a missing
  // independent approval, which a qualifying reviewer gives or the owner
  // overrides, then a rejection.
  const asked = p.rejections.map((r) => `${reviewer(d, r.by)} asked for changes at this revision`);
  const failedChecks = [...p.failed.map((c) => `\`${c.claim}\` failed at this revision`), ...p.onMerge];
  if (failedChecks.length) return { verdict: "send back", reason: `${upper([...asked, ...failedChecks].join(" and "))}.` };
  if (item.state === "submitted" && gate.needsAssessor) {
    const also = [
      ...asked,
      ...p.pending.map((c) => `\`${c.claim}\` is also not yet observed at this revision`),
    ];
    return {
      verdict: "review",
      // The override is offered only when the missing review is all that
      // blocks, since it waives that and nothing else.
      reason: `${gate.requirement ?? "This revision touches a protected path and needs an approval from a model of another family than every contributor"}${also.length ? `; ${also.join("; ")}` : ""}.${gate.blockers.length === 1 ? " Your own approval is not that review; if no reviewer qualifies, accept with an override and its reason." : ""}`,
    };
  }
  if (asked.length) return { verdict: "send back", reason: `${upper(asked.join(" and "))}.` };
  // A blocked task waits on the owner, not on the agent: the reason says what
  // must be cleared, and the task keeps its owner and workspace until then.
  if (item.state === "blocked") {
    const b = item.blocked;
    const reason = (b?.reason ?? "no reason recorded").replace(/[.\s]*$/, "");
    return { verdict: "decide", reason: `${b?.by ?? "Nobody"} blocked it: ${clip(reason, 200)}. Clear that, then run atelier unblock ${item.id}; or close it with atelier abandon ${item.id}.` };
  }
  if (item.state !== "submitted") {
    return { verdict: "wait", reason: `The task is ${state} and has not been submitted for a decision.` };
  }
  const waiting = [
    ...p.pending.map((c) => `\`${c.claim}\` to be observed at this revision`),
    ...(p.unmeasured && !p.pending.length ? ["the changed paths to be measured"] : []),
  ];
  if (waiting.length) return { verdict: "wait", reason: `Waiting for ${waiting.join(" and ")}.` };
  return { verdict: "decide", reason: `The record does not settle it: ${(gate.blockers[0] ?? "no blocker is recorded").replace(/[.!?]+$/, "")}.` };
}
