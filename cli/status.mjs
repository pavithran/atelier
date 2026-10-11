// The owner's queue as plain text. Pure: the caller fetches, this only formats.
// A view is { name, title?, items, inbox }, where items are the project's items
// and inbox holds the notices the server's inbox holds for it. What waits on
// the owner is what attentionFor (src/attention.ts) places under the owner's
// calls, one line per task, as Home, the Overview and `atelier inbox` place
// it; the rest of the live tasks are counted by pipeline stage, and
// overlapping scopes are counted, not listed. With `waiting` —
// the runner queue and the runner offers as the server holds them — the
// waiting section also names each open review request and its reviewer, and
// says of any queued job no live runner offers that it can never be claimed,
// which is not a wait but a mismatch between the dispatch and the runners
// (unoffered in src/dispatch/rules.ts); `waiting.server` is the server in
// use, which the link to each merge by override names. A queued job the project's core
// files hold (coreHold there) says which live item it waits on, as the
// queue's entry for it carries that. The offers (GET /runners) are each
// { runner, kind, agents: [{ agent, models }], jobs?, at }, `at` saying when
// the runner last asked, and a Runners section lists them after the projects,
// each named runner's jobs said as the runner's own first line says them
// (jobsLine in cli/runner.mjs): the jobs it takes and, behind them, the known
// jobs it does not.
import { holdText, OFFER_LIVE_MS, unoffered } from "../src/dispatch/rules.ts";
import { mergedByOverride } from "../src/rules.ts";
import { attentionFor, legacyFields, OWNER_CALL_LABEL, pipelineLine } from "../src/attention.ts";
import { daySpend } from "../src/usage/report.ts";
import { jobsLine } from "./runner.mjs";

// The address of a task's page on the server in use, the link `status` prints
// beside each merge by override (t371); with no server known, the page's
// path alone.
export function taskLink(server, project, id) {
  return `${server ? String(server).replace(/\/+$/, "") : ""}/p/${encodeURIComponent(project)}/${encodeURIComponent(id)}`;
}

// An item as `ls --json` and `status --json` print it: what the text listings
// show, with the times a machine reader such as Observatory draws on.
export function itemJson(i) {
  return { id: i.id, title: i.title, state: i.state, owner: i.owner, head: i.head,
    createdAt: i.createdAt, updatedAt: i.updatedAt, lastPushAt: i.lastPushAt };
}

// The queue as JSON: each project with its notices, its items each carrying
// its times, the project's overlapping pairs of tasks, each pair once and
// sorted, and its placement (attentionFor): what waits on the owner, the
// pipeline and what could not be read. Merged and abandoned items are
// included; a reader that wants only live work filters by state.
// `server` is the server in use, for the link to each merge by override;
// `offers` the runner offers (null when not read) and `now` the time read at.
export function statusJson(views, server = "", offers = null, now = new Date()) {
  return views.map((v) => {
    const mine = (v.inbox ?? []).filter((x) => x.project === v.name);
    const a = attentionFor(v.name, v.items, v.inbox, offers, now);
    return {
      name: v.name,
      ...(v.title ? { title: v.title } : {}),
      // Each null when not read, which attention.unknown words; never an
      // empty list standing for nothing.
      inbox: v.inbox ? mine : null,
      items: v.items ? v.items.map(itemJson) : null,
      overlaps: a.overlaps,
      attention: { owner: a.owner.map((t) => ({ ...t, url: absolute(server, t.href) })), pipeline: a.pipeline, unknown: a.unknown },
      // The merges that went in on the owner's override, each with the link
      // to its page (t371).
      mergedByOverride: mergedByOverride(v.items ?? []).map((i) => ({ id: i.id, url: taskLink(server, v.name, i.id) })),
    };
  });
}

// A path on the server in use, as a full address where the server is known.
export const absolute = (server, path) => `${server ? String(server).replace(/\/+$/, "") : ""}${path}`;

