// atelier start. Its forms, flags and help are declared in src/usage/commands/start.ts.
import { I, actor, call, formatTask, itemArg, project } from "../atelier.mjs";
import claimCommand from "./claim.mjs";

export default async function startCommand() {
  await claimCommand();
  const d = await call("GET", I(project(), itemArg()), undefined, await actor());
  console.log(formatTask(d.item));
}
