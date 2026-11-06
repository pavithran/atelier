// atelier show. Its forms, flags and help are declared in src/usage/commands/show.ts.
import { effectiveFailures, failureJson, failureSummary, resolveFailures } from "../../src/check-failure.ts";
import { I, OWNER, RequestError, actor, args, call, die, flat, formatBrief, formatCriteriaReviews, formatReviews, itemArg, logReader, newestReviews, project, request, server } from "../atelier.mjs";
import { stageText } from "../status.mjs";
import { checkLimits, limitText } from "../../src/check-limit.ts";
import { stageOf } from "../../src/rules.ts";
import { queueReasons } from "../status.mjs";
import { fenceText, PREREVIEW_JOB, prereviewLines } from "../../src/dispatch/prereview.ts";
import { deployText } from "../../src/checkout-lease.ts";
import { progressView } from "../../src/situation.ts";
import { lastRunText, progressText } from "../situation.mjs";

export default async function showCommand() {
  const name = project(), id = itemArg(), as = await actor(OWNER);
  const brief = await call("GET", `${I(name, id)}/brief`, undefined, as);
  // The brief sums the reviews at the current head into one line and carries
  // none of their findings. The item's own record holds every review at
  // every head; --reviews prints it in full and --json carries it, so a
  // session can read why a review rejected the task (t173).
  let d = {};
  try { d = await request("GET", I(name, id), undefined, as); }
  catch (error) {
    // Older servers may serve the brief without the detail route. Keep
    // that brief usable, but do not conceal authentication or server errors.
    if (!(error instanceof RequestError)) throw error;
    if (error.code !== 1 || error.message !== "not_found: no such route") die(error.message, error.code);
  }
  // Revert requests are historical links, not proof that the undo merged.
  // Keep them outside the server brief's five-line evidence limit.
  for (const event of d.events ?? []) {
    if (event.itemId !== id || !["item.reverts", "item.revert_requested"].includes(event.kind)) continue;
    const { itemId, mergeCommit } = event.data ?? {};
    if (!/^t[1-9]\d*$/.test(itemId ?? "") || !/^[a-f0-9]{40,64}$/.test(mergeCommit ?? "")) continue;
    const label = event.kind === "item.reverts" ? "Reverts" : "Revert requested in";
    brief.evidence.push(`${label} ${itemId} (recorded merge ${mergeCommit}): ${server()}/p/${encodeURIComponent(name)}/${itemId}`);
  }
  // Why a dispatched task is not being taken, as the queue holds it (t420):
  // each reason in words and the command that releases it. Read from the
  // queue's entry for it, so `show` and `status` say the same thing. A
  // review or pre-review request of the task (t524) is not its build.
  let why = [], queued = null;
  try {
    const entry = ((await request("GET", "/queue", undefined, as)) ?? [])
      .find((q) => q.project === name && q.item?.id === id && q.item.dispatch?.job !== "review" && q.item.dispatch?.job !== PREREVIEW_JOB);
    why = entry ? queueReasons(entry.item) : [];
    queued = entry?.item ?? null;
  } catch { /* the brief still prints; the queue's reason is a bonus */ }
  // The failed checks at the current head, as the gate reads them (t436,
  // src/check-failure.ts): each named by command, head and evidence id,
  // with the failing tests its reporter named and a bounded tail of its
  // log, the stored whole log read by reference where the run kept one.
  // `failedChecks` carries the same in --json.
  const failures = d.item?.head && d.policy?.checks
    ? await resolveFailures(effectiveFailures(d.policy, d.evidence ?? [], d.item.head), logReader(name, id, as))
    : [];
  // The newest pre-review of the task (t524) and the fence a blocking one
  // left on its landing: state, binding, reviewer, findings and recovery.
  const prereview = d.prereviews?.[0] ?? null, fence = d.prereviewFence ?? null;
  // What the developer wrote when filing the task (its --brief): the server's
  // decision brief carries the title and criteria but not this text, which
  // only `start` printed, and `start` claims the task. Absent when the task
  // has none or the server sends no detail (t710).
  const filed = typeof d.item?.brief === "string" && d.item.brief ? d.item.brief : null;
  // The stage is stageOf's, from the task's own record; a server that sends
  // no detail leaves none.
  const stage = d.item ? stageOf(d.item, { events: d.events?.filter((e) => e.itemId === id), policy: d.policy, evidence: d.evidence, reviews: d.reviews }) : null;
  // The project's check limit (G7), as the server's policy sets it: every
  // check of the task, by `atelier check`, a landing or a runner, goes by it.
  const limit = d.policy ? checkLimits(d.policy) : null;
  // The project's newest deploy, as atelier ship recorded it, shipped or
  // failed (G9); every one is a ship.recorded event (atelier events).
  const deploy = d.lastDeploy ?? null;
  // The acts made with the developer token on a model's word (G18): each
  // event naming its acting harness/model, with the developer's words where
  // the verb needs them.
  const acted = actedThroughOwner(d.events ?? [], id);
  // The build's progress line (G21), as its runner last reported it, with the
  // task's newest check.
  const progress = d.progress ? progressView(d.progress, new Date()) : null;
  const lastCheck = (d.evidence ?? []).filter((e) => e.grade === "observed").at(-1) ?? null;
  // The goal's notes, numbered as atelier file-fix takes them, and the review
  // requests nobody has claimed, with when each was asked (G6): facts the
  // model acts on by command, since the server files and re-points nothing.
  const notes = d.notes ?? [], unclaimed = d.openRequests ?? [], tier = d.tierReview ?? null, lapsed = d.lapsedRequests ?? [];
  if (args.json) return console.log(JSON.stringify({ ...(d.item ? taskJson(d, queued, why) : {}), ...(lapsed.length ? { lapsedRequests: lapsed } : {}), ...(tier ? { tierReview: tier } : {}), ...(notes.length ? { notes } : {}), ...(unclaimed.length ? { openRequests: unclaimed } : {}), ...brief, ...(acted.length ? { acted } : {}), ...(stage ? { stage } : {}), ...(limit ? { checkLimit: { ...limit, checkSilence: d.policy.checkSilence ?? [] } } : {}), ...(filed ? { brief: filed } : {}), reviews: newestReviews(d?.reviews ?? []), unparsable: newestReviews(d?.unparsable ?? []), ...(d?.reviewClaims?.length ? { reviewClaims: d.reviewClaims } : {}), failedChecks: failures.map(failureJson), ...(d?.criteriaReview ? { criteriaReview: d.criteriaReview } : {}), ...(why.length ? { why } : {}), ...(prereview ? { prereview } : {}), ...(fence ? { prereviewFence: fence } : {}), ...(deploy ? { lastDeploy: deploy } : {}), ...(d.landing ? { landing: d.landing } : {}), ...(progress ? { progress } : {}), ...(d.lastRun ? { lastRun: d.lastRun } : {}) }, null, 2));
  const blocks = [formatBrief(name, id, brief, server())];
  blocks.push(...repairLines(d.repairs));
  if (stage) blocks.push(`Stage: ${stageText(stage)}`);
  // The tasks it waits on (G3), each with its state: it is not offered,
  // claimed or accepted until every one is merged.
  if (d.blockers?.length) blocks.push(`Blocked by: ${d.blockers.map((b) => `${b.id} (${b.state})`).join(", ")}${d.blockers.every((b) => b.state === "merged") ? "; every one is merged" : d.blockers.some((b) => b.state === "abandoned") ? `; an abandoned blocker never merges, so it waits until the developer drops it: atelier edit ${id} --blocked-by` : "; it waits until each is merged"}`);
  if (filed) blocks.push(`Brief: ${flat(filed)}`);
  if (limit) blocks.push(`Check limit: ${limitText(d.policy)}`);
  if (why.length) blocks.push(why.map((r) => r.line).join("\n"));
  if (prereview || fence) blocks.push([...(prereview ? prereviewLines(prereview) : []), ...(fence ? [`Fenced: ${fenceText(id, fence)}`] : [])].join("\n"));
  if (failures.length) blocks.push(failureSummary(id, d.item.head, failures));
  // The landing record (G1): the step its latest attempt reached, and where
  // it failed, with the last lines of the failing step's own output.
  if (d.landing) blocks.push(`Landing: attempt ${d.landing.attempt}, ${d.landing.failedStep ? `failed at ${d.landing.failedStep}${d.landing.files?.length ? ` (${d.landing.files.map(flat).join(", ")})` : ""}` : `at ${d.landing.step}`}, ${String(d.landing.at).slice(0, 16).replace("T", " ")} UTC${d.landing.failedStep && d.landing.tail ? `\n  ${String(d.landing.tail).split("\n").map(flat).join("\n  ")}` : ""}`);
  if (d.lastRun) blocks.push(`Last run: ${lastRunText(d.lastRun)}`);
  if (progress) blocks.push(`Progress: ${progressText(progress, lastCheck)}${progress.stall ? `\n  STALL: ${progress.stall}` : ""}`);
  if (deploy) blocks.push(`Last deploy: ${deployText(deploy)}`);
  if (tier) blocks.push(tierLine(id, tier));
  // A claim that ended with no verdict is a fact (G6, G11): its lease lapsed,
  // its runner released it, or its reply held no readable verdict. Nothing
  // asks again by itself.
  if (lapsed.length) blocks.push(lapsed.map((r) => endedLine(id, r)).join("\n"));
  if (unclaimed.length) blocks.push(unclaimed.map((r) => unclaimedLine(id, r)).join("\n"));
  if (notes.length) blocks.push(["Notes (atelier file-fix " + id + " --from-note N files one):", ...notes.map(noteLine)].join("\n"));
  if (acted.length) blocks.push(["Acts on the developer token:", ...acted.map(actedLine)].join("\n"));
  if (args.reviews) blocks.push(formatReviews(d?.reviews ?? [], d?.ownerActor, d?.unparsable ?? [], d?.reviewClaims ?? []));
  if (args.reviews && d?.criteriaReview) blocks.push(formatCriteriaReviews(d.criteriaReview));
  console.log(blocks.join("\n\n"));
}