// The local half of `status --project`, as text: what this machine holds for
// the project's tasks and whether a landing is running here. Pure: the caller
// collects the facts, this only words them. A task is { id, uncommitted,
// unpushed, merging, conflicts, commitMessage } with null for what could not
// be read and `error` set when the workspace itself could not; landing is
// { lock, lease }, where lease is null, { unreadable } or { item, holder, since }.

// One task's line: each fact that applies in plain words, or "clean, pushed".
export function localTaskLine(t) {
  if (t.error) return `${t.id}  its workspace cannot be read: ${t.error}`;
  const said = [];
  if (t.uncommitted) said.push(`${t.uncommitted} ${t.uncommitted === 1 ? "path" : "paths"} with uncommitted changes`);
  if (t.unpushed) said.push(`${t.unpushed} ${t.unpushed === 1 ? "commit" : "commits"} not pushed to its fork`);
  if (t.unpushed === null) said.push("its unpushed commits cannot be counted");
  if (t.merging) said.push(`a merge is in progress${t.conflicts?.length ? `, in conflict: ${t.conflicts.join(", ")}` : ""}`);
  if (t.commitMessage) said.push("COMMIT_MSG.txt waiting to be committed");
  return `${t.id}  ${said.length ? said.join("; ") : "clean, pushed"}`;
}

// The whole section: one line per live task with a workspace here, a count
// of the closed tasks' workspaces left behind, then one line saying whether a
// landing is running on this machine for the project.
export function formatLocal(local) {
  const lease = local.landing.lease;
  const leaseText = lease === null
    ? "the server's landing lease is held by no one"
    : lease.unreadable ? `the server's landing lease could not be read (${lease.unreadable})`
      : `the server's landing lease is held by ${lease.holder} for ${lease.item} since ${lease.since}`;
  const lockText = local.landing.lock ? "a landing is running on this Mac" : "no landing is running on this Mac";
  const leftover = local.leftover
    ? [`  ${local.leftover} ${local.leftover === 1 ? "workspace" : "workspaces"} of merged or abandoned tasks left here; atelier gc --project ${local.project} previews removing them`]
    : [];
  return ["On this Mac:", ...local.tasks.map((t) => `  ${localTaskLine(t)}`), ...leftover, `  Landing: ${lockText}; ${leaseText}.`].join("\n");
}

// The command that answers an inbox entry, where there is one: the owner's
// path for a submitted task is atelier land, an accepted one merges (t495).
// It words a waiting entry from a server that sends no command of its own.
export function nextCommand(entry, project) {
  const flag = ` --project ${project}`;
  if (entry.kind === "accept" || entry.kind === "assess") return `atelier land ${entry.itemId} --reviewer ${entry.reviewer ?? "H/M"}${flag}`;
  if (entry.kind === "merge") return `atelier merge ${entry.itemId}${flag}`;
  if (entry.kind === "ship") return `atelier ship --dry-run${flag}`;
  if (entry.kind === "stale") return `atelier release ${entry.itemId}${flag}`;
  // A plan's entries are answered from what the plan shows.
  if (entry.kind === "approve-plan" || entry.kind === "plan-blocked") return `atelier plan show ${entry.itemId}${flag}`;
  return null;
}

// The command for a standing's waiting entry: the one attentionFor gave it
// (null where the call has none), else, from a server before t504 that sends
// only kind and reason, the one nextCommand words.
export const waitingCommand = (w, project) => (w.command !== undefined ? w.command : nextCommand({ ...w, itemId: w.id }, project));

// The lines for the tasks waiting on the owner: each task's id, call and
// title, the one sentence saying what to do, the notice behind it, the
// command where there is one and the link to where the call is made.
export function ownerLines(owner, server = "") {
  const lines = [];
  for (const t of owner) {
    lines.push(`    ${t.id}  ${OWNER_CALL_LABEL[t.call]}  ${t.title}`, `      ${t.sentence}`, `      why: ${t.why}`);
    if (t.command) lines.push(`      next: ${t.command}`);
    lines.push(`      ${absolute(server, t.href)}`);
  }
  return lines;
}

