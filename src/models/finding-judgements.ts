// What the developer has said about each blocking finding of one task
// (t47). A pure function over the task's ledger events: every blocking
// finding of every review is a row, identified by its review event's
// sequence and its position in that review, with the newest explicit verdict
// (`atelier finding`, a review.finding event) or null for unjudged, and every
// verdict recorded on it, so a correction leaves its history.
//
// Nothing is inferred. An approval, a merge, an override or cited lines that
// did not change say nothing about a finding: a finding without a recorded
// verdict is unjudged, and stays out of the precision this returns, which is
// computed as src/models/precision.ts does, upheld (confirmed or fixed) over
// judged. The counts are of the rows given, so the judged and total figures
// and the precision describe one population.

import type { LedgerEvent } from "../ledger.ts";
import { sameActor } from "../rules.ts";
import { isReviewer } from "./precision.ts";
import { reviewerOf, servedBy } from "./served.ts";

export type Verdict = "confirmed" | "refuted" | "fixed";

export interface JudgementHistory { seq: number; at: string; verdict: Verdict; note: string; acting: string | null }

export interface FindingJudgement {
  review: number;        // the review event's sequence
  index: number;         // the finding's position in that review, one based
  by: string;            // the reviewer, under the model that served the review
  head: string;          // the revision the review was made at
  file: string;
  line: number | null;
  text: string;
  verdict: Verdict | null;          // the newest explicit verdict, null when unjudged
  history: JudgementHistory[];      // every verdict recorded on it, oldest first
}

export interface Judgements {
  findings: FindingJudgement[];
  total: number;
  judged: number;
  upheld: number;
  precision: number | null;   // upheld / judged; null with none judged
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const isVerdict = (v: unknown): v is Verdict => v === "confirmed" || v === "refuted" || v === "fixed";

// `events` are the task's events in any order; only its reviews, the
// verdicts on their findings and the served annotations are read. `owner`
// is never a reviewer model: its own review is left out, as in precision.
export function findingJudgements(events: readonly LedgerEvent[], owner: string | null = null): Judgements {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const served = servedBy(sorted);
  const reviews = sorted.filter((e) => e.kind === "review.approved" || e.kind === "review.rejected");
  const rows = new Map<string, FindingJudgement>();
  for (const r of reviews) {
    const by = reviewerOf(r.actor, r, served);
    if (!isReviewer(by, owner) || !Array.isArray(r.data.findings)) continue;
    (r.data.findings as { file?: unknown; line?: unknown; severity?: unknown; text?: unknown }[]).forEach((f, i) => {
      if (f?.severity !== "blocking") return;
      rows.set(`${r.seq} ${i + 1}`, {
        review: r.seq, index: i + 1, by, head: str(r.data.head), file: str(f.file), line: typeof f.line === "number" ? f.line : null, text: str(f.text),
        verdict: null, history: [],
      });
    });
  }
  for (const v of sorted) {
    if (v.kind !== "review.finding" || !isVerdict(v.data.verdict) || !Number.isInteger(v.data.index)) continue;
    // A verdict naming its review is on that review alone; one from before
    // (t486) was on its reviewer's newest review at the head when recorded.
    const review = typeof v.data.review === "number"
      ? v.data.review
      : reviews.filter((r) => r.seq < v.seq && str(r.data.head) === str(v.data.head) && sameActor(r.actor, str(v.data.by))).at(-1)?.seq;
    const row = review === undefined ? undefined : rows.get(`${review} ${v.data.index}`);
    if (!row) continue;
    row.verdict = v.data.verdict;
    row.history.push({ seq: v.seq, at: v.at, verdict: v.data.verdict, note: str(v.data.note), acting: typeof v.data.acting === "string" ? v.data.acting : null });
  }
  const findings = [...rows.values()].sort((a, b) => a.review - b.review || a.index - b.index);
  const judged = findings.filter((f) => f.verdict !== null).length;
  const upheld = findings.filter((f) => f.verdict === "confirmed" || f.verdict === "fixed").length;
  return { findings, total: findings.length, judged, upheld, precision: judged ? upheld / judged : null };
}
