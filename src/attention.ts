// What waits on the project owner, and what the pipeline carries (t504). One
// pure rule places each live task once: either as the owner's own call, which
// takes precedence, or at its t456 pipeline stage (taskStage in board.ts).
// Home, a project's Overview, the Decisions page, `atelier status` and
// `atelier inbox` all read this placement, so they agree per project and count
// tasks, never the notices a task carries. docs/owner.md holds the table.
//
// Inputs are what a view read at one moment: the project's items, its inbox
// entries (inboxFor and the Ledger's plan and ship entries), the runner offers
// and the time. A part not read is null, and the placement says what it could
// not tell in `unknown` instead of counting it as nothing.

import { taskStage, type Stage } from "./board.ts";
import { unoffered, type SeenOffer } from "./dispatch/rules.ts";
import type { InboxEntry, Item } from "./rules.ts";

// The owner's calls, in precedence order: a task that qualifies for two is
// placed under the first. A flagged secret comes before everything, since
// nothing else may proceed past it; a block before the plan's and the
// revision's decisions, since it stops them; a merged task's protected
// actions and a dispatch no runner can take come last, as the work is done
// or the fix is outside the task. A protected change no qualifying reviewer
// can review (its assess notice names no reviewer from the pool) waits on the
// owner's override, or on the owner starting a reviewer that qualifies, so it
// comes after the acceptance it stands in for.
export const OWNER_CALLS = ["clear-secret", "unblock", "decide-plan", "approve-plan", "accept", "override", "ship", "start-runner"] as const;
export type OwnerCall = typeof OWNER_CALLS[number];

export const OWNER_CALL_LABEL: Record<OwnerCall, string> = {
  "clear-secret": "Clear secret flag",
  unblock: "Unblock",
  "decide-plan": "Decide plan",
  "approve-plan": "Approve plan",
  accept: "Accept",
  override: "No reviewer",
  ship: "Ship",
  "start-runner": "No runner",
};

export interface OwnerTask {
  id: string;
  title: string;
  call: OwnerCall;
  // What to do, in one sentence, and where it is done: the task page carries
  // each call's form (t474 performs it), Ship carries the protected actions.
  sentence: string;
  href: string;
  // The command that does it from a checkout, where there is one.
  command: string | null;
  // The notice behind the call, in the server's own words.
  why: string;
  // The kinds of the notices the task carries, each once, sorted.
  notices: InboxEntry["kind"][];
}

// The fields an owner task carried before t504, which older clients of
// /standing and of `atelier inbox --json` read: the notice kind the call
// answers (the call's own kind where the task carries that notice), every
// notice kind on the task, and the notice's words. Kept beside the call as
// aliases, not as a second rule.
const LEGACY_KIND: Record<OwnerCall, InboxEntry["kind"]> = {
  "clear-secret": "blocked", unblock: "blocked", "decide-plan": "plan-blocked", "approve-plan": "approve-plan",
  accept: "accept", override: "assess", ship: "ship", "start-runner": "blocked",
};
export interface LegacyFields { kind: InboxEntry["kind"]; kinds: InboxEntry["kind"][]; reason: string }
export function legacyFields(t: OwnerTask): LegacyFields {
  const kind = LEGACY_KIND[t.call];
  return { kind, kinds: t.notices.length ? t.notices : [kind], reason: t.why };
}

export interface PipelineTask {
  id: string;
  title: string;
  stage: Stage;
  // The kinds of the notices the task carries (assess, merge, failing, scope,
  // stale, overlap), each once: what the orchestrator and reviewers act on.
  notices: InboxEntry["kind"][];
}

export interface Attention {
  project: string;
  owner: OwnerTask[];
  pipeline: PipelineTask[];
  // Each unordered pair of live tasks whose scopes overlap, once, sorted.
  overlaps: [string, string][];
  // What could not be read or told, in words. Empty when the placement is whole.
  unknown: string[];
}

const RANK = new Map<OwnerCall, number>(OWNER_CALLS.map((c, i) => [c, i]));
const TERMINAL = new Set(["merged", "abandoned", "integrated"]);
const path = (...p: string[]) => "/" + p.map(encodeURIComponent).join("/");
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// The flags a push scan left standing at the task's head, which only the
// owner clears (t332). A scan still pending is retried on its own.
function standingSecrets(item: Item): string[] {
  return (item.secret ?? []).filter((f) => f.head === item.head && !f.cleared).map((f) => f.file);
}

