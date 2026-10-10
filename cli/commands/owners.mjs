// atelier owners. Its forms, flags and help are declared in src/usage/commands/owners.ts.
import { OWNER, P, actor, args, call, project, server } from "../atelier.mjs";

export default async function ownersCommand() {
  const name = project();
  const live = await call("GET", `${P(name)}/owners`, undefined, await actor(OWNER));
  if (args.json) return console.log(JSON.stringify({ project: name, source: server(), owners: live }, null, 2));
  if (!live.length) return console.log(`Atelier: no ${name} item is owned.`);
  for (const o of live) console.log(`Atelier: ${o.item} ${o.state}, owned by ${o.owner ?? "nobody"} since ${o.since.slice(0, 16)}Z (${server()}/p/${name}/${o.item}).`);
}
