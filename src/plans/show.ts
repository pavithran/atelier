// What a plan says to the owner: the view the Ledger builds (planView in
// src/ledger.ts), the text `atelier plan show` prints from it, and the
// decision brief `atelier show tP`, `atelier inbox` and the brief route give
// for a plan item. Pure, so the wording is tested with `node --test`. Every
// line is drawn from the view; text a planner or agent wrote is put on one
// line, so it cannot pose as a line of Atelier's own.

import type { Brief, Verdict } from "../brief.ts";
import { holdText, liveOffers, unoffered, type CoreHold, type Dispatch, type SeenOffer } from "../dispatch/rules.ts";
import type { Item, ItemState } from "../rules.ts";
import { TEXT_CONTROLS } from "../text.ts";
import { chargesBuilder, type Attempt, type IntegrationFailure, type PlanPhase } from "./phase.ts";
import type { PartRoute } from "./route.ts";
import type { Plan } from "./schema.ts";
import type { PlanLimits, PlanRefresh } from "./state.ts";

// A part's live review request (docs/orchestrator.md, section 4), as planView
// reads it from the ledger's requests: who was asked to review, at what head,
// and whether a runner has claimed the request.
export interface PlanPartReview {
  reviewer: string;              // harness/model, the dispatch's agent and model
  head: string;                  // the head the review was asked of
  state: "open" | "claimed";
  claimedBy: string | null;
  claimedAt: string | null;      // ISO time the request was claimed
  topTier?: boolean;             // the gate's request asked of a tier model, whose review serves as the tier review too
}

export interface PlanPartView {
  id: string;
  key: string;
  title: string;
  state: ItemState;
  owner: string | null;
  head: string | null;
  acceptedHead: string | null;
  scope: string[];
  dependsOn: { key: string; id: string | null }[];
  dispatch: Dispatch | null;
  held?: CoreHold | null;         // while queued: the live item outside the plan it waits on (coreHold)
  route: PartRoute | null;        // the routing fixed at approval, with the owner's reroute
  attempts: Attempt[];            // counted from the owner's latest reroute or retry
  gate: { ready: boolean; blockers: string[] } | null;  // while submitted or accepted
  review?: PlanPartReview | null; // the part's live review request, if any
  tierReview?: PlanPartReview | null; // the part's live tier review request (src/review/tier.ts), if any
  integration: { head: string; mergeCommit: string } | null;  // recorded when the part became integrated
  integrationFailure?: IntegrationFailure | null;  // the part's latest failed integration, if any
  blocked?: { reason: string; by: string } | null;  // while blocked: why, and who blocked it
  // Set for a part the Ledger added after approval, outside the approved
  // document: the main head it merges, who added it and when.
  added?: { mainHead: string; by: string; at: string } | null;
}

export interface PlanView {
  item: Item;
  phase: PlanPhase;
  goal: string;
  scope: string[];
  planner: string;
  plannerReasons: string[];
  blocked: string | null;
  completedAt: string | null;
  proposal: { hash: string; by: string; at: string; count: number; answered: boolean } | null;
  plan: Plan | null;              // the approved document, or else the newest proposal
  approval: { hash: string; at: string; by: string; allowPaid: boolean; limits: PlanLimits; deadline: string; jobsUsed: number } | null;
  parts: PlanPartView[];
  preview: PartRoute[] | null;    // before approval: the routing an approval would fix now
  integration: { integrationHead: string | null };  // the plan branch's integration head; null when none is recorded
  // How the branch stands against main: the main head it last took (from a
  // refresh, or the commit the plan forked from), main's head now as read or
  // last observed, the latest refresh, and whether the integrator holds it.
  refresh?: { taken: string | null; main: string | null; last: PlanRefresh | null; running: boolean };
  harnessFailure: string | null;  // the release note when the harness failed, shown while the plan waits for the planner
  pastDeadline: boolean;          // an approved plan past its deadline, whose block only stop can lift
  offers?: SeenOffer[] | null;    // the runner offers the Worker read for this view, to judge a routed review against; null when none were read
}

