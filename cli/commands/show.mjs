// atelier show. Its forms, flags and help are declared in src/usage/commands/show.ts.
import { effectiveFailures, failureJson, failureSummary, resolveFailures } from "../../src/check-failure.ts";
import { I, OWNER, RequestError, actor, args, call, die, flat, formatBrief, formatCriteriaReviews, formatReviews, itemArg, logReader, newestReviews, project, request, server } from "../atelier.mjs";
import { stageText } from "../status.mjs";
import { stageOf } from "../../src/rules.ts";
import { preparingLine, queueReasons } from "../status.mjs";
import { fenceText, PREREVIEW_JOB, prereviewLines } from "../../src/dispatch/prereview.ts";

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
  let why = [];
  try {
    const entry = ((await request("GET", "/queue", undefined, as)) ?? [])
      .find((q) => q.project === name && q.item?.id === id && q.item.dispatch?.job !== "review" && q.item.dispatch?.job !== PREREVIEW_JOB);
    why = entry ? queueReasons(entry.item) : [];
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
  if (args.json) return console.log(JSON.stringify({ ...brief, ...(stage ? { stage } : {}), ...(filed ? { brief: filed } : {}), reviews: newestReviews(d?.reviews ?? []), unparsable: newestReviews(d?.unparsable ?? []), ...(d?.reviewClaims?.length ? { reviewClaims: d.reviewClaims } : {}), failedChecks: failures.map(failureJson), ...(d?.criteriaReview ? { criteriaReview: d.criteriaReview } : {}), ...(why.length ? { why } : {}), ...(d.preparing ? { preparing: d.preparing } : {}), ...(prereview ? { prereview } : {}), ...(fence ? { prereviewFence: fence } : {}) }, null, 2));
  const blocks = [formatBrief(name, id, brief, server())];
  if (stage) blocks.push(`Stage: ${stageText(stage)}`);
  if (filed) blocks.push(`Brief: ${flat(filed)}`);
  if (why.length) blocks.push(why.map((r) => r.line).join("\n"));
  if (d.preparing) blocks.push(`Fork: ${preparingLine(d.preparing)}`);
  if (prereview || fence) blocks.push([...(prereview ? prereviewLines(prereview) : []), ...(fence ? [`Fenced: ${fenceText(id, fence)}`] : [])].join("\n"));
  if (failures.length) blocks.push(failureSummary(id, d.item.head, failures));
  if (args.reviews) blocks.push(formatReviews(d?.reviews ?? [], d?.ownerActor, d?.unparsable ?? [], d?.reviewClaims ?? []));
  if (args.reviews && d?.criteriaReview) blocks.push(formatCriteriaReviews(d.criteriaReview));
  console.log(blocks.join("\n\n"));
}
