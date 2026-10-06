// The owner's queue as plain text. Pure: the caller fetches, this only formats.
// A view is { name, title?, items, inbox }, where items are the project's items
// and inbox holds the entries the Decisions page lists for it.

// An item as `ls --json` and `status --json` print it: what the text listings
// show, with the times a machine reader such as Observatory draws on.
export function itemJson(i) {
  return { id: i.id, title: i.title, state: i.state, owner: i.owner, head: i.head,
    createdAt: i.createdAt, updatedAt: i.updatedAt, lastPushAt: i.lastPushAt };
}

// The queue as JSON: each project with its own decisions and its items, every
// item carrying its times. Merged and abandoned items are included; a reader
// that wants only live work filters by state.
export function statusJson(views) {
  return views.map((v) => ({
    name: v.name,
    ...(v.title ? { title: v.title } : {}),
    inbox: v.inbox.filter((x) => x.project === v.name),
    items: v.items.map(itemJson),
  }));
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

export function formatStatus(views) {
  if (!views.length) return "No projects.";
  const lines = [];
  for (const v of views) {
    const decisions = v.inbox.filter((x) => x.project === v.name);
    const working = v.items.filter((i) => i.state === "claimed" || i.state === "submitted");
    const waiting = v.items.filter((i) => i.state === "open" && !i.owner && i.dispatch);
    lines.push(v.title ? `${v.title} (${v.name})` : v.name);
    if (!decisions.length && !working.length && !waiting.length) lines.push("  Nothing waiting.");
    if (decisions.length) {
      lines.push("  Waiting for you");
      for (const x of decisions) {
        lines.push(`    ${x.itemId}  ${x.kind}  ${x.title}`, `      ${x.reason}`);
        const next = nextCommand(x, v.name);
        if (next) lines.push(`      next: ${next}`);
      }
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
  return lines.join("\n");
}