const flat = (text: string) => text.replace(TEXT_CONTROLS, " ").replace(/\s+/g, " ").trim();
const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const when = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const list = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

// What each part's state means to the owner, in a few words.
function partState(p: PlanPartView, parts: PlanPartView[]): string {
  if (p.state === "open") {
    if (p.dispatch) return `queued for ${p.dispatch.agent}/${p.dispatch.model}`;
    const waiting = p.dependsOn.filter((d) => parts.find((x) => x.key === d.key)?.state !== "merged");
    return waiting.length ? `waits for ${list(waiting.map((d) => `${d.key} (${d.id ?? "?"})`))}` : "open";
  }
  if (p.state === "claimed") return `claimed by ${p.owner}`;
  if (p.state === "submitted") return `submitted by ${p.owner}`;
  if (p.state === "integrated") return p.integration ? `integrated as ${p.integration.mergeCommit.slice(0, 8)}` : "integrated";
  return p.state;
}

// The decision a part waits on from the owner until the integration branch
// exists, with the command that makes it: a part reaches main by its own
// acceptance and merge.
function ownerStep(p: PlanPartView, flag: string): string | null {
  if (p.state === "blocked" && p.blocked) return `blocked by ${p.blocked.by}: ${flat(p.blocked.reason)}`;
  if (p.state === "accepted") return `accepted at ${p.acceptedHead?.slice(0, 8)}; land it: atelier merge ${p.id} ${flag}`;
  if (p.state !== "submitted" || !p.gate) return null;
  if (p.gate.ready) return `ready for you: atelier merge ${p.id} --head ${p.head} ${flag}`;
  return `not ready: ${p.gate.blockers.map(flat).join("; ")}`;
}

// A queued part the project's core files hold: the live item it waits on,
// and that the queue offers it once that item merges or is abandoned.
function heldLine(p: PlanPartView): string | null {
  if (!p.held || !p.dispatch || p.state !== "open") return null;
  return `held in the queue: ${holdText(p.held)}; offered once ${p.held.id} merges or is abandoned`;
}

function attemptsLine(attempts: Attempt[]): string | null {
  if (!attempts.length) return null;
  const words = { "give-up": "released with no commit", failed: "released after a failed finish", finished: "finished" } as const;
  return `attempts: ${attempts.map((a) => `${a.actor} ${words[a.outcome]}`).join("; ")}`;
}

// A part's latest failed integration, while it has not been integrated
// since: why it failed, and whether its builder was charged an attempt.
function integrationFailureLine(p: PlanPartView): string | null {
  const f = p.integrationFailure;
  if (!f || p.state === "integrated" || p.state === "merged" || p.state === "abandoned") return null;
  const what = f.kind === "conflict" ? "a merge conflict" : f.kind === "checks" ? "failing checks" : f.kind ? `kind ${flat(f.kind)}` : "kind not recorded";
  return `integration failed at ${when(f.at)} (${what}; ${chargesBuilder(f.kind) ? "charged to the builder" : "not charged to the builder"}): ${cut(flat(f.reason) || "no reason given", 500)}`;
}

// What a part's live review request says (docs/orchestrator.md, section 4):
// who was asked, and whether the request stands open or a runner claimed it.
// An open request the runner offers were read for is judged against them, so
// one routed to a model no live runner offers says it can never be claimed —
// with what would change that — instead of reading as merely not claimed
// yet, which is how it waited unnoticed for hours (t197's part t210).
function reviewLines(p: PlanPartView, v: PlanView, flag: string, now = new Date()): string[] {
  const r = p.review;
  if (!r) return [];
  const head = r.head.slice(0, 8);
  // The gate's review asked of a tier model gives the tier review too.
  const what = r.topTier ? "gate review, top tier," : "review";
  if (r.state === "claimed") return [`${what} of ${head} asked of ${r.reviewer}, claimed at ${r.claimedAt ? when(r.claimedAt) : "a time not recorded"}`];
  const slash = r.reviewer.indexOf("/");
  const asked = v.offers
    ? unoffered(
        { to: "home", agent: r.reviewer.slice(0, slash), model: r.reviewer.slice(slash + 1), by: "atelier/orchestrator", at: "", note: "", job: "review" },
        v.offers, now,
      )
    : null;
  return asked
    ? [
        `${what} of ${head} asked of ${r.reviewer}; the request is open, and ${asked}`,
        `it will not be claimed until a runner that offers ${r.reviewer} for the review job asks for work; name another reviewer: atelier plan reroute ${p.id} --to H/M ${flag}`,
      ]
    : [`${what} of ${head} asked of ${r.reviewer}; the request is open`];
}