function runnerFor(item: Item): string {
  const d = item.dispatch!;
  const who = [d.agent, d.model].filter(Boolean).join("/");
  return `${who || "any agent"} on ${d.to === "any" ? "any runner" : `a ${d.to} runner`}`;
}

// One task's placement. `notices` are the inbox entries naming the task;
// `noRunner` is unoffered's word on its queued dispatch: a reason when no live
// runner can take it, null when one can, undefined when the offers were not
// read. A terminal task with no ship notice is placed nowhere (null).
export function placeTask(project: string, item: Item, notices: readonly InboxEntry[], noRunner?: string | null): OwnerTask | PipelineTask | null {
  const has = (kind: InboxEntry["kind"]) => notices.find((x) => x.kind === kind);
  const page = path("p", project, item.id);
  const flag = ` --project ${project}`;
  const kinds = [...new Set(notices.map((x) => x.kind))].sort();
  const own = (call: OwnerCall, sentence: string, command: string | null, why: string, href = page): OwnerTask =>
    ({ id: item.id, title: item.title, call, sentence, href, command, why, notices: kinds });
  if (TERMINAL.has(item.state)) {
    const ship = has("ship");
    return ship ? own("ship", "Run the protected actions its merge declared: a dry run first, then approve and ship.", `atelier ship --dry-run${flag}`, ship.reason, path("p", project, "ship")) : null;
  }
  const secrets = standingSecrets(item);
  if (secrets.length) {
    return own("clear-secret", `Check the flagged line in ${[...new Set(secrets)].join(", ")} and clear the flag with a reason, or send the task back.`, null, `secret flagged at ${(item.head ?? "").slice(0, 8)}`);
  }
  if (item.state === "blocked" || item.blocked) {
    const b = item.blocked;
    return own("unblock", "Settle what blocks it, then unblock it so it goes on.", `atelier unblock ${item.id}${flag}`, `blocked by ${b?.by ?? "nobody"}: ${b?.reason ?? "no reason recorded"}`);
  }
  const planBlocked = has("plan-blocked");
  if (planBlocked) return own("decide-plan", "Read the blocked plan and decide how it goes on.", `atelier plan show ${item.id}${flag}`, planBlocked.reason);
  const proposed = has("approve-plan");
  if (proposed) return own("approve-plan", "Read the planner's split, then approve it by its hash or send it back with a note.", `atelier plan show ${item.id}${flag}`, proposed.reason);
  const ready = has("accept");
  // The owner's path for a submitted task is atelier land, which reviews,
  // accepts and merges it (t495).
  if (ready) return own("accept", "Accept the revision, whose required checks all passed at its head.", `atelier land ${item.id} --reviewer ${ready.reviewer ?? "H/M"}${flag}`, ready.reason);
  // An assess notice whose reviewer is null: the pool was read and offers no
  // reviewer that qualifies, so only the owner moves it. Undefined: the pool
  // was not read, and the task stays at its stage (attentionFor says so).
  const unreviewable = notices.find((x) => x.kind === "assess" && x.reviewer === null);
  // A project that forbids overrides refuses the override itself
  // (assertOverridesAllowed, override_forbidden), so it is never offered
  // there: the way on is a qualifying reviewer, landed with atelier land.
  if (unreviewable) {
    return /forbids overrides/.test(unreviewable.reason)
      ? own("override", "No reviewer in the pool qualifies for this protected change, and the project forbids overrides: start a runner offering a reviewer of another family than every contributor, then land the task with that reviewer.",
        `atelier land ${item.id} --reviewer H/M${flag}`, unreviewable.reason)
      : own("override", "No reviewer in the pool qualifies for this protected change: start a runner offering one, or allow an override on the task page and accept with a reason.",
        `atelier accept ${item.id} --override-review REASON${flag}`, unreviewable.reason);
  }
  const stage = taskStage(item, { ready: !!ready });
  if (stage === "queued" && typeof noRunner === "string") {
    return own("start-runner", `Start a runner that offers ${runnerFor(item)}, or send the task elsewhere.`, null, noRunner);
  }
  return { id: item.id, title: item.title, stage, notices: kinds };
}

export const isOwnerTask = (p: OwnerTask | PipelineTask): p is OwnerTask => "call" in p;