function runnerOf(d) {
  return `${d.to}${d.agent ? ` ${d.agent}` : ""}${d.model ? `/${d.model}` : ""}`;
}

// Whether a runner's offer is live: its runner asked within OFFER_LIVE_MS
// (src/dispatch/rules.ts), the window plan routing and unoffered both read,
// so a runner that asked longer ago than this offers nothing.
export const isLive = (offer, now = Date.now()) => {
  const at = Date.parse(offer.at);
  return Number.isFinite(at) && now - at <= OFFER_LIVE_MS;
};

const ago = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
};

// One runner's line: whether it is live, when it last asked, and the actors
// it offers, so the owner sees what plan routing could pick from. The jobs
// are said as the runner's own first line says them (jobsLine): a config
// narrowed by t252's exact jobs reads as the narrowing it is here too, not a
// bare list the queue's silence has to explain (the 2026-10-07 incident,
// t289). An offer naming no job is an older runner's, which took builds, so
// the line keeps silent about jobs.
export function runnerLine(offer, now = Date.now()) {
  const asked = Date.parse(offer.at);
  const when = Number.isFinite(asked) ? ago(now - asked) : "at an unknown time";
  const live = isLive(offer, now);
  const actors = offer.agents.flatMap((a) => a.models.map((m) => `${a.agent}/${m}`));
  return `${offer.runner}  ${live ? `live, asked ${when}` : `not live, last asked ${when}`}  ${actors.length ? `offers ${actors.join(", ")}` : "offers no model"}${offer.jobs?.length ? `  ${jobsLine(offer.jobs)}` : ""}`;
}

// The runners section of `atelier status`: one line per recorded offer, live
// first, so the owner can see why routing passed a model over (no live runner
// offers it) or what a runner went away from.
export function formatRunners(offers, now = Date.now()) {
  const lines = [...offers].sort((a, b) => Number(isLive(b, now)) - Number(isLive(a, now)) || a.runner.localeCompare(b.runner));
  return ["Runners:", ...lines.map((o) => `  ${runnerLine(o, now)}`)];
}

// The queue's review requests for one project, as lines: each is a submitted
// part waiting for a runner to claim its review, so it stands with the tasks
// waiting for a runner, naming the reviewer asked.
function reviewQueue(waiting, name, offers) {
  return (waiting.queue ?? [])
    .filter((q) => q.project === name && q.item?.dispatch?.job === "review" && q.item.dispatch.agent && q.item.dispatch.model)
    .map((q) => ({
      id: q.item.id,
      title: q.item.title ?? "",
      reviewer: `${q.item.dispatch.agent}/${q.item.dispatch.model}`,
      dispatch: q.item.dispatch,
      dead: offers ? unoffered(q.item.dispatch, offers, waiting.now) : null,
    }));
}

// What each queued job of one project that the core files hold waits on, by
// item id, from the queue's entries (GET /queue).
function heldIn(waiting, name) {
  return new Map((waiting.queue ?? [])
    .filter((q) => q.project === name && q.item?.held && q.item.dispatch?.job !== "review")
    .map((q) => [q.item.id, q.item.held]));
}

// A held job's line: what it waits on, and how it goes ahead — once that
// item merges or is abandoned, or at once, for a task, by the owner's
// override. A plan's part takes no override: the plan dispatches it.
function heldLine(item, held) {
  const next = item.kind === "part" ? "" : `, or at once with atelier dispatch ${item.id} --overlap-ok`;
  return `Held: ${holdText(held)}; offered once ${held.id} merges or is abandoned${next}.`;
}

// One queued job no live runner offers: said as its own line, capitalised,
// for the line above it names the job.
function unofferedLine(dead) {
  return `${dead[0].toUpperCase()}${dead.slice(1)}.`;
}

