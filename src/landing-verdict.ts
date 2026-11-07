// The verdict a landing waits for (atelier land, t187): among the reviews
// at the head a request named, newer than the request itself and not
// withdrawn by a change of the task's acceptance criteria, the first
// rejection decides, whatever came after it, and otherwise the newest
// verdict is the answer. A tier review's approval (removed in t518) is a
// second opinion that never satisfies the gate, so it is reported apart and
// never counts; its rejection is a rejection like any other. The landing
// (cli/land.mjs) and the brief read this judgment.

import { completeBinding, preparationBinding } from "./checks.ts";
import { offering, type SeenOffer } from "./dispatch/rules.ts";
import { approvalsNeeded, changeClass, countingRunsAt, DEFAULT_OWNER, evidenceAt, foldPath, gateApprovals, sameActor, type Evidence, type Finding, type Item, type ProjectPolicy, type Review } from "./rules.ts";

export interface LandingReview {
  by: string;
  head: string;
  at: string;
  approve: boolean;
  note?: string;
  findings?: Finding[];   // the reviewer's findings, when the server sends them
  tier?: boolean;
  topTier?: boolean;
  withdrawn?: unknown;   // set when the task's acceptance criteria changed after it; it never answers
}

// What the wait decided: the verdict that ends it, the tier approvals seen
// on the way (said to the one waiting, never counted), or nothing yet.
export interface LandingVerdict {
  verdict: LandingReview | null;
  tierApprovals: LandingReview[];
}

export function landingVerdict(reviews: LandingReview[], head: string, since: string): LandingVerdict {
  const fresh = (reviews ?? []).filter((v) => v && v.head === head && !v.withdrawn && Date.parse(v.at) >= Date.parse(since));
  const tierApprovals = fresh.filter((v) => v.tier && v.approve);
  // Any rejection among the fresh verdicts decides, whatever came after it:
  // a tier rejection and the gate's approval that arrive between two polls
  // leave the task rejected on the server.
  const counted = fresh.filter((v) => !(v.tier && v.approve));
  const verdict = counted.find((v) => !v.approve) ?? counted.at(-1) ?? null;
  return { verdict, tierApprovals };
}

// What a rejection says (t143): the reviewer's note and, when the server sent
// the findings, each blocking one with its place, so the landing that stops on
// it prints what blocks and not only that something does. Without findings it
// is the note alone, as before.
export function rejectionText(v: Pick<LandingReview, "note" | "findings">): string {
  const blocking = (v.findings ?? []).filter((f) => f && f.severity === "blocking");
  const note = v.note || (blocking.length ? "" : "(no note)");
  if (!blocking.length) return note;
  const list = blocking.map((f) => `${f.file}${f.line ? `:${f.line}` : ""} ${f.text}`.trim()).join("; ");
  return `${note ? `${note} ` : ""}Blocking: ${list}`;
}

// Whether the owner may accept the task as it stands: submitted, with the
// gate ready. It is `atelier show`'s "accept" recommendation (src/brief.ts),
// and the landing reads the same before it asks for a review (t628), so the
// two never disagree about a review already recorded.
export function readyToAccept(d: { item: { state: string }; gate?: { ready: boolean } | null }): boolean {
  return d.item.state === "submitted" && d.gate?.ready === true;
}

// The approval a landing counts without asking for a review (t628): the task
// is ready to accept at the head it landed, and the gate counts an approval
// there as the change's independent review (gateApprovals, the gate's own
// selection, never a copy of it), the named reviewer's where the landing
// names one. micahapp t6 and t7 each held such an approval, recorded by hand
// against a claimed review request (atelier review --request N), while
// `atelier show` recommended accept; the landing asked for a new review
// instead, counted only verdicts given after that ask, and waited its 60
// minutes for one that never came. An approval the gate sets aside (one the
// developer token recorded answering no claimed request, a same-family or a
// contributor's) is never taken, even where another reviewer's approval, an
// unprotected change or an override makes the gate ready. Null when nothing
// recorded settles it, so the landing asks as before.
export interface RecordedDetail {
  item: Item;
  policy: ProjectPolicy;
  evidence?: Evidence[] | null;
  reviews?: Review[] | null;
  gate?: { ready: boolean } | null;
  ownerActor?: string | null;
}

export function recordedApproval(d: RecordedDetail, head: string, reviewer: string | null): Review | null {
  if (d.item.head !== head || !readyToAccept(d)) return null;
  const counted = gateApprovals(d.item, d.policy, d.evidence ?? [], d.reviews ?? [], d.ownerActor ?? DEFAULT_OWNER);
  return counted.filter((v) => reviewer === null || sameActor(v.by, reviewer)).at(-1) ?? null;
}

// How many more independent approvals the gate needs at the head under the
// project's riskReviews (t143), counted as the gate counts them (gateApprovals,
// one per model, and a separate tier approval never among them). Zero for a
// project without riskReviews, whose landing asks as before, and for a head
// that is not the one given.
export function approvalsMissing(d: RecordedDetail, head: string): number {
  if (d.item.head !== head || !d.policy.riskReviews) return 0;
  const owner = d.ownerActor ?? DEFAULT_OWNER;
  const paths = evidenceAt(d.policy, d.evidence ?? [], head).changedPaths;
  const need = approvalsNeeded(d.policy, paths === null ? null : changeClass(paths, d.policy), paths);
  return Math.max(0, need.count - gateApprovals(d.item, d.policy, d.evidence ?? [], d.reviews ?? [], owner).length);
}

