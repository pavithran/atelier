// atelier inbox. Its forms, flags and help are declared in src/usage/commands/inbox.ts.
import { I, OWNER, actor, args, call, formatBrief, project, server } from "../atelier.mjs";

export default async function inboxCommand() {
  const entries = await call("GET", "/inbox", undefined, OWNER);
  if (args.json) return console.log(JSON.stringify(entries, null, 2));
  if (!entries.length) return console.log("Nothing needs you.");
  const seen = new Set();
  for (const x of entries) {
    const key = `${x.project}/${x.itemId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const brief = await call("GET", `${I(x.project, x.itemId)}/brief`, undefined, await actor(OWNER));
    console.log(formatBrief(x.project, x.itemId, brief, server()) + "\n");
  }
}