export function formatStatus(views, waiting = {}) {
  if (!views.length) return "No projects.";
  const offers = Array.isArray(waiting.offers) ? waiting.offers : null;
  const now = waiting.now ?? new Date();
  const lines = [];
  for (const v of views) {
    const a = attentionFor(v.name, v.items, v.inbox, offers, now);
    // Each task is said once: a task waiting on the owner is not listed again
    // as in progress or waiting for a runner.
    const theirs = new Set(a.owner.map((t) => t.id));
    // Tasks not read: the project's line and what attentionFor says of it.
    const items = v.items ?? [];
    const working = items.filter((i) => (i.state === "claimed" || i.state === "submitted") && !theirs.has(i.id));
    const queued = items.filter((i) => i.state === "open" && !i.owner && i.dispatch && !theirs.has(i.id));
    const reviews = reviewQueue(waiting, v.name, offers);
    const held = heldIn(waiting, v.name);
    const deadBuilds = new Map(queued
      .filter((i) => offers && (i.dispatch.agent || i.dispatch.model))
      .map((i) => [i.id, unoffered(i.dispatch, offers, now)])
      .filter(([, dead]) => dead !== null));
    lines.push(v.title ? `${v.title} (${v.name})` : v.name);
    if (!a.owner.length) {
      // With nothing else following, the bare line; otherwise it is worded
      // for the owner, so it does not read against what is listed under it.
      const quiet = !a.pipeline.length && !a.overlaps.length && !reviews.length && !a.unknown.length;
      lines.push(quiet ? "  Nothing waiting." : a.unknown.length ? "  Nothing known to wait on you." : "  Nothing waiting on you.");
    } else lines.push("  Waiting for you", ...ownerLines(a.owner, waiting.server));
    if (a.unknown.length) lines.push("  Not read", ...a.unknown.map((x) => `    ${x}`));
    if (a.pipeline.length) lines.push(`  In the pipeline: ${pipelineLine(a)}; none waits on you.`);
    // Overlapping scopes are counted, not listed: --json names each pair.
    if (a.overlaps.length) lines.push(`  Overlapping scopes: ${a.overlaps.length} ${a.overlaps.length === 1 ? "pair" : "pairs"}; expect a merge conflict when the second lands; nothing waits on you. atelier status --json lists them.`);
    if (working.length) {
      lines.push("  In progress");
      for (const i of working) lines.push(`    ${i.id}  ${i.state}  held by ${i.owner ?? "nobody"}  ${i.title}`);
    }
    // How many merges went in on the owner's override of the independent
    // review, wherever the project has merged anything, then each under it
    // with the link to its page on the server in use (t371).
    const merged = items.filter((i) => i.state === "merged"), byOverride = mergedByOverride(merged);
    if (merged.length) {
      lines.push(`  Merged by override: ${byOverride.length} of ${merged.length} ${merged.length === 1 ? "merge" : "merges"}`);
      for (const i of byOverride) lines.push(`    ${i.id}  ${taskLink(waiting.server, v.name, i.id)}  ${i.title}`);
    }
    if (queued.length || reviews.length) {
      lines.push("  Waiting for a runner");
      for (const i of queued) {
        lines.push(`    ${i.id}  for ${runnerOf(i.dispatch)}  ${i.title}`);
        if (held.has(i.id)) lines.push(`      ${heldLine(i, held.get(i.id))}`);
        const dead = deadBuilds.get(i.id);
        if (dead) lines.push(`      ${unofferedLine(dead)}`);
      }
      for (const r of reviews) {
        lines.push(`    ${r.id}  review by ${r.reviewer}  ${r.title}`);
        if (r.dead) lines.push(`      ${unofferedLine(r.dead)}`);
      }
    }
  }
  if (offers?.length) lines.push("", ...formatRunners(offers, waiting.now ? waiting.now.getTime() : Date.now()));
  return lines.join("\n");
}