// Whether a review request will ever be claimed, by which runners have
// skipped it (t353). A runner that will not serve a review reports its skip
// (recordReviewSkip in src/ledger.ts, review-skip in src/index.ts); a
// landing waiting on the verdict asks here, once a poll, whether every
// runner that offers the reviewer for the review job has skipped, so it can
// say so by runner name instead of waiting out the hour.
export function allSkipped(reviewer: string, offers: readonly SeenOffer[], skips: readonly { runner: string }[]): string[] | null {
  const names = offering({ to: "home", job: "review" } as const, offers)?.actors.get(reviewer.toLowerCase()) ?? [];
  if (!names.length) return null;
  const skipped = new Set(skips.map((s) => s.runner));
  const left = names.filter((name) => !skipped.has(name));
  return left.length ? null : names;
}

// Whether the review a landing waits on can still come (t574). With no
// verdict at the head, the wait goes on only while a gate request at that
// head is open or claimed and its reviewer has given no reply the server
// could not read since the landing asked. t573 at cc688bac waited 62 minutes
// on opencode/glm-5.3, whose replies carried no VERDICT line: each one
// released the claim and asked the same reviewer again, so nothing the
// landing read ever changed until its hour ran out. A reply with no readable
// verdict ends the wait at once, naming its reviewer; no live request at all
// ends it too, since nothing would ever answer it. `live` is the live gate
// request as liveReviewRequest reads it, read before the verdicts, so a
// verdict that closed the request is seen with it.
export interface LandingUnparsable {
  by: string;
  head: string;
  at: string;
  note?: string;
  // t613: false for a reply that released no claim (a late one from a claim
  // that had lapsed). Absent on replies kept before it, which count.
  request?: number;
  released?: boolean;
}

export type ReviewStall = { kind: "unparsable"; by: string; note: string } | { kind: "no_request" };

export function reviewStall(head: string, since: string, reviewer: string | null, live: { reviewer: string } | null, unparsable: readonly LandingUnparsable[]): ReviewStall | null {
  const asked = reviewer?.toLowerCase() ?? null;
  const bad = (unparsable ?? []).filter((u) => u && u.head === head && Date.parse(u.at) >= Date.parse(since) && !(u.request !== undefined && u.released !== true) && (asked === null || u.by.toLowerCase() === asked)).at(-1);
  if (bad) return { kind: "unparsable", by: bad.by, note: bad.note ?? "" };
  if (!live) return { kind: "no_request" };
  return null;
}

// The builder's passing checks a landing may reuse instead of running them on
// the merged tree again (t520). Every required check that applies must have
// its latest run at the head observed and passed, as an ordinary run (never a
// merged one) whose receipt is complete, names the check's command and the
// project's preparation as they are now, and shares one base, the merge base
// of the head with main when the builder checked. Answers that base and the
// paths the task touches (the paths measured at the head), or why not.
export type ReusableChecks = { ok: true; base: string; touched: string[]; evidence: number[]; commands: string[] } | { ok: false; why: string };
export function reusableChecks(policy: ProjectPolicy, evidence: Evidence[], head: string): ReusableChecks {
  const view = evidenceAt(policy, evidence, head);
  if (view.changedPaths === null) return { ok: false, why: "the paths the task touches were never measured at this head" };
  if (!view.checks.length) return { ok: false, why: "no required check applies to this change" };
  const preparation = preparationBinding(policy.prepare);
  const bases = new Set<string>(), ids: number[] = [];
  for (const { claim } of view.checks) {
    const run = countingRunsAt(policy, evidence, head, claim).pop() as (Evidence & { id?: number; reuse?: unknown }) | undefined;
    if (!run || run.grade !== "observed" || run.passed !== true || run.notApplicable) return { ok: false, why: `\`${claim}\` has no passing observed run at this head` };
    const reuse = run.reuse;
    if (!completeBinding(reuse) || reuse.mode !== "ordinary" || reuse.head !== head || reuse.command !== claim) return { ok: false, why: `\`${claim}\` has no complete receipt for an ordinary run at this head` };
    if (reuse.preparation !== preparation) return { ok: false, why: `the checks' preparation changed since \`${claim}\` ran` };
    bases.add(reuse.base);
    if (typeof run.id === "number") ids.push(run.id);
  }
  if (bases.size !== 1) return { ok: false, why: "the passing runs were made against different bases" };
  return { ok: true, base: [...bases][0], touched: view.changedPaths, evidence: ids, commands: view.checks.map((c) => c.claim) };
}

// Whether the builder's checks stand for the merged tree: main has moved no
// path the task touches since their base. `moved` is the paths main changed
// from that base to the main the merge was made on, or null when they could
// not be read, which reuses nothing. Paths compare as a Mac stores them.
export function reuseVerdict(found: ReusableChecks, moved: readonly string[] | null): { reuse: boolean; why: string; touching: string[] } {
  if (!found.ok) return { reuse: false, why: found.why, touching: [] };
  if (moved === null) return { reuse: false, why: "the paths main moved since the builder's checks could not be read", touching: [] };
  const mine = new Set(found.touched.map(foldPath));
  const touching = moved.filter((p) => mine.has(foldPath(p)));
  return touching.length
    ? { reuse: false, why: `main moved ${touching.length} path${touching.length === 1 ? "" : "s"} the task touches since the builder's checks (${touching.slice(0, 5).join(", ")}${touching.length > 5 ? ", …" : ""})`, touching }
    : { reuse: true, why: `main moved ${moved.length} path${moved.length === 1 ? "" : "s"} since the builder's checks, none that the task touches`, touching };
}
