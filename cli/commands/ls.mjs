// atelier ls. Its forms, flags and help are declared in src/usage/commands/ls.ts.
import { itemJson } from "../status.mjs";
import { OWNER, P, actor, args, call, pointToGuide, project, short } from "../atelier.mjs";

// The items as one line each, or as JSON for a machine reader such as
// Observatory, which draws on the times each item carries.
export default async function lsCommand() {
  const name = project();
  const { items } = await call("GET", P(name), undefined, await actor(OWNER));
  const shown = items.filter((i) => args.all || (i.state !== "merged" && i.state !== "abandoned"));
  if (args.json) return console.log(JSON.stringify(shown.map(itemJson), null, 2));
  for (const i of shown) {
    console.log(`${i.id.padEnd(5)} ${i.state.padEnd(10)} ${(i.owner ?? "—").padEnd(26)} ${short(i.head)}  ${i.title}`);
  }
  pointToGuide([name]);
}
