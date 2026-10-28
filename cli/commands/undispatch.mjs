// atelier undispatch. Its forms, flags and help are declared in src/usage/commands/undispatch.ts.
import { I, OWNER, call, itemArg, project } from "../atelier.mjs";

export default async function undispatchCommand() {
  const name = project(), id = itemArg();
  const r = await call("POST", `${I(name, id)}/undispatch`, {}, OWNER);
  console.log(r.already ? `${id} is already withdrawn from the queue; nothing changed.` : `${id} is no longer waiting for a runner.`);
}