// A part's live tier review request (src/review/tier.ts): a second opinion
// beside the gate's review, which the part's integration never waits for.
function tierLines(p: PlanPartView): string[] {
  const r = p.tierReview;
  if (!r) return [];
  const head = r.head.slice(0, 8);
  return [r.state === "claimed"
    ? `tier review of ${head} asked of ${r.reviewer}, claimed at ${r.claimedAt ? when(r.claimedAt) : "a time not recorded"}; integration does not wait for it`
    : `tier review of ${head} asked of ${r.reviewer}; the request is open, and integration does not wait for it`];
}

// Routing fell back to the whole pool because no runner is live, though
// runners have asked before (routable in src/ledger.ts): the offers the view
// was read with say when one last asked, and the owner reading a pool-wide
// routing is warned it is a fallback rather than taking it for what the
// runners offer now. Null when offers were not read, a runner is live, or
// the plan is approved and its routing is already fixed.
function fallbackLine(v: PlanView, now: Date): string | null {
  if (v.approval || !v.offers?.length || liveOffers(v.offers, now).length) return null;
  const last = v.offers.map((o) => o.at).sort().at(-1) ?? "";
  return `No runner is live now; the last to ask for work did so at ${when(last)}, so routing falls back to the whole pool, and a dispatch may wait until a runner asks again.`;
}

// A part the Ledger added: for which main head, by whom, and that it goes
// before every other part.
function addedLine(p: PlanPartView): string | null {
  const a = p.added;
  if (!a) return null;
  const who = a.by === "atelier/orchestrator" ? "after the refresh conflicted" : `at ${a.by}'s request`;
  return `added by Atelier for main at ${a.mainHead.slice(0, 8)}, ${who}, at ${when(a.at)}; not in the approved plan. No other part is dispatched until it is integrated`;
}

function routeLines(route: PartRoute | undefined | null, preview: boolean): string[] {
  if (!route) return [];
  const lead = preview ? "would be built by" : "builder";
  const lines: string[] = [];
  if (route.builder) lines.push(`${lead} ${route.builder.actor}: ${flat(route.builder.reasons[0] ?? "")}`);
  if (route.alternates.length) lines.push(`alternates ${route.alternates.map((a) => a.actor).join(", ")}`);
  if (route.reviewer) {
    // A reviewer the plan picked in place of the routed one says whom it
    // replaced and why.
    const change = route.reviewerChange;
    lines.push(`reviewer ${route.reviewer.actor}, of another family${change ? `, in place of ${change.from ?? "no reviewer"}: ${flat(change.reason)}` : ""}`);
  }
  if (route.unrouted) lines.push(`unrouted: ${flat(route.unrouted)}`);
  return lines;
}

