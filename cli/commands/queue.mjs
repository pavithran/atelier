// atelier queue. Its forms, flags and help are declared in src/usage/commands/queue.ts.
import { holdText, orphanText } from "../../src/dispatch/rules.ts";
import { notePreview } from "../../src/text.ts";
import { OWNER, apiToken, die, flat, project, resolveTokenActor, server, tokenActor } from "../atelier.mjs";

// Everything waiting for a runner, across projects, oldest first.
export default async function queueCommand() {
  await resolveTokenActor();
  const res = await fetch(server() + "/api/queue", { headers: { authorization: `Bearer ${apiToken()}`, "x-atelier-actor": tokenActor ?? OWNER } });
  if (!res.ok) die(`queue: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const incomplete = res.headers.get("x-atelier-incomplete");
  if (incomplete) console.log(`Could not read: ${incomplete}. Tasks waiting there are not listed.`);
  const queued = await res.json();
  if (!queued.length) return console.log("Nothing is waiting for a runner.");
  for (const { project, item } of queued) {
    const d = item.dispatch;
    console.log(`${project}/${item.id}  for ${d.to}${d.agent ? ` ${d.agent}` : ""}${d.model ? `/${d.model}` : ""}${d.job === "merge-main" ? "  merge-main" : ""}  ${item.title}`);
    const preview = notePreview(d.note);
    if (preview) console.log(`  note: ${flat(preview)}`);
    // A claim whose runner stopped polling holds nothing (t537): said in
    // the hold's text when a live blocker holds the task too, else alone.
    if (item.held) console.log(`  held: ${holdText(item.held, project)}`);
    else if (item.orphaned?.length) console.log(`  held: ${orphanText(item.orphaned, project)}`);
  }
}