// `atelier status --brief`: the report the orchestrator gives the owner after
// each landing, in under 20 lines whatever the project holds. Pure: the caller
// fetches. A brief is { standing, version, queue, lease, usage }: the project's
// standing (GET standing), the server's { commit, routeLevel } (GET
// /api/version) or null, the runner queue (GET /queue) or null, the landing
// lease as landingLease reads it (null, { unreadable } or { item, holder,
// since }), and the usage view (GET /usage: thresholds, reports) or null. What
// could not be read is said so on its own line, never dropped.
const BRIEF_MERGES = 3;
const BRIEF_NAMED = 3;
const oneLine = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const dollars = (n) => `$${n.toFixed(2)}`;

// "t1 a, t2 b, t3 c and 2 more": the first few named, the rest counted.
function named(rows) {
  const shown = rows.slice(0, BRIEF_NAMED).join(", ");
  return rows.length > BRIEF_NAMED ? `${shown} and ${rows.length - BRIEF_NAMED} more` : shown;
}

// Each tool's spend over the last 24 hours, summed over its runners, against
// the owner's daily limit for a tool (USAGE_DAILY_SPEND).
function spendLine(usage) {
  if (!usage || !Array.isArray(usage.reports)) return "Spend: not readable from the server.";
  const limit = typeof usage.thresholds?.dailySpend === "number" ? usage.thresholds.dailySpend : null;
  const byTool = new Map();
  for (const r of usage.reports) {
    const spent = daySpend(r);
    if (spent !== null) byTool.set(r.tool, (byTool.get(r.tool) ?? 0) + spent);
  }
  const of = limit === null ? "no daily limit set" : `limit ${dollars(limit)} a tool a day`;
  if (!byTool.size) return `Spend, last 24 hours: none recorded; ${of}.`;
  const tools = [...byTool].sort((a, b) => b[1] - a[1]);
  const over = tools.filter(([, n]) => limit !== null && n > limit).map(([t]) => oneLine(t));
  const total = tools.reduce((n, [, v]) => n + v, 0);
  return `Spend, last 24 hours: ${dollars(total)} (${named(tools.map(([t, n]) => `${oneLine(t)} ${dollars(n)}`))}); ${of}${over.length ? `; over it: ${over.join(", ")}` : ""}.`;
}

export function formatStatusBrief(b) {
  const s = b.standing;
  const lines = [`${oneLine(s.project.title)} (${oneLine(s.project.name)}) as of ${String(s.generatedAt).slice(0, 16).replace("T", " ")} UTC`];
  lines.push("Recent merges:");
  const merged = s.merged.slice(0, BRIEF_MERGES);
  if (!merged.length) lines.push("  none");
  for (const m of merged) lines.push(`  ${m.id}  ${m.commit ? `${m.commit.slice(0, 8)}  ` : ""}${oneLine(m.title)}`);
  lines.push(b.version
    ? `Deployed: ${b.version.commit ? b.version.commit.slice(0, 8) : "no commit recorded"}, route level ${b.version.routeLevel}.`
    : "Deployed: the server's version could not be read.");
  const building = s.live.filter((i) => i.state === "claimed");
  const submitted = s.live.filter((i) => i.state === "submitted" || i.state === "accepted");
  lines.push(`Live builds: ${building.length ? `${building.length} (${named(building.map((i) => `${i.id} ${oneLine(i.owner ?? "nobody")}`))})` : "none"}.`);
  const requests = (Array.isArray(b.queue) ? b.queue : []).filter((q) => q.project === s.project.name && q.item?.dispatch?.job === "review");
  const reviewing = requests.map((q) => `${q.item.id} by ${oneLine(q.item.dispatch.agent ?? "any")}/${oneLine(q.item.dispatch.model ?? "any")}`);
  const asked = !b.queue ? "the review queue could not be read" : reviewing.length ? `${reviewing.length} waiting for a runner (${named(reviewing)})` : "none waiting for a runner";
  lines.push(`Reviews: ${submitted.length} submitted or accepted${submitted.length ? ` (${named(submitted.map((i) => `${i.id} ${i.state}`))})` : ""}; ${asked}.`);
  const lease = b.lease;
  lines.push(!lease ? "Landing: none running."
    : lease.unreadable ? `Landing: the lease could not be read (${oneLine(lease.unreadable)}).`
      : `Landing: ${lease.item} held by ${lease.holder} since ${lease.since}.`);
  lines.push(`Waiting on the owner: ${s.waiting.length ? named(s.waiting.map((w) => { const next = waitingCommand(w, s.project.name); return `${w.id} ${w.call ?? w.kind}${next ? `; next: ${oneLine(next)}` : ""}`; })) : "nothing"}.`);
  lines.push(spendLine(b.usage));
  return lines.join("\n");
}