// The task's events that name an acting model (G18), oldest first: who the
// event is recorded under, the model acting and, for a verb that needs the
// developer's words, those words.
export function actedThroughOwner(events, id) {
  return events
    .filter((e) => e.itemId === id && typeof e.data?.acting === "string" && e.data.acting)
    .map((e) => ({ seq: e.seq, at: e.at, kind: e.kind, actor: e.actor, acting: e.data.acting, ...(typeof e.data.quote === "string" && e.data.quote ? { quote: e.data.quote } : {}) }))
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

export function actedLine(a) {
  return `  ${String(a.at ?? "").slice(0, 16).replace("T", " ")} ${a.kind} by ${flat(a.actor)}, acting ${flat(a.acting)}${a.quote ? `, on the developer's words: \u201c${flat(a.quote)}\u201d` : ""}`;
}

// The task's own fields under the key names `ls --json` uses (G4): id,
// state, owner, head and its times, with scope, dispatch, runner, the holds
// the queue keeps it under and its last failure. A merged or abandoned task
// answers the same.
export function taskJson(d, queued = null, why = []) {
  const i = d.item;
  const held = queued?.held ? (queued.held.blockers ?? [queued.held]).map((b) => ({ kind: "core-file", blocker: b.id, state: b.state, owner: b.owner, file: b.core, since: queued.held.since ?? null })) : [];
  // Each task it waits on that is not merged (G3) holds it too.
  const waits = (d.blockers ?? []).filter((b) => b.state !== "merged").map((b) => ({ kind: "blocked-by", blocker: b.id, state: b.state }));
  return {
    ...(d.repairs ? { repairs: d.repairs } : {}),
    id: i.id, title: i.title, state: i.state, owner: i.owner, head: i.head, createdAt: i.createdAt, updatedAt: i.updatedAt, lastPushAt: i.lastPushAt,
    scope: i.scope, dispatch: i.dispatch ?? null, runner: i.runner ?? null, holds: [...held, ...waits], lastFailure: lastFailureOf(d),
    ...(d.blockers?.length ? { blockedBy: d.blockers.map((b) => ({ id: b.id, state: b.state })) } : {}),
    // G4 2a: why a dispatched task is not taken, each reason with its kind
    // (held, overlap, refused, skipped, unoffered, busy, elsewhere); where
    // the task stands toward a dispatch; the approvals at each head, carried
    // across a merge of main or not, and why; the developer's standing go.
    unclaimed: why.map((r) => ({ kind: r.kind, line: r.line })),
    dispatchState: dispatchStateOf(d),
    approvals: approvalsByHead(d),
    standingGo: standingGoOf(d),
  };
}

export function repairLines(repairs) {
  return [
    ...(repairs?.fixes ? [`Fixes: ${flat(repairs.fixes)}`] : []),
    ...(repairs?.fixedBy?.length ? [`Fixed by: ${repairs.fixedBy.map(flat).join(", ")}`] : []),
  ];
}

// The newest failure recorded of the task: a failed or stopped observed
// check, or a landing that failed at a step. Null when none is recorded.
export function lastFailureOf(d) {
  const checks = (d.evidence ?? []).filter((e) => e.grade === "observed" && e.passed === false)
    .map((e) => ({ kind: "check", claim: e.claim, head: e.head, at: e.at, ...(e.stopped ? { stopped: e.stopped } : {}) }));
  const landing = d.landing?.failedStep ? [{ kind: "landing", step: d.landing.failedStep, head: d.landing.head ?? null, at: d.landing.at }] : [];
  return [...checks, ...landing].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] ?? null;
}