// What `atelier plan show` prints: the phase and record, each part, and the
// commands the owner's next decisions take.
export function planText(v: PlanView, project: string, now = new Date()): string {
  const id = v.item.id, flag = `--project ${project}`;
  const lines = [`${id}  plan  ${flat(v.item.title)}`, `Goal: ${flat(v.goal)}`, `Phase: ${v.phase}.`];
  if (v.blocked) lines.push(`Blocked: ${flat(v.blocked)}.`);
  if (v.scope.length) lines.push(`Scope: ${v.scope.map(flat).join(", ")}`);
  const a = v.approval;
  if (!a) {
    const doing = v.item.owner ? `, holding ${id} to plan` : v.item.dispatch ? ", the plan job waiting in the queue" : "";
    lines.push(`Planner: ${v.planner}${doing}.`);
    lines.push(v.proposal && v.plan
      ? `Proposal ${v.proposal.count}, by ${v.proposal.by} at ${when(v.proposal.at)}: ${count(v.plan.parts.length, "part")}. Hash: ${v.proposal.hash}`
      : "No valid proposal yet.");
    if (v.harnessFailure) lines.push(flat(v.harnessFailure));
  } else {
    lines.push(`Approved by ${a.by} at ${when(a.at)}, ${a.allowPaid ? "paid models allowed" : "no paid models"}. Hash: ${a.hash}`);
    lines.push(`Limits: ${a.limits.maxParallel} parts live at once, ${a.limits.attempts} attempts a part, deadline ${when(a.deadline)}. Part dispatches: ${a.jobsUsed} of ${a.limits.maxJobs}.`);
  }
  if (a) {
    lines.push("", "Parts:");
    for (const p of v.parts) {
      lines.push(`  ${p.id}  ${p.key}  ${partState(p, v.parts)}  ${flat(p.title)}`);
      const deps = p.dependsOn.map((d) => `${d.key} (${d.id ?? "?"})`);
      const detail = [addedLine(p), `scope ${p.scope.map(flat).join(", ")}; depends on ${deps.length ? list(deps) : "nothing"}`, ...routeLines(p.route, false), heldLine(p), ...reviewLines(p, v, flag, now), ...tierLines(p), attemptsLine(p.attempts), integrationFailureLine(p), ownerStep(p, flag)];
      for (const line of detail) if (line) lines.push(`      ${line}`);
    }
  } else if (v.plan) {
    lines.push("", "Parts:");
    for (const p of v.plan.parts) {
      lines.push(`  ${p.key}  ${p.kind}, ${p.taskKind}, size ${p.size}  ${flat(p.title)}`);
      const detail = [
        `scope ${p.scope.map(flat).join(", ")}; depends on ${p.dependsOn.length ? list(p.dependsOn.map(flat)) : "nothing"}`,
        `brief: ${cut(flat(p.brief), 300)}`,
        `acceptance: ${p.acceptance.map(flat).join("; ")}`,
        ...routeLines(v.preview?.find((r) => r.key === p.key), true),
      ];
      for (const line of detail) lines.push(`      ${line}`);
    }
    if (v.preview) lines.push("", "The routing shown is what an approval would fix now, without paid models; it is computed again when you approve.");
  }
  // While the plan is not approved, routing still decides from the offers,
  // so a fallback to the pool is the owner's to know before approving.
  const fallen = fallbackLine(v, now);
  if (fallen) lines.push("", fallen);
  if (v.approval) {
    const head = v.integration.integrationHead;
    lines.push("", head ? `Integration branch at ${head.slice(0, 8)}.` : "No part is integrated yet; the integration branch still sits at the commit the plan forked from.");
    lines.push(...refreshLines(v, flag));
  }
  lines.push("", ...nextSteps(v, flag));
  return lines.join("\n");
}

