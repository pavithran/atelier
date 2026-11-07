// The Now view (t525; PAVI chose layout A): every live task across projects,
// once, in one of four groups, with who it waits on and since when. The page
// (/now), the JSON (/api/now) and `atelier status` all draw from one buildNow,
// so they cannot differ. Nothing here reads a clock or a store: the caller
// passes what the project ledgers recorded and the time it was read.
//
// Times are Eastern, whatever the owner's TIMEZONE setting, and "today" is the
// Eastern day. A task's "since" is the entry time of its current stage, as the
// ledger's events record it (SituationFacts.stages).
import { OWNER_CALL_LABEL, type OwnerCall, type OwnerTask } from "./attention.ts";
import type { LandingRecord, LedgerEvent } from "./ledger";
import { dayInZone } from "./time.ts";
import { eventStage, stageOverrun, type Item, type TaskStage } from "./rules.ts";
import type { ProgressRecord } from "./situation.ts";
import { tokens } from "./usage/report.ts";
import { STALL_MS } from "./situation.ts";
import type { DeployRecord } from "./checkout-lease.ts";

export const EASTERN = "America/New_York";
// The target in the header: weighted tokens per sound merge. The rule that
// weighs a run's tokens is t527's (the bars); until it lands a run counts as
// the tokens its runner reported (runTokens below).
export const TARGET_TOKENS_PER_MERGE = 700_000;
// A merge's Revert link is offered this long after the merge.
export const REVERT_WINDOW_MS = 24 * 3_600_000;
const LANDING_FRESH_MS = 30 * 60_000;

export type NowGroupKey = "needs-you" | "running" | "waiting" | "landed";
export const NOW_GROUPS: { key: NowGroupKey; label: string }[] = [
  { key: "needs-you", label: "Needs you" },
  { key: "running", label: "Running" },
  { key: "waiting", label: "Stuck or waiting on a session" },
  { key: "landed", label: "Landed today" },
];

// What one project's ledger recorded, as the route reads it (situationFacts,
// the owner's attention, the recent events and the deploys).
export interface NowProject {
  name: string;
  title: string;
  items: Item[];
  stages: Record<string, { stage: string; since: string }>;
  owner: OwnerTask[];
  reviewRequests: { item: string; state: string; claimedBy: string | null; claimedAt: string | null }[];
  landings: Record<string, LandingRecord>;
  progress: Record<string, ProgressRecord>;
  events: Pick<LedgerEvent, "kind" | "itemId" | "at" | "actor" | "data">[];
  deploys: Pick<DeployRecord, "ship" | "head" | "by" | "result" | "at">[];
}

export interface NowRow {
  id: string;
  project: string;
  projectTitle: string;
  title: string;
  group: NowGroupKey;
  stage: string;
  waitingOn: string;
  since: string;
  sinceText: string;
  next: string;
  tokens: number | null;
  tokensText: string;
  stuck: string | null;
  href: string;
  // Landed today only.
  deployedAt?: string | null;
  deployedText?: string;
  reviewer?: string | null;
  findingsFixed?: number;
  revertHref?: string | null;
  reverted?: boolean;
}

export interface NowHeader {
  mergesToday: number;
  soundMergesToday: number;
  liveCount: number;
  tokensPerSoundMerge: number | null;
  tokensPerSoundMergeText: string;
  target: number;
  targetText: string;
  onTarget: boolean;
}

export interface NowView {
  at: string;
  header: NowHeader;
  groups: { key: NowGroupKey; label: string; rows: NowRow[] }[];
  // Projects whose ledger could not be read, which the route sets: their
  // tasks are not in the groups, and the page and the text say so.
  unread?: string[];
}

