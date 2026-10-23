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
// files hold (coreBlockers there) names every claimed or landing item it waits on, as the
// queue's entry for it carries that. The offers (GET /runners) are each
// { runner, kind, agents: [{ agent, models }], jobs?, at }, `at` saying when
// the runner last asked, and a Runners section lists them after the projects,
// each named runner's jobs said as the runner's own first line says them
// (jobsLine in cli/runner.mjs): the jobs it takes and, behind them, the known
// jobs it does not.
import { DEFAULT_THRESHOLDS, isStale, lowBalances, windowShortages } from "../src/usage/report.ts";
import { holdRelease, holdText, OFFER_LIVE_MS, unoffered } from "../src/dispatch/rules.ts";
import { openStuck } from "../src/stuck/view.ts";
import { stripVTControlCharacters } from "node:util";
import { directionText, expiredBlocks, forkAgeText, mergedByOverride, stageOf } from "../src/rules.ts";
import { attentionFor, legacyFields, OWNER_CALL_LABEL, pipelineLine } from "../src/attention.ts";
import { daySpend } from "../src/usage/report.ts";
import { jobsLine } from "./runner.mjs";

// A task's stage is stageOf's (src/rules.ts) and nothing here decides one.
// `ready` is the fast-build reports the project's mode route lists
// (GET /p/NAME/mode, `ready`); a list read without them is told as none.
export const readyOf = (mode) => (Array.isArray(mode?.ready) ? mode.ready : []);

export function stageEntries(items, ready = [], facts = () => ({})) {
  return (items ?? [])
    .filter((i) => i.state !== "merged" && i.state !== "abandoned")
    .map((i) => ({ id: i.id, title: i.title, ...stageOf(i, { ready: ready.find((r) => r.item === i.id) ?? null, ...facts(i) }) }));
}

// "built" or "built at a1b2c3d4 on mac-mini in /work/t1".
export function stageText({ stage, detail }) {
  const where = [detail?.head ? `at ${detail.head.slice(0, 8)}` : "", detail?.machine ? `on ${detail.machine}` : "", detail?.path ? `in ${detail.path}` : ""].filter(Boolean).join(" ");
  return where ? `${stage} ${where}` : stage;
}

export function stageLines(entries, indent = "  ") {
  return entries.length ? [`${indent}Stages`, ...entries.map((e) => `${indent}  ${stageText(e)}: ${e.id}  ${e.title}`)] : [];
}

export function formatPolicyDisagreements(mismatches = []) {
  if (!mismatches.length) return "";
  return ["  Policy and instructions disagree", ...mismatches.map((m) => `    ${m}`),
    "    Settle which is right; agents are held to the recorded policy."].join("\n");
}

// A project's model policy in words (ProjectPolicy.familyMode, t394): the
// default, cross-family review, or single-family mode naming the company,
// with who switched and when where a switch is recorded. `atelier init`
// prints it after the policy it sent.
export function familyModeText(policy) {
  const mode = policy?.familyMode ?? null;
  const when = mode ? ` (set by ${mode.by} at ${mode.at})` : "";
  if (mode?.single) return `single-family, ${mode.single}: building and reviewing use ${mode.single} models only, and a review counts from a different ${mode.single} model than every contributor${when}`;
  return `cross-family, the default: a protected change needs approval from a model of another company than every contributor${when}`;
}

// The line a status listing prints under a project in single-family mode,
// so no one mistakes its reviews for cross-company ones.
export const singleFamilyLine = (family) =>
  `Single-family mode (${family}): building and reviewing use ${family} models only; a review counts from a different ${family} model than every contributor, not from another company.`;

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
    createdAt: i.createdAt, updatedAt: i.updatedAt, lastPushAt: i.lastPushAt,
    // A fork Artifacts is still preparing (t18), only while there is one.
    ...(i.preparing ? { preparing: i.preparing } : {}) };
}