// How far behind main the plan's branch is, and its latest refresh: one in
// flight, which parts wait for, or one that failed, with why and the command
// that runs it again. A refresh is the plan's own work and charges no part.
function refreshLines(v: PlanView, flag: string): string[] {
  const r = v.refresh;
  if (!r || v.item.state === "merged" || v.item.state === "abandoned") return [];
  const s = (hash: string) => hash.slice(0, 8);
  const lines: string[] = [];
  const again = `atelier plan refresh ${v.item.id} ${flag}`;
  const last = r.last;
  const inFlight = last?.state === "dispatched";
  if (!r.taken) lines.push(r.main ? `Main is at ${s(r.main)}; the commit the branch forked from is not recorded.` : "");
  else if (!r.main) lines.push(`The branch last took main at ${s(r.taken)}; main's head is not known yet.`);
  else if (r.main === r.taken) lines.push(`The branch holds main's head ${s(r.main)}.`);
  else {
    const triedHere = last && last.mainHead === r.main;
    lines.push(`The branch last took main at ${s(r.taken)}; main is now at ${s(r.main)}.${inFlight || triedHere ? "" : ` Take it now: ${again}`}`);
  }
  if (last && inFlight) {
    lines.push(`A refresh from main at ${s(last.mainHead)} is ${r.running ? "being merged by atelier/integrator" : "queued for atelier/integrator"}, asked by ${last.by} at ${when(last.at)}; parts wait for it before they are dispatched.`);
  } else if (last?.state === "failed") {
    const what = last.kind === "conflict" ? "a merge conflict" : last.kind === "checks" ? "failing checks" : last.kind ? `kind ${flat(last.kind)}` : "kind not recorded";
    const resolving = v.parts.find((p) => p.added?.mainHead === last.mainHead);
    const next = resolving
      ? `Part ${resolving.id} (${resolving.key}) resolves it and goes before every other part.`
      : `Parts are dispatched without it. Run it again: ${again}, or have a part resolve it: ${again.replace(`refresh ${v.item.id}`, `refresh ${v.item.id} --resolve`)}`;
    lines.push(`The refresh from main at ${s(last.mainHead)} failed at ${when(last.endedAt ?? last.at)} (${what}; charged to no part): ${cut(flat(last.reason ?? "") || "no reason given", 500)}. It is not tried again for that head. ${next}`);
  } else if (last?.state === "refreshed") {
    lines.push(`Refreshed from main at ${s(last.mainHead)} at ${when(last.endedAt ?? last.at)}${last.mergeCommit ? `, as ${s(last.mergeCommit)}` : "; the branch already held it"}.`);
  }
  return lines.filter(Boolean);
}

function nextSteps(v: PlanView, flag: string): string[] {
  const id = v.item.id;
  if (v.item.state === "merged") return ["The plan is complete: each part has merged or was abandoned. Nothing waits."];
  if (v.item.state === "abandoned") return ["The plan is stopped. Nothing waits."];
  if (v.blocked && v.approval) {
    if (v.pastDeadline) {
      return [
        "The plan is blocked until you decide:",
        `  close the plan and its open parts: atelier plan stop ${id} ${flag}`,
      ];
    }
    return [
      "The plan is blocked until you decide:",
      `  count a part's attempts afresh: atelier plan retry tN ${flag}`,
      `  name who builds a part: atelier plan reroute tN --to H/M ${flag}`,
      `  name who reviews a submitted or blocked part: atelier plan reroute tN --to H/M ${flag}`,
      `  give a part up: atelier abandon tN ${flag}`,
      `  close the plan and its open parts: atelier plan stop ${id} ${flag}`,
    ];
  }
  if (!v.approval) {
    if (v.proposal && !v.blocked && v.proposal.answered) {
      return [`Approve this split: atelier plan approve ${id} --hash ${v.proposal.hash} ${flag}`, `  or send it back: atelier plan revise ${id} --note "what to change" ${flag}`];
    }
    if (v.blocked) {
      return [
        "The plan is blocked until you decide:",
        ...(v.proposal ? [`  approve the last valid proposal: atelier plan approve ${id} --hash ${v.proposal.hash} ${flag}`] : []),
        `  ask the planner again, with a note: atelier plan revise ${id} --note "what to change" ${flag}`,
        `  ask the same planner again: atelier plan retry ${id} ${flag}`,
        `  ask another planner: atelier plan reroute ${id} --to H/M ${flag}`,
        `  close the plan: atelier plan stop ${id} ${flag}`,
      ];
    }
    if (v.item.owner) return [`Waiting for ${v.item.owner} to post its proposal.`];
    return [
      `Waiting for ${v.planner} to propose a plan; a runner that offers plan jobs takes it. To plan by hand as ${v.planner}:`,
      `  atelier claim ${id} --as ${v.planner} --runner home:NAME ${flag}`,
      `  atelier plan post ${id} FILE ${flag}`,
      `  atelier release ${id} ${flag}`,
    ];
  }
  // The integrator submitted the plan item once every part is integrated; the
  // owner accepts and merges the whole branch now (docs/orchestrator.md, section 5).
  if (v.item.state === "submitted") {
    const parts = v.parts.filter((p) => p.state === "integrated").map((p) => p.key);
    return [`The plan is integrated (${parts.length ? list(parts) : "no part"}); accept and land it: atelier merge ${id} --head ${v.item.head} ${flag}`];
  }
  const yours = v.parts.filter((p) => p.state === "accepted" || p.state === "blocked" || (p.state === "submitted" && p.gate !== null));
  return yours.length
    ? [`${count(yours.length, "part")} wait${yours.length === 1 ? "s" : ""} on you; each line above gives its command.`]
    : ["The parts are being built. Nothing waits on you."];
}