// The other task an overlap entry's reason names ("scope overlaps t186
// (owner)", as inboxFor words it), or null when worded another way or naming
// the entry's own item.
export function overlapOther(x: Pick<InboxEntry, "itemId" | "reason">): string | null {
  const other = /^scope overlaps (\S+) \(/.exec(x.reason)?.[1];
  return other && other !== x.itemId ? other : null;
}

// The unordered pairs of tasks whose scopes overlap, each pair once, sorted.
export function overlapPairs(entries: readonly InboxEntry[]): [string, string][] {
  const pairs = new Map<string, [string, string]>();
  for (const x of entries) {
    const other = x.kind === "overlap" ? overlapOther(x) : null;
    if (!other) continue;
    const pair = [x.itemId, other].sort() as [string, string];
    pairs.set(pair.join(" "), pair);
  }
  return [...pairs.values()].sort((p, q) => compare(p[0], q[0]) || compare(p[1], q[1]));
}

// The whole project's placement. `items` or `entries` null: not read, said so
// and nothing counted; `offers` null: the runner offers were not read, so a
// queued task stays at its stage and the doubt is said.
export function attentionFor(
  project: string, items: readonly Item[] | null, entries: readonly InboxEntry[] | null,
  offers: readonly SeenOffer[] | null, now: Date,
): Attention {
  const unknown: string[] = [];
  if (!items) return { project, owner: [], pipeline: [], overlaps: [], unknown: ["The project's tasks could not be read, so what waits on you there is unknown."] };
  if (!entries) unknown.push("The project's notices could not be read, so acceptance, plan decisions and protected actions there are not shown.");
  const mine = (entries ?? []).filter((x) => x.project === project);
  const byItem = new Map<string, InboxEntry[]>();
  for (const x of mine) byItem.set(x.itemId, [...(byItem.get(x.itemId) ?? []), x]);
  const owner: OwnerTask[] = [];
  const pipeline: PipelineTask[] = [];
  let unread = 0;
  const ordered = [...items].sort((a, b) => compare(a.createdAt, b.createdAt) || compare(a.id, b.id));
  for (const item of ordered) {
    const queued = taskStage(item) === "queued";
    if (queued && !offers) unread++;
    const noRunner = queued && offers ? unoffered(item.dispatch!, offers, now) : undefined;
    const placed = placeTask(project, item, byItem.get(item.id) ?? [], noRunner);
    if (!placed) continue;
    if (isOwnerTask(placed)) owner.push(placed);
    else pipeline.push(placed);
  }
  const unpooled = new Set(mine.filter((x) => x.kind === "assess" && x.reviewer === undefined).map((x) => x.itemId));
  if (unpooled.size) unknown.push(`The reviewer pool was not read, so whether ${[...unpooled].sort().join(", ")} ${unpooled.size === 1 ? "needs" : "need"} your override is unknown.`);
  if (unread) unknown.push(`The runner offers could not be read, so whether a runner can take the ${unread === 1 ? "queued task" : `${unread} queued tasks`} is unknown.`);
  const known = new Set(items.map((i) => i.id));
  const strays = [...new Set(mine.filter((x) => !known.has(x.itemId)).map((x) => x.itemId))];
  if (strays.length) unknown.push(`Notices name ${strays.join(", ")}, which the task list read here does not hold.`);
  // Stable: precedence, then the order the tasks were made in.
  const rank = (t: OwnerTask) => RANK.get(t.call)!;
  owner.sort((a, b) => rank(a) - rank(b));
  return { project, owner, pipeline, overlaps: overlapPairs(mine), unknown };
}

// Each stage as the waiting lists word it.
export const STAGE_LABEL: Record<Stage, string> = {
  merged: "merged", abandoned: "closed", integrated: "integrated", blocked: "blocked", landing: "landing", ready: "ready",
  submitted: "in review", accepted: "accepted", building: "building", queued: "queued for a runner", open: "not yet dispatched",
};

// The pipeline's tasks counted by stage, in the order taskStage ranks them.
export const STAGE_ORDER: Stage[] = ["blocked", "landing", "ready", "submitted", "accepted", "building", "queued", "open"];
export function stageCounts(a: Pick<Attention, "pipeline">): [Stage, number][] {
  return STAGE_ORDER.map((s) => [s, a.pipeline.filter((t) => t.stage === s).length] as [Stage, number]).filter(([, n]) => n > 0);
}

// The pipeline in one line: "12 tasks: 3 in review, 2 building".
export function pipelineLine(a: Pick<Attention, "pipeline">): string {
  const n = a.pipeline.length;
  return `${n} ${n === 1 ? "task" : "tasks"}: ${stageCounts(a).map(([s, c]) => `${c} ${STAGE_LABEL[s]}`).join(", ")}`;
}