// What the server says of a task fork that is not ready yet (t18): which
// repository, for how long, and what happens next.
export const preparingLine = (p) => `${flatText(p.fork)} has been preparing for ${forkAgeText(p.ageMs)}. ${flatText(p.next)}`;

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
      ...(v.policy?.familyMode?.single ? { singleFamily: v.policy.familyMode.single } : {}),
      // Fast mode's line while it stands (t629: with the developer's words and the acting model).
      ...(v.mode ? { mode: v.mode } : {}),
      // Each null when not read, which attention.unknown words; never an
      // empty list standing for nothing.
      inbox: v.inbox ? mine : null,
      items: v.items ? v.items.map(itemJson) : null,
      stages: v.items ? stageEntries(v.items, v.ready).map(({ id, stage, detail }) => ({ id, stage, detail })) : null,
      ...(v.mismatches?.length ? { mismatches: v.mismatches } : {}),
      // The developer's branches (t641), when they were read.
      ...(Array.isArray(v.branches) ? { branches: v.branches } : {}),
      overlaps: a.overlaps,
      attention: { owner: a.owner.map((t) => ({ ...t, url: absolute(server, t.href) })), pipeline: a.pipeline, unknown: a.unknown },
      // The merges that went in on the owner's override, each with the link
      // to its page (t371).
      mergedByOverride: mergedByOverride(v.items ?? []).map((i) => ({ id: i.id, url: taskLink(server, v.name, i.id) })),
      // Added last so the older keys keep their places (t198).
      ...(v.stuck ? { stuck: v.stuck } : {}),
    };
  });
}