const parts = (at: string) => {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: EASTERN, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" }).formatToParts(new Date(at));
  const get = (t: string) => f.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} ${get("timeZoneName")}`;
};
// "2026-11-07 07:00 EST": the moment in Eastern time, the zone's abbreviation
// in force at that moment (EDT before the first Sunday of November).
export const easternStamp = (at: string): string => parts(at);

// "10 min", "6 h", "1 h 30 min".
function span(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m} min`;
  return m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`;
}

// The tokens of a run as the header counts them. t527 replaces this with the
// bars' weights; today it is the figure the runner reported.
const runTokens = (run: { tokens: number | null }): number | null => run.tokens;

function spent(p: ProgressRecord | undefined): number | null {
  const known = (p?.runs ?? []).map(runTokens).filter((n): n is number => n !== null);
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
}

const fmtM = (n: number) => `${Number((n / 1e6).toFixed(2))}M`;

const OWNER_VERB: Record<OwnerCall, string> = {
  "clear-secret": "clear its secret flag", unblock: "unblock it", "decide-plan": "decide its plan", "approve-plan": "approve its plan",
  accept: "accept it", land: "land it", override: "decide the review override", ship: "ship it", "gave-up": "dispatch it again or change it", "start-runner": "start a runner for it",
};

// What each stage waits on, and what it does by itself. Every stage has both,
// so no row says nothing or "unknown".
const NEXT: Record<string, string> = {
  filed: "dispatches itself once its criteria are agreed",
  agreed: "queues for a builder",
  queued: "a runner claims it and builds it",
  building: "checks run when it submits",
  built: "the checks run, then a review is requested",
  checked: "the verdict records itself",
  reviewed: "queues to land once the gate clears",
  landable: "lands itself when it reaches the front",
  landed: "deploys with the next ship",
  blocked: "nothing: it waits until it is unblocked",
};
const WAITING: Record<string, string> = {
  filed: "a session to review its criteria",
  agreed: "a dispatcher session",
  built: "the required checks (a runner)",
  checked: "a reviewer session",
  reviewed: "the landing queue",
  landable: "the landing runner",
  landed: "the post-merge run",
};

const mergedAt = (events: NowProject["events"], id: string): string | null =>
  events.filter((e) => e.itemId === id && (e.kind === "item.merged" || e.kind === "item.landed_fast")).map((e) => e.at).sort().at(-1) ?? null;

export const revertOpen = (merged: string, now: Date): boolean => now.getTime() - Date.parse(merged) < REVERT_WINDOW_MS;

function liveRow(p: NowProject, item: Item, now: Date): NowRow {
  const recorded = p.stages[item.id];
  const stage = recorded?.stage ?? eventStage(item);
  const since = recorded?.since ?? item.blocked?.at ?? item.updatedAt;
  const owner = p.owner.find((t) => t.id === item.id);
  const claimed = p.reviewRequests.find((r) => r.item === item.id && r.state === "claimed" && r.claimedBy);
  const progress = p.progress[item.id];
  const landing = p.landings[item.id];
  const holder = item.owner ?? "its builder";
  let group: NowGroupKey = "waiting";
  let waitingOn = WAITING[stage] ?? "the pipeline's next step";
  let next = NEXT[stage] ?? "moves on when its current step finishes";
  if (owner) {
    group = "needs-you";
    waitingOn = `you: ${OWNER_CALL_LABEL[owner.call]}`;
    next = `nothing: it waits for you to ${OWNER_VERB[owner.call]}`;
  } else if (stage === "building") {
    const quiet = now.getTime() - Date.parse(progress?.changedAt ?? since);
    waitingOn = `${holder}, building`;
    if (quiet < STALL_MS) group = "running";
    else waitingOn += `, silent for ${span(quiet)}`;
  } else if (stage === "queued") {
    const d = item.dispatch;
    const who = [d?.agent, d?.model].filter(Boolean).join("/");
    waitingOn = who ? `a runner offering ${who}` : "a runner of any kind";
  } else if (stage === "blocked") {
    waitingOn = `${item.blocked?.by ?? "its holder"}: ${item.blocked?.reason ?? "blocked"}`;
  } else if (claimed && ["built", "checked", "reviewed", "landable"].includes(stage)) {
    group = "running";
    waitingOn = `${claimed.claimedBy}, reviewing`;
  } else if (landing && !landing.cancelled && !landing.failedStep && ["reviewed", "landable"].includes(stage) && now.getTime() - Date.parse(landing.at) < LANDING_FRESH_MS) {
    group = "running";
    waitingOn = `the landing run, ${landing.step}`;
  }
  const over = group === "waiting" ? stageOverrun(stage as TaskStage, since, now, { reviewClaimed: !!claimed }) : null;
  const total = spent(progress);
  return {
    id: item.id, project: p.name, projectTitle: p.title, title: item.title.replace(/\s+/g, " ").trim(), group, stage, waitingOn,
    since, sinceText: easternStamp(since), next, tokens: total, tokensText: total === null ? "none reported" : tokens(total),
    stuck: over ? `${span(over.overMs)} over its ${span(over.limitMs)} limit` : null,
    href: `/p/${encodeURIComponent(p.name)}/${encodeURIComponent(item.id)}`,
  };
}

function landedRow(p: NowProject, item: Item, merged: string, now: Date): NowRow {
  const deploy = p.deploys.filter((d) => d.result === "shipped" && d.at >= merged).map((d) => d.at).sort()[0] ?? null;
  const reviews = p.events.filter((e) => e.itemId === item.id && e.kind === "review.approved" && !e.data.postMerge).sort((a, b) => a.at.localeCompare(b.at));
  const findings = p.events.filter((e) => e.itemId === item.id && e.kind === "review.rejected" && !e.data.postMerge)
    .reduce((n, e) => n + (Array.isArray(e.data.findings) ? e.data.findings.length : 0), 0);
  const reverted = p.events.some((e) => e.itemId === item.id && e.kind === "item.revert_requested");
  const total = spent(p.progress[item.id]);
  const page = `/p/${encodeURIComponent(p.name)}/${encodeURIComponent(item.id)}`;
  return {
    id: item.id, project: p.name, projectTitle: p.title, title: item.title.replace(/\s+/g, " ").trim(), group: "landed", stage: "landed",
    waitingOn: deploy ? "nobody: it is deployed" : "the next ship", since: merged, sinceText: easternStamp(merged),
    next: deploy ? "nothing: it is done" : "deploys with the next ship", tokens: total, tokensText: total === null ? "none reported" : tokens(total), stuck: null, href: page,
    deployedAt: deploy, deployedText: deploy ? easternStamp(deploy) : "not deployed yet", reviewer: reviews.at(-1)?.actor ?? null, findingsFixed: findings,
    revertHref: !reverted && revertOpen(merged, now) ? `${page}/revert` : null, reverted,
  };
}

// The view at `now`. A merge is sound unless a revert of it was asked for;
// the header's tokens are those spent on every merge today, sound or not,
// divided by the sound ones.
export function buildNow(projects: NowProject[], now: Date): NowView {
  const today = dayInZone(now, EASTERN);
  const live: NowRow[] = [], landed: NowRow[] = [];
  for (const p of projects) {
    for (const item of p.items) {
      if (item.state === "abandoned") continue;
      if (item.state === "merged") {
        const at = mergedAt(p.events, item.id);
        if (at && Date.parse(at) <= now.getTime() && dayInZone(at, EASTERN) === today) landed.push(landedRow(p, item, at, now));
        continue;
      }
      live.push(liveRow(p, item, now));
    }
  }
  const bySince = (a: NowRow, b: NowRow) => a.since.localeCompare(b.since) || a.project.localeCompare(b.project) || a.id.localeCompare(b.id, "en", { numeric: true });
  landed.sort((a, b) => b.since.localeCompare(a.since) || a.id.localeCompare(b.id, "en", { numeric: true }));
  const groups = NOW_GROUPS.map((g) => ({ ...g, rows: g.key === "landed" ? landed : live.filter((r) => r.group === g.key).sort(bySince) }));
  const sound = landed.filter((r) => !r.reverted).length;
  const spentToday = landed.reduce((n, r) => n + (r.tokens ?? 0), 0);
  const per = sound ? Math.round(spentToday / sound) : null;
  return {
    at: now.toISOString(),
    header: {
      mergesToday: landed.length, soundMergesToday: sound, liveCount: live.length, tokensPerSoundMerge: per,
      tokensPerSoundMergeText: per !== null ? fmtM(per) : landed.length ? "no sound merge yet" : "no merges yet",
      target: TARGET_TOKENS_PER_MERGE, targetText: fmtM(TARGET_TOKENS_PER_MERGE), onTarget: per !== null && per <= TARGET_TOKENS_PER_MERGE,
    },
    groups,
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// `atelier status`'s text: the header, then each group's rows, each row two lines.
export function nowText(view: NowView): string {
  const h = view.header;
  const per = h.tokensPerSoundMerge === null ? `tokens per sound merge: ${h.tokensPerSoundMergeText}` : `${h.tokensPerSoundMergeText} tokens per sound merge`;
  const lines = [`Now: ${h.liveCount} live · ${plural(h.mergesToday, "merge")} today · ${per} (target ${h.targetText})`];
  for (const g of view.groups) {
    lines.push("", `${g.label} (${g.rows.length})`);
    if (!g.rows.length) lines.push("  Nothing.");
    for (const r of g.rows) {
      lines.push(`  ${r.id}  ${r.title}  [${r.project}]  ${r.stage}`);
      lines.push(r.group === "landed"
        ? `    landed ${r.sinceText} · deployed ${r.deployedText} · reviewer ${r.reviewer ?? "none recorded"} · ${plural(r.findingsFixed ?? 0, "finding")} fixed · tokens: ${r.tokensText} · ${r.reverted ? "reverted" : r.revertHref ? `revert: ${r.revertHref}` : "revert window closed"}`
        : `    waiting on ${r.waitingOn} · since ${r.sinceText} · next: ${r.next} · tokens: ${r.tokensText}${r.stuck ? ` · stuck: ${r.stuck}` : ""}`);
    }
  }
  if (view.unread?.length) lines.push("", `Not read: ${view.unread.join(", ")}. Their tasks are missing from the lists above.`);
  return lines.join("\n");
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const cell = (label: string, value: string, cls = "") => `<div class="now-cell${cls ? ` ${cls}` : ""}"><dt>${label}</dt><dd>${value}</dd></div>`;

function rowHtml(r: NowRow): string {
  const task = `<div class="now-task"><a class="now-title" href="${esc(r.href)}">${esc(r.title)}</a><span class="now-id"><span class="now-project">${esc(r.projectTitle)}</span> <code>${esc(r.id)}</code></span></div>`;
  if (r.group === "landed") {
    const revert = r.reverted ? `<span class="tag ask">Reverted</span>` : r.revertHref ? `<a class="now-revert" href="${esc(r.revertHref)}">Revert</a>` : `<span class="meta">Revert window closed</span>`;
    return `<li class="now-row">${task}<dl class="now-cells">${cell("Landed", esc(r.sinceText))}${cell("Deployed", esc(r.deployedText ?? ""))}${cell("Reviewer", esc(r.reviewer ?? "none recorded"))}${cell("Findings fixed", String(r.findingsFixed ?? 0))}${cell("Tokens", esc(r.tokensText))}${cell("For 24 h", revert)}</dl></li>`;
  }
  const stuck = r.stuck ? `<span class="tag ask now-stuck">Stuck: ${esc(r.stuck)}</span>` : "";
  return `<li class="now-row">${task}<dl class="now-cells">${cell("Stage", `<span class="tag">${esc(r.stage)}</span>${stuck}`)}${cell("Waiting on", esc(r.waitingOn))}${cell("Since", esc(r.sinceText))}${cell("Next by itself", esc(r.next))}${cell("Tokens", esc(r.tokensText))}</dl></li>`;
}

// The <main> of the page: the header's three figures, then the four groups.
export function nowBody(view: NowView): string {
  const h = view.header;
  const figure = (label: string, value: string, note = "", cls = "") => `<div class="now-figure${cls ? ` ${cls}` : ""}"><dt>${label}</dt><dd>${value}</dd>${note ? `<p class="meta">${note}</p>` : ""}</div>`;
  const per = h.tokensPerSoundMerge === null ? esc(h.tokensPerSoundMergeText) : `${esc(h.tokensPerSoundMergeText)}`;
  const head = `<header class="now-head"><h1>Now</h1><dl class="now-figures">${figure("Tokens per sound merge today", per, `target ${esc(h.targetText)}`, h.onTarget ? "on-target" : h.tokensPerSoundMerge === null ? "" : "over-target")}${figure("Merges today", String(h.mergesToday), `${h.soundMergesToday} sound`)}${figure("Live", String(h.liveCount), "tasks in motion")}</dl></header>`;
  const groups = view.groups.map((g) => `<section class="now-group now-${g.key}" aria-labelledby="now-${g.key}"><h2 id="now-${g.key}">${esc(g.label)} <span class="count">${g.rows.length}</span></h2>${g.rows.length ? `<ol class="now-list">${g.rows.map(rowHtml).join("")}</ol>` : `<p class="meta">Nothing.</p>`}</section>`).join("");
  return `<div class="now">${head}<p class="meta now-zone">Times are Eastern.</p>${view.unread?.length ? `<p class="now-unread" role="alert">Not read: ${esc(view.unread.join(", "))}. Their tasks are missing from the lists below.</p>` : ""}${groups}</div>`;
}
