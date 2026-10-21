import { actorFamily, contributorsOf } from "../src/rules.ts";

// The provenance note `atelier merge` adds on refs/notes/atelier to the merge
// commit, which it pushes to the baseline and, when the owner chose one, to a
// public remote. Pure: the caller passes what the server returned.
//
// The note says what was accepted and how it was shown sound: the accepted
// head, the family mode in force at acceptance (t394), so nobody reads a
// single-family review as a cross-company one, each contributor with its
// company as the acceptance recorded it, the checks at it, each review at it
// (who reviewed, the verdict, the head and who recorded it) and the owner's
// override where one stands, the tree the checks passed on when the merge
// produced exactly that tree (checkedTree, which the caller measures), then the
// task's events by time, actor and kind.
// It carries no review note text and no override reason (the owner's decision
// of 2026-10-06): those stay in the ledger, which only the owner reads.
export function provenanceNote({ name, id, item, view, reviews, events, policy = null, acceptanceFamily = null, checkedTree = null }) {
  const override = item.reviewOverride?.head === item.acceptedHead ? item.reviewOverride : null;
  const contributors = acceptanceFamily?.contributors ?? contributorsOf(item).map((actor) => ({ actor, company: actorFamily(actor) }));
  return [
    `atelier ${name}/${id} "${item.title}"`,
    `accepted head ${item.acceptedHead}`,
    familyModeLine(modeAtAcceptance(item, events, policy, acceptanceFamily)),
    ...contributors.map((c) => `CONTRIBUTOR ${c.actor} (${c.company})`),
    ...view.map((e) => `${e.grade.toUpperCase()} ${e.passed === true ? "pass " : e.passed === false ? "FAIL " : ""}${e.claim} — ${e.by} ${e.at}`),
    ...reviews.map((r) => `REVIEW ${r.approve ? "approve" : "reject"} by ${r.by} at ${r.head}, recorded by ${r.recordedBy ?? "an unrecorded actor"}${r.proved === false ? ` with the developer's token${r.claimed ? ", answering a claimed review request" : ""}` : ""}`),
    ...(override ? [`REVIEW OVERRIDDEN by ${override.by} at ${override.head}`] : []),
    ...(checkedTree ? [`CHECKED TREE ${checkedTree.tree}: the merge produced exactly the tree these checks passed on (${checkedTree.claims.join(", ")}), so a deploy gate may accept them instead of running them again`] : []),
    ...events.slice().reverse().map((e) => `${e.at} ${e.actor} ${e.kind}`),
  ].join("\n");
}

// The company the project ran on alone when the change was accepted, null
// under the default, or undefined where that cannot be told: what the
// acceptance recorded; for an older acceptance that recorded nothing, the
// project's switch when it was made no later than the acceptance (or no
// switch was ever made), and otherwise unknown, never the current mode.
function modeAtAcceptance(item, events, policy, acceptanceFamily) {
  if (acceptanceFamily) return acceptanceFamily.singleFamily ?? null;
  const mode = policy?.familyMode ?? null;
  if (!mode) return null;
  const accepted = events.filter((e) => e.kind === "item.accepted" && (e.data?.head ?? item.acceptedHead) === item.acceptedHead).map((e) => e.at).sort().at(-1);
  return accepted && mode.at <= accepted ? mode.single ?? null : undefined;
}

function familyModeLine(single) {
  if (single === undefined) return "FAMILY MODE at acceptance not recorded: the project switched its family mode after this change was accepted";
  if (single) return `SINGLE-FAMILY MODE ${single} at acceptance: a review below counted when its reviewer was a different ${single} model from every contributor, not another company's model; contributors are listed with their companies as recorded`;
  return "CROSS-FAMILY MODE at acceptance: a protected change needed approval from a model of another company than every contributor";
}