// Where an open task stands toward a dispatch: queued, "approved, not
// dispatched" once a review approved its acceptance criteria, or not
// dispatched. Null for a task past open.
export function dispatchStateOf(d) {
  const i = d.item;
  if (i.state !== "open") return null;
  if (i.dispatch) return "dispatched";
  return d.criteriaReview?.status?.approved ? "approved, not dispatched" : "not dispatched";
}

// The verdicts standing at each head the task has had, newest head first:
// each reviewer's latest, who approved and who rejected, which approvals
// were carried to the head across a merge of main (from which head, and
// why), and the merges that carried none (review.not_retained, and why).
export function approvalsByHead(d) {
  const reviews = (d.reviews ?? []).filter((r) => !r.withdrawn).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const heads = [...new Set(reviews.map((r) => r.head))];
  const out = heads.map((head) => {
    const latest = new Map();
    for (const r of reviews.filter((x) => x.head === head)) latest.set(r.by, r);
    const standing = [...latest.values()];
    const at = reviews.filter((x) => x.head === head).at(-1)?.at ?? null;
    return {
      head, current: head === d.item.head, since: at,
      approvedBy: standing.filter((r) => r.approve).map((r) => r.by),
      rejectedBy: standing.filter((r) => !r.approve).map((r) => r.by),
      carried: standing.filter((r) => r.retained).map((r) => ({ by: r.by, from: r.retained.oldHead ?? r.retained.from?.head ?? null, reason: r.retained.reason ?? null })),
      notCarried: (d.events ?? []).filter((e) => e.kind === "review.not_retained" && e.data?.from === head)
        .map((e) => ({ to: e.data.head ?? null, approvals: e.data.approvals ?? [], reason: e.data.reason ?? null, at: e.at })),
    };
  });
  return out.reverse();
}

