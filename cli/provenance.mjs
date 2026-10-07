// The provenance note `atelier merge` adds on refs/notes/atelier to the merge
// commit, which it pushes to the baseline and, when the owner chose one, to a
// public remote. Pure: the caller passes what the server returned.
//
// The note says what was accepted and how it was shown sound: the accepted
// head, the checks at it, each review at it (who reviewed, the verdict, the
// head and who recorded it) and the owner's override where one stands, then
// the task's events by time, actor and kind. It carries no review note text
// and no override reason (the owner's decision of 2026-10-06): those stay in
// the ledger, which only the owner reads.
export function provenanceNote({ name, id, item, view, reviews, events }) {
  const override = item.reviewOverride?.head === item.acceptedHead ? item.reviewOverride : null;
  return [
    `atelier ${name}/${id} "${item.title}"`,
    `accepted head ${item.acceptedHead}`,
    ...view.map((e) => `${e.grade.toUpperCase()} ${e.passed === true ? "pass " : e.passed === false ? "FAIL " : ""}${e.claim} — ${e.by} ${e.at}`),
    ...reviews.map((r) => `REVIEW ${r.approve ? "approve" : "reject"} by ${r.by} at ${r.head}, recorded by ${r.recordedBy ?? "an unrecorded actor"}${r.proved === false ? ` with the owner token${r.claimed ? ", answering a claimed review request" : ""}` : ""}`),
    ...(override ? [`REVIEW OVERRIDDEN by ${override.by} at ${override.head}`] : []),
    ...events.slice().reverse().map((e) => `${e.at} ${e.actor} ${e.kind}`),
  ].join("\n");
}
