// atelier show. Its forms, flags and help are declared in src/usage/commands/show.ts.
import { effectiveFailures, failureJson, failureSummary, resolveFailures } from "../../src/check-failure.ts";
import { I, OWNER, RequestError, actor, args, call, die, flat, formatBrief, formatCriteriaReviews, formatReviews, itemArg, logReader, newestReviews, project, request, server } from "../atelier.mjs";
import { stageText } from "../status.mjs";
import { checkLimits, limitText } from "../../src/check-limit.ts";
import { stageOf } from "../../src/rules.ts";
import { preparingLine, queueReasons } from "../status.mjs";
import { fenceText, PREREVIEW_JOB, prereviewLines } from "../../src/dispatch/prereview.ts";
import { deployText } from "../../src/checkout-lease.ts";

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
  if (args.json) return console.log(JSON.stringify({ ...(d.item ? taskJson(d, queued) : {}), ...brief, ...(acted.length ? { acted } : {}), ...(stage ? { stage } : {}), ...(limit ? { checkLimit: { ...limit, checkSilence: d.policy.checkSilence ?? [] } } : {}), ...(filed ? { brief: filed } : {}), reviews: newestReviews(d?.reviews ?? []), unparsable: newestReviews(d?.unparsable ?? []), ...(d?.reviewClaims?.length ? { reviewClaims: d.reviewClaims } : {}), failedChecks: failures.map(failureJson), ...(d?.criteriaReview ? { criteriaReview: d.criteriaReview } : {}), ...(why.length ? { why } : {}), ...(d.preparing ? { preparing: d.preparing } : {}), ...(prereview ? { prereview } : {}), ...(fence ? { prereviewFence: fence } : {}), ...(deploy ? { lastDeploy: deploy } : {}), ...(d.landing ? { landing: d.landing } : {}) }, null, 2));
  const blocks = [formatBrief(name, id, brief, server())];
  if (stage) blocks.push(`Stage: ${stageText(stage)}`);
  // The tasks it waits on (G3), each with its state: it is not offered,
  // claimed or accepted until every one is merged.
  if (d.blockers?.length) blocks.push(`Blocked by: ${d.blockers.map((b) => `${b.id} (${b.state})`).join(", ")}${d.blockers.every((b) => b.state === "merged") ? "; every one is merged" : d.blockers.some((b) => b.state === "abandoned") ? `; an abandoned blocker never merges, so it waits until the developer drops it: atelier edit ${id} --blocked-by` : "; it waits until each is merged"}`);
  if (filed) blocks.push(`Brief: ${flat(filed)}`);
  if (limit) blocks.push(`Check limit: ${limitText(d.policy)}`);
  if (why.length) blocks.push(why.map((r) => r.line).join("\n"));
  if (d.preparing) blocks.push(`Fork: ${preparingLine(d.preparing)}`);
  if (prereview || fence) blocks.push([...(prereview ? prereviewLines(prereview) : []), ...(fence ? [`Fenced: ${fenceText(id, fence)}`] : [])].join("\n"));
  if (failures.length) blocks.push(failureSummary(id, d.item.head, failures));
  // The landing record (G1): the step its latest attempt reached, and where
  // it failed, with the last lines of the failing step's own output.
  if (d.landing) blocks.push(`Landing: attempt ${d.landing.attempt}, ${d.landing.failedStep ? `failed at ${d.landing.failedStep}${d.landing.files?.length ? ` (${d.landing.files.map(flat).join(", ")})` : ""}` : `at ${d.landing.step}`}, ${String(d.landing.at).slice(0, 16).replace("T", " ")} UTC${d.landing.failedStep && d.landing.tail ? `\n  ${String(d.landing.tail).split("\n").map(flat).join("\n  ")}` : ""}`);
  if (deploy) blocks.push(`Last deploy: ${deployText(deploy)}`);
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
export function taskJson(d, queued = null) {
  const i = d.item;
  const held = queued?.held ? (queued.held.blockers ?? [queued.held]).map((b) => ({ kind: "core-file", blocker: b.id, state: b.state, owner: b.owner, file: b.core, since: queued.held.since ?? null })) : [];
  // Each task it waits on that is not merged (G3) holds it too.
  const waits = (d.blockers ?? []).filter((b) => b.state !== "merged").map((b) => ({ kind: "blocked-by", blocker: b.id, state: b.state }));
  return {
    id: i.id, title: i.title, state: i.state, owner: i.owner, head: i.head, createdAt: i.createdAt, updatedAt: i.updatedAt, lastPushAt: i.lastPushAt,
    scope: i.scope, dispatch: i.dispatch ?? null, runner: i.runner ?? null, holds: [...held, ...waits], lastFailure: lastFailureOf(d),
    ...(d.blockers?.length ? { blockedBy: d.blockers.map((b) => ({ id: b.id, state: b.state })) } : {}),
  };
}

// The newest failure recorded of the task: a failed or stopped observed
// check, or a landing that failed at a step. Null when none is recorded.
export function lastFailureOf(d) {
  const checks = (d.evidence ?? []).filter((e) => e.grade === "observed" && e.passed === false)
    .map((e) => ({ kind: "check", claim: e.claim, head: e.head, at: e.at, ...(e.stopped ? { stopped: e.stopped } : {}) }));
  const landing = d.landing?.failedStep ? [{ kind: "landing", step: d.landing.failedStep, head: d.landing.head ?? null, at: d.landing.at }] : [];
  return [...checks, ...landing].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] ?? null;
}
