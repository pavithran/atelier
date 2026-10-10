// atelier gc. Its forms, flags and help are declared in src/usage/commands/gc.ts.
import { existsSync } from "node:fs";
import { collectCache } from "../gc.mjs";
import { COMMAND_USAGE } from "../help.mjs";
import { CACHE, I, OWNER, P, actor, args, call, die, project } from "../atelier.mjs";

export default async function gcCommand() {
  if (args._.length !== 1 || (args.apply && args["dry-run"])) die(COMMAND_USAGE.gc);
  const name = project(), as = await actor(OWNER);
  const { items } = await call("GET", P(name), undefined, as);
  if (!existsSync(CACHE)) { console.log("No local cache to collect."); return; }
  await collectCache({ cache: CACHE, name, items, apply: args.apply === true,
    getItem: async (id) => (await call("GET", I(name, id), undefined, as)).item });
}
