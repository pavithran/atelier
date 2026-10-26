import type { Detail } from "./ui.ts";
import type { LedgerEvent } from "./ledger.ts";
import { bindingOf, decisionFor } from "./rules.ts";
import { taskStage } from "./board.ts";

const text = (v: unknown): string => typeof v === "string" ? v : "";
const reason = (e: LedgerEvent) => text(e.data.note) || text(e.data.reason) || text(e.data.summary);
const verdict = (e: LedgerEvent) => e.kind === "review.approved" || e.kind === "review.rejected" || e.kind.startsWith("triage.");

// Presentation only: action eligibility still comes from decisionFor and the gate.
export function taskPage(d: Detail) {
  const events = d.events.filter(e => e.itemId === d.item.id).sort((a, b) => a.seq - b.seq);
  const submissions = events.filter(e => e.kind === "item.submitted");
  const rounds = submissions.map((s, i) => ({
    submission: s,
    verdicts: events.filter(e => e.seq > s.seq && (!submissions[i + 1] || e.seq < submissions[i + 1].seq)
      && verdict(e) && (!e.data.head || e.data.head === s.data.head)),
  })).reverse();
  const unknowns: string[] = [];
  if (!events.some(e => e.kind === "item.created")) unknowns.push("Earlier task history is unavailable.");
  if (d.item.head && !submissions.length) unknowns.push("Submission history is unavailable.");
  // Under fast mode the criteria review is skipped, and a deadlock holds a
  // build for good (t179); the page says either beside what else it cannot
  // show. Both come from the server's view, so an older server says nothing.
  const review = d.criteriaReview;
  if (review?.skipped) unknowns.push(`Criteria review skipped: ${review.skippedReason ?? "the project is in fast mode"}.`);
  if (review?.deadlock) unknowns.push(review.deadlock);
  const decision = decisionFor(d.item, d.policy, d.evidence, d.reviews, d.ownerActor, d.mode?.mode === "fast");
  const stage = taskStage(d.item, { ready: d.gate.ready });
  let title = decision.title, detail = decision.detail;
  if (stage === "blocked") {
    title = "Blocked";
    if (d.item.state !== "blocked") detail = d.item.blocked?.reason || "The blocking reason is unavailable in the recorded history.";
  } else if (d.item.state === "open") {
    const last = [...events].reverse().find(e => (e.kind === "item.dispatched" && !!reason(e)) || e.kind === "item.released" || e.kind === "review.rework" || verdict(e));
    const returned = events.some(e => e.kind === "item.released" || e.kind === "review.rework" || verdict(e));
    if (returned || submissions.length || d.item.head) {
      title = "Open again · awaiting rework";
      detail = last && reason(last) || "The task is open again; the reason is unavailable in the recorded history.";
    }
  } else if (stage === "building" || stage === "submitted" || (stage === "ready" && d.item.state === "submitted")) {
    const last = [...events].reverse().find(e => verdict(e) && e.data.head === d.item.head && e.data.criteria === bindingOf(d.item).criteria);
    if (last && (last.kind === "review.rejected" || last.kind === "triage.rejected")) {
      title = "Changes requested";
      detail = reason(last) || "The verdict reason is unavailable.";
    }
  }

  // Reports have no structured check/head/binding fields. Recover only facts
  // supported by the ledger at that time, never today's head or criteria.
  const bindingAt = (at: string) => {
    let head = "", criteria = "";
    for (const e of events.filter(e => e.at <= at)) {
      if (["push.observed", "item.submitted"].includes(e.kind)) head = text(e.data.head);
      if (typeof e.data.criteria === "string") criteria = e.data.criteria;
      if (e.kind === "item.criteria_changed") criteria = text(e.data.to);
    }
    return { head, criteria };
  };
  const notices = new Map<string, { kind: string; check: string; criteria: string; originals: { detail: string; actor: string; runner: string; at: string; head: string; superseded: boolean }[] }>();
  for (const r of d.runs ?? []) {
    if (r.item !== d.item.id || r.outcome !== "validation_blocked") continue;
    const { head, criteria } = bindingAt(r.at);
    const matches = d.policy.checks.filter(c => r.detail === c || r.detail.startsWith(c + ":") || r.detail.startsWith(c + " could not run"));
    const check = matches.length === 1 ? matches[0] : "";
    const superseded = !!head && !!criteria && !!check && d.evidence.some(e =>
      e.itemId === d.item.id && e.claim === check && e.grade === "observed" && e.passed === true && !e.merged && !e.notApplicable
      && e.at > r.at && bindingAt(e.at).criteria === criteria
      && (e.head === head || submissions.some(s => s.at > r.at && s.data.head === e.head && bindingAt(s.at).criteria === criteria)));
    const key = JSON.stringify([r.outcome, check, criteria]);
    const group = notices.get(key) ?? { kind: "Validation blocked", check, criteria, originals: [] };
    group.originals.push({ ...r, head, superseded });
    notices.set(key, group);
  }
  return { title, detail, unknowns, rounds, notices: [...notices.values()] };
}