// The go the developer has given that stands for this task: a landing asked
// for (atelier land --queue) with their words, the page's permission for a
// command-line override at one head, and fast mode with its words. Null for
// each that stands not.
export function standingGoOf(d) {
  return {
    landing: d.landJob ?? null,
    overrideConfirmation: d.item.overrideConfirmation ?? null,
    fastMode: d.mode?.mode === "fast" ? d.mode.line ?? "fast" : null,
  };
}

// One review request nobody has claimed: whom it asks, since when and how
// long ago, and the commands that withdraw it or ask another (G6).
export function unclaimedLine(id, r, now = Date.now()) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(r.openedAt)) / 60_000));
  const age = minutes < 60 ? `${minutes} minute${minutes === 1 ? "" : "s"}` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  return `Review request ${r.request}${r.tier ? " (the tier's)" : ""} asked of ${flat(r.reviewer)} at ${String(r.head).slice(0, 8)} is unclaimed, asked ${String(r.openedAt).slice(0, 16).replace("T", " ")} UTC, ${age} ago; withdraw it with atelier review-withdraw ${id} --request ${r.request} --reason TEXT, or ask another with atelier review-request ${id} --reviewer H/M`;
}

// One goal note, numbered: where, what, who left it, and the task filed from it.
export function noteLine(n) {
  const where = n.file ? `${flat(n.file)}${n.line === null || n.line === undefined ? "" : `:${n.line}`}: ` : "";
  return `  ${n.n}. ${n.blocking ? "[blocking] " : ""}${where}${flat(n.text)} (${flat(n.by)} at ${String(n.head).slice(0, 8)})${n.filed ? `; filed as ${n.filed}` : ""}`;
}

// A separate tier review the change needs and nobody has asked (G17): its
// candidates, each refused one with why, and the command that asks it.
export function tierLine(id, t) {
  const eligible = t.candidates.filter((c) => !c.refusal).map((c) => flat(c.actor));
  const refused = t.candidates.filter((c) => c.refusal).map((c) => `${flat(c.actor)} (${flat(c.refusal)})`);
  return `Tier review needed at ${String(t.head).slice(0, 8)} beside ${flat(t.gate)}'s gate review; candidates: ${eligible.join(", ") || "none"}${refused.length ? `; refused: ${refused.join(", ")}` : ""}. Ask it with atelier review-request ${id} --reviewer H/M --tier-review`;
}

// One review request whose claim ended with no verdict, and how to ask again.
export function endedLine(id, r) {
  const when = String(r.at ?? "").slice(0, 16).replace("T", " ");
  const what = r.state === "lapsed" ? `claim by ${flat(r.claimedBy)} lapsed at ${when} UTC`
    : r.state === "no_verdict" ? `${flat(r.claimedBy)} replied with no readable verdict at ${when} UTC (the reply is kept: atelier show ${id} --reviews)`
      : `released by ${flat(r.claimedBy)}'s runner at ${when} UTC${r.note ? `: ${flat(String(r.note).slice(0, 200))}` : ""}`;
  return `Review request ${r.request}${r.tier ? " (the tier's)" : ""}: ${what}; ask again with atelier review-request ${id} --reviewer ${flat(r.claimedBy)}${r.tier ? " --tier-review" : ""}, or name another`;
}
