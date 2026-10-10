// atelier unblock. Its forms, flags and help are declared in src/usage/commands/unblock.ts.
import { I, OWNER, actor, call, flat, itemArg, project } from "../atelier.mjs";

export default async function unblockCommand() {
  const name = project(), id = itemArg();
  const item = await call("POST", `${I(name, id)}/unblock`, {}, await actor(OWNER));
  console.log(`${id} is unblocked and ${flat(item.state)} again.`);
}