// `atelier inbox`: across projects, only what waits on the owner, one entry
// per task with what to do and the link to where it is done; the pipeline and
// overlapping scopes counted in a line each, and what could not be read said.
// A view is { name, title?, items (null when not read), inbox }; `waiting`
// is { offers (null when not read), server, now }.
// One project's notices from GET /inbox?unread=1 as read: the server's
// entries, or null (not read) when the server named the project as one whose
// Ledger it could not read, or when the inbox itself could not be read, so
// attentionFor says the doubt instead of counting nothing. An older server
// answers with the bare list and names no project.
export function projectInbox(read, name) {
  if (Array.isArray(read)) return read;
  if (!read || !Array.isArray(read.entries)) return null;
  return Array.isArray(read.unread) && read.unread.includes(name) ? null : read.entries;
}

export function formatInbox(views, waiting = {}) {
  const lines = [];
  let total = 0;
  for (const v of views) {
    const a = attentionFor(v.name, v.items, v.inbox, waiting.offers ?? null, waiting.now ?? new Date());
    total += a.owner.length;
    if (!a.owner.length && !a.unknown.length) continue;
    lines.push(`${v.title ? `${v.title} (${v.name})` : v.name}: ${a.owner.length} waiting on you${a.unknown.length ? ", and more may be" : ""}`);
    lines.push(...ownerLines(a.owner, waiting.server));
    for (const x of a.unknown) lines.push(`    Not read: ${x}`);
    if (a.pipeline.length) lines.push(`    In the pipeline: ${pipelineLine(a)}; none waits on you.`);
    if (a.overlaps.length) lines.push(`    Overlapping scopes: ${a.overlaps.length} ${a.overlaps.length === 1 ? "pair" : "pairs"}; atelier status --json lists them.`);
  }
  return total || lines.length ? lines.join("\n") : "Nothing needs you.";
}

// The same as JSON, in the shape `atelier inbox --json` printed before t504:
// a list of entries, each with project, itemId, title, kind, reason and
// weight (and reviewer on an assess entry), now one per task that waits on
// the owner, in the rule's order, each adding its call, the sentence, its
// full link, the command and `unknown`, what could not be read in its
// project. `notRead` lists what could not be read per project, which the
// command prints on standard error so a project with no entry is still said.
export function inboxJson(views, waiting = {}) {
  return views.flatMap((v) => {
    const a = attentionFor(v.name, v.items, v.inbox, waiting.offers ?? null, waiting.now ?? new Date());
    return a.owner.map((t) => {
      const legacy = legacyFields(t);
      const notices = (v.inbox ?? []).filter((x) => x.project === v.name && x.itemId === t.id);
      const base = notices.find((x) => x.kind === legacy.kind) ?? notices[0];
      return {
        project: v.name, itemId: t.id, title: t.title, ...legacy,
        weight: Math.max(0, ...notices.map((x) => x.weight ?? 0)),
        ...(base?.reviewer !== undefined ? { reviewer: base.reviewer } : {}),
        ...t, url: absolute(waiting.server, t.href), unknown: a.unknown,
      };
    });
  });
}
export function inboxNotRead(views, waiting = {}) {
  return views.flatMap((v) => attentionFor(v.name, v.items, v.inbox, waiting.offers ?? null, waiting.now ?? new Date()).unknown.map((x) => `${v.name}: ${x}`));
}