// The plan item's decision brief, in the shape briefFor gives any item, so
// `atelier show tP` and the inbox print it as they print any brief.
export function planBrief(v: PlanView): Brief {
  const id = v.item.id, goal = cut(flat(v.goal), 300);
  const evidence = [`Phase: ${v.phase}.`];
  if (v.proposal && v.plan && !v.approval) evidence.push(`Proposal ${v.proposal.count}: ${count(v.plan.parts.length, "part")}, ${v.proposal.hash.slice(0, 12)}, by ${v.proposal.by}.`);
  if (v.approval) {
    const states = new Map<string, number>();
    for (const p of v.parts) states.set(p.state, (states.get(p.state) ?? 0) + 1);
    evidence.push(`Parts: ${[...states].map(([state, n]) => `${n} ${state}`).join(", ")}.`);
    evidence.push(`Part dispatches: ${v.approval.jobsUsed} of ${v.approval.limits.maxJobs}; deadline ${when(v.approval.deadline)}.`);
  }
  if (v.blocked) evidence.push(`Blocked: ${flat(v.blocked)}.`);
  const recommend = (verdict: Verdict, reason: string) => ({ verdict, reason });
  let recommendation;
  const show = `atelier plan show ${id}`;
  if (v.item.state === "merged") recommendation = recommend("none", "The plan is complete: each part has merged or was abandoned; nothing waits.");
  else if (v.item.state === "abandoned") recommendation = recommend("none", "The plan was stopped; nothing waits.");
  else if (v.blocked) recommendation = recommend("decide", `The plan is blocked. Read ${show} for the decisions open to you.`);
  else if (!v.approval) {
    recommendation = v.proposal?.answered
      ? recommend("decide", `Read the split with ${show}, then approve it by its hash or send it back with a note.`)
      : recommend("wait", `The planner ${v.planner} has not proposed a plan${v.proposal ? " since you asked again" : " yet"}.`);
  } else {
    const ready = v.parts.filter((p) => p.state === "accepted" || (p.state === "submitted" && p.gate?.ready));
    const blocked = v.parts.filter((p) => p.state === "submitted" && p.gate && !p.gate.ready);
    if (ready.length) recommendation = recommend("merge", `${list(ready.map((p) => p.id))} ${ready.length === 1 ? "is" : "are"} ready for you to merge; ${show} gives each command.`);
    else if (blocked.length) recommendation = recommend("review", `${list(blocked.map((p) => p.id))} ${blocked.length === 1 ? "is" : "are"} submitted and not ready; ${show} says what each lacks.`);
    else recommendation = recommend("wait", "The parts are being built; nothing waits on you.");
  }
  const decided = v.approval ? `Plan ${id}, approved at ${v.approval.hash.slice(0, 12)}: ${goal}` : v.proposal ? `Approve plan ${id}'s split of: ${goal}` : `Plan ${id}: ${goal}`;
  return { decided, summary: null, nonGoals: v.item.nonGoals ?? [], stopWhen: v.item.stopWhen ?? [], nextGate: v.item.nextGate ?? null, evidence, recommendation };
}