// What a merge by override says after its link and title, in `atelier
// status` and `status --project` alike: the reason, and, for an override on
// the developer's direction (t629), their words and the model that relayed
// them. Text a person or agent wrote is flattened to one line.
const flatText = (value) => stripVTControlCharacters(String(value)).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").trim();
export function overrideTail(o) {
  return `  reason: ${flatText(o.reason)}${o.quote ? `  ${flatText(directionText({ quote: o.quote, acting: o.acting }))}` : ""}`;
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
    ? [`  ${local.leftover} ${local.leftover === 1 ? "workspace" : "workspaces"} of merged or abandoned tasks left here; atelier clean --project ${local.project} removes those whose work is in main or the ledger`]
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
  if (entry.kind === "gave-up") return `atelier dispatch ${entry.itemId}${flag}`;
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

// Why each queued job of one project is not being taken, by item id, from the
// queue's entries (GET /queue): the server attaches `why`, the reasons in
// words (unclaimed in src/dispatch/rules.ts), for the owner's listing.
function whyIn(waiting, name, offers) {
  return new Map((waiting.queue ?? [])
    .filter((q) => q.project === name && q.item?.id && q.item.dispatch?.job !== "review")
    .map((q) => [q.item.id, queueReasons(q.item, offers, waiting.now)])
    .filter(([, why]) => why.length));
}

// The reasons one queue entry carries. A server from before t420 sends no
// `why`, only `held`, the core-file hold, so against one the hold is said as
// it said it then, and a model no live runner offers is worked out here from
// the offers, as status did before the server said it; show, which reads no
// offers, says the hold alone.
export function queueReasons(item, offers = null, now = new Date()) {
  if (Array.isArray(item.why)) return item.why;
  const out = [];
  if (item.held) out.push({ kind: "held", line: heldLine(item, item.held) });
  const dead = offers && item.dispatch && (item.dispatch.agent || item.dispatch.model) ? unoffered(item.dispatch, offers, now) : null;
  if (dead) out.push({ kind: "unoffered", line: unofferedLine(dead) });
  return out;
}

// A held job's line: what it waits on, and how it goes ahead — once every
// blocker stops holding (a claimed one submits or is released, a landing
// ends), or at once, for a task, by the owner's override. A plan's part takes
// no override: the plan dispatches it.
function heldLine(item, held) {
  const next = item.kind === "part" ? "" : `, or at once with atelier dispatch ${item.id} --overlap-ok`;
  return `Held: ${holdText(held)}; ${holdRelease(held)}${next}.`;
}

// One queued job no live runner offers: said as its own line, capitalised,
// for the line above it names the job.
function unofferedLine(dead) {
  return `${dead[0].toUpperCase()}${dead.slice(1)}.`;
}

// The one line that stands for a project's expired blocks (--until has passed,
// UTC): each id with the commands that lift or close it, project-qualified.
// The tasks stay blocked; this only replaces their rows. Null when none.
export function expiredBlocksLine(project, ids) {
  if (!ids.length) return null;
  const flag = ` --project ${project}`;
  return `Expired blocks: ${ids.map((id) => `${id} (unblock: atelier unblock ${id}${flag}; abandon: atelier abandon ${id}${flag})`).join(", ")}`;
}

// What `atelier clean` would remove, one line per project that has anything to
// remove or could not be inspected: [{ project, count }], count null when
// unknown. A project at zero has no line (t58).
export function cleanLines(counts) {
  return counts.filter((c) => c.count !== 0).map((c) => c.count === null
    ? `Clean-up: unknown for ${c.project}; its local directories could not be inspected. atelier clean --project ${c.project} shows them.`
    : `Clean-up: atelier clean --project ${c.project} would remove ${c.count} local ${c.count === 1 ? "directory" : "directories"}.`);
}

// Reads one project's open stuck episodes (t198): `get` is a function from a
// path to the answer, or null when the read failed.
export async function readStuck(get, base, name, items) {
  const [report, transitions] = await Promise.all([get(`${base}/stuck`), get(`${base}/stuck/episodes`)]);
  return openStuck(name, report && Array.isArray(report.entries) ? report : null, Array.isArray(transitions) ? transitions : null, items);
}
const stuckTime = (t) => (t === "unknown" ? "unknown" : branchTime(t));
// Open stuck episodes, listed before any ordinary item. `stuck` is openStuck's
// view (src/stuck/view.ts), or absent when it was not asked for. Anything
// unread is said, never shown as nothing stuck.
export function stuckLines(stuck, indent = "  ") {
  if (!stuck) return [];
  const out = [];
  if (stuck.rows.length) {
    out.push(`${indent}Stuck`);
    for (const r of stuck.rows) {
      out.push(`${indent}  ${flatText(r.item)}  ${flatText(r.cause)}: ${flatText(r.reason)}`);
      out.push(`${indent}    First seen ${stuckTime(r.firstSeen)}${r.firstSeen === "unknown" && r.since !== "unknown" ? `; the cause dates from ${stuckTime(r.since)}` : ""}`);
      out.push(`${indent}    Evidence: ${flatText(r.evidence)}`);
      out.push(`${indent}    Next: ${flatText(r.next)}`);
    }
  }
  for (const x of stuck.notRead) out.push(`${indent}Stuck work: ${x} unknown (not read)`);
  return out;
}

export function formatStatus(views, waiting = {}) {
  if (!views.length) return "No projects.";
  const offers = Array.isArray(waiting.offers) ? waiting.offers : null;
  const now = waiting.now ?? new Date();
  const lines = [];
  for (const v of views) {
    const a = attentionFor(v.name, v.items, v.inbox, offers, now);
    // A block whose --until has passed is one line, not a row, and is still
    // blocked (t58); a task blocked for another reason keeps its row.
    const expired = new Set(expiredBlocks(v.items, now));
    const owner = a.owner.filter((t) => !(t.call === "unblock" && expired.has(t.id)));
    const expiredLine = expiredBlocksLine(v.name, a.owner.filter((t) => t.call === "unblock" && expired.has(t.id)).map((t) => t.id));
    // Each task is said once: a task waiting on the owner is not listed again
    // as in progress or waiting for a runner.
    const theirs = new Set(a.owner.map((t) => t.id));
    // Tasks not read: the project's line and what attentionFor says of it.
    const items = v.items ?? [];
    const working = items.filter((i) => (i.state === "claimed" || i.state === "submitted") && !theirs.has(i.id));
    const queued = items.filter((i) => i.state === "open" && !i.owner && i.dispatch && !theirs.has(i.id));
    const reviews = reviewQueue(waiting, v.name, offers);
    const why = whyIn(waiting, v.name, offers);
    lines.push(v.title ? `${v.title} (${v.name})` : v.name);
    if (v.policy?.familyMode?.single) lines.push(`  ${singleFamilyLine(v.policy.familyMode.single)}`);
    // Fast mode, as status --project prints it (t629).
    if (v.mode) lines.push(`  ${flatText(v.mode)}`);
    lines.push(...stuckLines(v.stuck));
    if (!owner.length) {
      // With nothing else following, the bare line; otherwise it is worded
      // for the owner, so it does not read against what is listed under it.
      const quiet = !a.pipeline.length && !a.overlaps.length && !reviews.length && !a.unknown.length;
      if (!expiredLine) lines.push(quiet ? "  Nothing waiting." : a.unknown.length ? "  Nothing known to wait on you." : "  Nothing waiting on you.");
    } else lines.push("  Waiting for you", ...ownerLines(owner, waiting.server));
    if (expiredLine) lines.push(`  ${expiredLine}`);
    if (a.unknown.length) lines.push("  Not read", ...a.unknown.map((x) => `    ${x}`));
    if (v.mismatches?.length) lines.push(formatPolicyDisagreements(v.mismatches));
    if (a.pipeline.length) lines.push(`  In the pipeline: ${pipelineLine(a)}; none waits on you.`);
    lines.push(...stageLines(stageEntries(v.items, v.ready)));
    // Overlapping scopes are counted, not listed: --json names each pair.
    if (a.overlaps.length) lines.push(`  Overlapping scopes: ${a.overlaps.length} ${a.overlaps.length === 1 ? "pair" : "pairs"}; expect a merge conflict when the second lands; nothing waits on you. atelier status --json lists them.`);
    if (working.length) {
      lines.push("  In progress");
      for (const i of working) lines.push(`    ${i.id}  ${i.state}  held by ${i.owner ?? "nobody"}  ${i.title}`);
    }
    const preparing = items.filter((i) => i.preparing && i.state !== "merged" && i.state !== "abandoned");
    if (preparing.length) {
      lines.push("  Waiting for a fork");
      for (const i of preparing) lines.push(`    ${i.id}  ${preparingLine(i.preparing)}`);
    }
    // How many merges went in on the owner's override of the independent
    // review, wherever the project has merged anything, then each under it
    // with the link to its page on the server in use (t371).
    const merged = items.filter((i) => i.state === "merged"), byOverride = mergedByOverride(merged);
    if (merged.length) {
      lines.push(`  Merged by override: ${byOverride.length} of ${merged.length} ${merged.length === 1 ? "merge" : "merges"}`);
      for (const i of byOverride) lines.push(`    ${i.id}  ${taskLink(waiting.server, v.name, i.id)}  ${i.title}${overrideTail(i.reviewOverride)}`);
    }
    if (queued.length || reviews.length) {
      lines.push("  Waiting for a runner");
      for (const i of queued) {
        lines.push(`    ${i.id}  for ${runnerOf(i.dispatch)}  ${i.title}`);
        for (const reason of why.get(i.id) ?? []) lines.push(`      ${reason.line}`);
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
  const mode = s.familyMode?.single ? ` (single-family: ${s.familyMode.single})` : "";
  const lines = [`${oneLine(s.project.title)} (${oneLine(s.project.name)})${mode} as of ${String(s.generatedAt).slice(0, 16).replace("T", " ")} UTC`];
  const partial = s.partial ?? [];
  if (partial.length) lines.push(`Part of this record is not shown; counts cover only what was read: ${partial.map(oneLine).join(" ")}`);
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
  lines.push(`Waiting on the developer: ${s.waiting.length ? named(s.waiting.map((w) => { const next = waitingCommand(w, s.project.name); return `${w.id} ${w.call ?? w.kind}${next ? `; next: ${oneLine(next)}` : ""}`; })) : partial.length ? "nothing known" : "nothing"}${partial.length ? "; more may be waiting" : ""}.`);
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
    const stages = stageEntries(v.items, v.ready);
    // A project with nothing waiting is left out unless a fast build of it ended ready
    // and waits to be merged.
    const stuck = stuckLines(v.stuck, "    ");
    if (!a.owner.length && !a.unknown.length && !stuck.length && !stages.some((e) => e.detail.source === "fast_ready")) continue;
    lines.push(`${v.title ? `${v.title} (${v.name})` : v.name}: ${a.owner.length} waiting on you${a.unknown.length ? ", and more may be" : ""}`);
    lines.push(...stuck);
    lines.push(...ownerLines(a.owner, waiting.server));
    for (const x of a.unknown) lines.push(`    Not read: ${x}`);
    if (a.pipeline.length) lines.push(`    In the pipeline: ${pipelineLine(a)}; none waits on you.`);
    lines.push(...stageLines(stages, "    "));
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

// The developer's branches (t641): each one's name, its last commit as the
// branches repository held it after the push, and the Mac it was pushed
// from, newest push first. `branches` is the list GET branches answers, or
// null when it was not read (a server without them, or one that could not
// answer), which is said rather than shown as none.
const branchTime = (iso) => (typeof iso === "string" && iso.length >= 16 ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : "an unrecorded time");
export function branchLine(b) {
  const subject = flatText(b.subject ?? "");
  return `${b.name}  ${String(b.commit).slice(0, 8)}${subject ? `  ${subject.length > 60 ? `${subject.slice(0, 59)}…` : subject}` : ""}  (from ${flatText(b.host)}, ${branchTime(b.pushedAt)})`;
}
export function formatDeveloperBranches(branches, indent = "  ") {
  if (branches === null || branches === undefined) return `${indent}Developer branches: not read (the server keeps none, or could not answer)`;
  if (!branches.length) return `${indent}Developer branches: none (atelier branch push NAME carries one to your other Macs)`;
  return [`${indent}Developer branches`, ...branches.map((b) => `${indent}  ${branchLine(b)}`)].join("\n");
}
// Every project's branches, for `atelier status`: a section when some
// project has one or some project's could not be read, each line led by its
// project, and the projects not read named on one line, so a branch that
// could not be read is never shown as none (Astra's review of t641).
export function formatAllDeveloperBranches(views) {
  const lines = views.flatMap((v) => (Array.isArray(v.branches) ? v.branches.map((b) => `  ${v.name}  ${branchLine(b)}`) : []));
  const unread = views.filter((v) => !Array.isArray(v.branches)).map((v) => v.name);
  if (unread.length) lines.push(`  not read for ${unread.join(", ")} (the server keeps none, or could not answer)`);
  return lines.length ? ["Developer branches", ...lines].join("\n") : "";
}

// The usage warnings `atelier status` prints first: each vendor window at 80
// percent used or heading for its limit before it resets, from the usage
// reports the server holds, in the rule's words (src/rules.ts usageShortages).
// A report older than the stale limit is said to be stale instead of read as
// healthy. null when the server could not answer.
export function formatUsageWarnings(usage, now = Date.now()) {
  if (!usage || !Array.isArray(usage.reports)) return [];
  const lines = [];
  for (const r of usage.reports) {
    if (isStale(r, now)) { lines.push(`${r.tool} on ${r.runner}: not reported since ${String(r.at).slice(0, 16)}Z, so its usage is not known`); continue; }
    const t = { ...DEFAULT_THRESHOLDS, ...usage.thresholds };
    for (const s of windowShortages(r, t, now)) lines.push(s.message);
    const floor = t.balanceFloor;
    for (const b of lowBalances(r, floor)) lines.push(`${r.tool} on ${r.runner}: balance ${b.amount} ${b.currency}, below ${floor}`);
  }
  return lines.length ? ["Usage warnings:", ...lines.map((l) => `  ${l}`)] : [];
}
