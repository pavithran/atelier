// atelier inbox. Its forms, flags and help are declared in src/usage/commands/inbox.ts.
// What waits on the owner across projects, placed by attentionFor
// (src/attention.ts) from the same inputs Home, the Overview and `atelier
// status` read: each project's items, the server's notices and the runner
// offers. A part not read is said, never counted as nothing.
import { formatInbox, inboxJson, inboxNotRead } from "../status.mjs";
import { OWNER, P, args, call, request, server } from "../atelier.mjs";

export default async function inboxCommand() {
  const [known, entries] = await Promise.all([call("GET", "/projects", undefined, OWNER), call("GET", "/inbox", undefined, OWNER)]);
  const offers = await request("GET", "/runners", undefined, OWNER).catch(() => null);
  const views = await Promise.all(known.map(async (p) => {
    const read = await request("GET", P(p.name), undefined, OWNER).catch(() => null);
    return { name: p.name, title: p.title, items: Array.isArray(read?.items) ? read.items : null, inbox: entries };
  }));
  const waiting = { offers: Array.isArray(offers) ? offers : null, server: server(), now: new Date() };
  if (args.json) {
    for (const x of inboxNotRead(views, waiting)) console.error(`Not read: ${x}`);
    return console.log(JSON.stringify(inboxJson(views, waiting), null, 2));
  }
  console.log(formatInbox(views, waiting));
}
