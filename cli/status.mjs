// The owner's queue as plain text. Pure: the caller fetches, this only formats.
// A view is { name, title?, items, inbox }, where items are the project's items
// and inbox holds the entries the Decisions page lists for it.

// The command that answers an inbox entry, where there is one.
function nextCommand(entry, project) {
  const flag = ` --project ${project}`;
  if (entry.kind === "accept") return `atelier accept ${entry.itemId}${flag}`;
  if (entry.kind === "merge") return `atelier merge ${entry.itemId}${flag}`;
  if (entry.kind === "stale") return `atelier release ${entry.itemId}${flag}`;
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
