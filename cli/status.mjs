// The owner's queue as plain text. Pure: the caller fetches, this only formats.
// A view is { name, title?, items, inbox }, where items are the project's items
// and inbox holds the entries the Decisions page lists for it. `offers`, when
// the caller passes them, are the runners' recorded offers (GET /offers): each
// { runner, kind, agents: [{ agent, models }], jobs?, at }, `at` saying when
// the runner last asked.

// An item as `ls --json` and `status --json` print it: what the text listings
// show, with the times a machine reader such as Observatory draws on.
export function itemJson(i) {
  return { id: i.id, title: i.title, state: i.state, owner: i.owner, head: i.head,
    createdAt: i.createdAt, updatedAt: i.updatedAt, lastPushAt: i.lastPushAt };
}

// The queue as JSON: each project with its own decisions, its items each
// carrying its times, and the project's overlapping pairs of tasks, each
// pair once and sorted. Merged and abandoned items are included; a reader
// that wants only live work filters by state.
export function statusJson(views) {
  return views.map((v) => {
    const mine = v.inbox.filter((x) => x.project === v.name);
    return {
      name: v.name,
      ...(v.title ? { title: v.title } : {}),
      inbox: mine,
      items: v.items.map(itemJson),
      overlaps: overlapPairs(mine),
    };
  });
}

// The other task an overlap entry's reason names, or null when the reason is
// worded another way or names the entry's own item: no pair comes of it.
function overlapOther(x) {
  const other = /^scope overlaps (\S+) \(/.exec(x.reason)?.[1];
  return other && other !== x.itemId ? other : null;
}

// The unordered pairs of tasks whose scopes overlap, each pair once, sorted,
// whether the decisions name it from one side or both. One side is the
// entry's item, the other the id its reason names ("scope overlaps t186
// (owner)", as src/rules.ts words it), so an entry worded another way names
// no pair.
function overlapPairs(entries) {
  const seen = new Set();
  const pairs = [];
  for (const x of entries) {
    if (x.kind !== "overlap") continue;
    const other = overlapOther(x);
    if (!other) continue;
    const [a, b] = [x.itemId, other].sort();
    const key = `${a} ${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push([a, b]);
  }
  return pairs.sort((p, q) => p[0].localeCompare(q[0]) || p[1].localeCompare(q[1]));
}

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

// The command that answers an inbox entry, where there is one.
function nextCommand(entry, project) {
  const flag = ` --project ${project}`;
  if (entry.kind === "accept") return `atelier accept ${entry.itemId}${flag}`;
  if (entry.kind === "merge") return `atelier merge ${entry.itemId}${flag}`;
  if (entry.kind === "ship") return `atelier ship --dry-run${flag}`;
  if (entry.kind === "stale") return `atelier release ${entry.itemId}${flag}`;
  // A plan's entries are answered from what the plan shows.
  if (entry.kind === "approve-plan" || entry.kind === "plan-blocked") return `atelier plan show ${entry.itemId}${flag}`;
  return null;
}

function runnerOf(d) {
  return `${d.to}${d.agent ? ` ${d.agent}` : ""}${d.model ? `/${d.model}` : ""}`;
}

// How long an offer stays live after its runner asked (OFFER_FRESH_MS in
// src/dispatch/rules.ts): routing picks from the models live runners offer,
// so a runner that asked longer ago than this offers nothing.
export const OFFER_FRESH_MS = 5 * 60_000;

export const isLive = (offer, now = Date.now()) => {
  const at = Date.parse(offer.at);
  return Number.isFinite(at) && now - at <= OFFER_FRESH_MS;
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
// it offers, so the owner sees what plan routing could pick from.
export function runnerLine(offer, now = Date.now()) {
  const asked = Date.parse(offer.at);
  const when = Number.isFinite(asked) ? ago(now - asked) : "at an unknown time";
  const live = isLive(offer, now);
  const actors = offer.agents.flatMap((a) => a.models.map((m) => `${a.agent}/${m}`));
  return `${offer.runner}  ${live ? `live, asked ${when}` : `not live, last asked ${when}`}  ${actors.length ? `offers ${actors.join(", ")}` : "offers no model"}${offer.jobs?.length ? `  jobs: ${offer.jobs.join(", ")}` : ""}`;
}

// The runners section of `atelier status`: one line per recorded offer, live
// first, so the owner can see why routing passed a model over (no live runner
// offers it) or what a runner went away from.
export function formatRunners(offers, now = Date.now()) {
  const lines = [...offers].sort((a, b) => Number(isLive(b, now)) - Number(isLive(a, now)) || a.runner.localeCompare(b.runner));
  return ["Runners:", ...lines.map((o) => `  ${runnerLine(o, now)}`)];
}

export function formatStatus(views, offers = null) {
  if (!views.length) return "No projects.";
  const lines = [];
  for (const v of views) {
    const mine = v.inbox.filter((x) => x.project === v.name);
    // An overlap notice is not a wait: it says a conflict is likely, not that
    // the owner must decide anything, so it leaves the decisions and stands
    // under its own heading below them. One whose reason names no other task
    // stands under no heading, so it stays among the decisions and the
    // server's word is not lost.
    const decisions = mine.filter((x) => x.kind !== "overlap" || !overlapOther(x));
    const overlaps = overlapPairs(mine);
    const working = v.items.filter((i) => i.state === "claimed" || i.state === "submitted");
    const waiting = v.items.filter((i) => i.state === "open" && !i.owner && i.dispatch);
    lines.push(v.title ? `${v.title} (${v.name})` : v.name);
    if (!decisions.length && !working.length && !waiting.length) {
      // Only overlaps follow, so the idle line is worded for the owner: it
      // would otherwise read against the heading printed under it.
      lines.push(overlaps.length ? "  Nothing waiting on you." : "  Nothing waiting.");
    }
    if (decisions.length) {
      lines.push("  Waiting for you");
      for (const x of decisions) {
        lines.push(`    ${x.itemId}  ${x.kind}  ${x.title}`, `      ${x.reason}`);
        const next = nextCommand(x, v.name);
        if (next) lines.push(`      next: ${next}`);
      }
    }
    if (overlaps.length) {
      lines.push("  Overlapping scopes");
      for (const [a, b] of overlaps) lines.push(`    ${a} and ${b} name overlapping paths`);
      lines.push("    Expect a merge conflict when the second lands; nothing waits on you.");
    }
    if (working.length) {
      lines.push("  In progress");
      for (const i of working) lines.push(`    ${i.id}  ${i.state}  held by ${i.owner ?? "nobody"}  ${i.title}`);
    }
    if (waiting.length) {
      lines.push("  Waiting for a runner");
      for (const i of waiting) lines.push(`    ${i.id}  for ${runnerOf(i.dispatch)}  ${i.title}`);
    }
  }
  if (offers?.length) lines.push("", ...formatRunners(offers));
  return lines.join("\n");
}
