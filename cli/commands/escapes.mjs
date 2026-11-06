// atelier escapes. Its forms, flags and help are declared in src/usage/commands/escapes.ts.
import { OWNER, P, args, call, die, flat, project } from "../atelier.mjs";
import { bound, collectEvents } from "./events.mjs";

// Read all history before filtering repair dates: an older approval and
// merge still belong to a repair filed in the requested window.
export function reviewerEscapes(events, since = -Infinity) {
  const approvals = new Map(), merges = new Map(), groups = new Map();
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    const d = e.data ?? {}, id = e.itemId;
    if (e.kind === "item.criteria_changed") {
      for (const key of approvals.keys()) if (JSON.parse(key)[0] === id) approvals.delete(key);
    }
    if (e.kind === "review.retained") approvals.set(JSON.stringify([id, d.head, d.by]), true);
    if (["review.approved", "review.rejected", "review.withdrawn"].includes(e.kind)) {
      const key = JSON.stringify([id, d.head, e.kind === "review.withdrawn" ? d.reviewer : e.actor]);
      approvals.set(key, e.kind === "review.approved");
    }
    if (e.kind === "item.merged") {
      const reviewers = [];
      for (const [key, approved] of approvals) {
        const [item, head, reviewer] = JSON.parse(key);
        if (approved && item === id && head === d.head) reviewers.push(reviewer);
      }
      merges.set(id, { seq: e.seq, reviewers });
    }
    if (e.kind !== "item.fix_of" || Date.parse(e.at) < since) continue;
    const merge = merges.get(d.itemId);
    if (!merge || merge.seq >= e.seq) continue;
    for (const reviewer of merge.reviewers) {
      if (!groups.has(reviewer)) groups.set(reviewer, new Map());
      const tasks = groups.get(reviewer);
      if (!tasks.has(d.itemId)) tasks.set(d.itemId, new Set());
      tasks.get(d.itemId).add(id);
    }
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([reviewer, tasks]) => ({
    reviewer, count: tasks.size,
    tasks: [...tasks].map(([item, fixes]) => ({ item, fixes: [...fixes] })),
  }));
}

export function escapeLines(groups) {
  return groups.length ? groups.flatMap((g) => [
    `${flat(g.reviewer)}: ${g.count} merged task${g.count === 1 ? "" : "s"}`,
    ...g.tasks.map((t) => `  ${flat(t.item)}: fixed by ${t.fixes.map(flat).join(", ")}`),
  ]) : ["No merged tasks with later fixes and recorded approvals."];
}

export default async function escapesCommand() {
  if (args._.length !== 1) die("usage: atelier escapes [--since DATE] [--project NAME]");
  const since = args.since === undefined ? undefined : bound(args.since, "since", false);
  const name = project();
  const events = await collectEvents((before) => call("GET", `${P(name)}/events${before === undefined ? "" : `?before=${before}`}`, undefined, OWNER));
  console.log(escapeLines(reviewerEscapes(events, since)).join("\n"));
}
