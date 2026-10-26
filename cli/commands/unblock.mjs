// atelier unblock. Its forms, flags and help are declared in src/usage/commands/unblock.ts.
import { I, OWNER, actingHeaders, actor, args, call, die, directionArg, flat, itemArg, project, tokenActor } from "../atelier.mjs";

// --quote carries the developer's words (t178): with --as H/M they let the
// developer token alone unblock, recorded on the event under the developer's
// actor with the model that relayed them. An agent's own token cannot carry
// them. Without --quote a model acting on the developer token is stopped by
// the server, which names the command to run on the developer's yes.
export default async function unblockCommand() {
  const name = project(), id = itemArg();
  const direction = directionArg(`unblock ${id}`), said = direction.quote !== undefined;
  const who = await actor(OWNER);
  if (said && tokenActor) die("an agent's own token cannot carry the developer's words: --quote goes with the developer token");
  const item = await call("POST", `${I(name, id)}/unblock`, direction, said ? OWNER : who, said ? actingHeaders() : {});
  console.log(`${id} is unblocked and ${flat(item.state)} again.${said ? ` Recorded on the developer's words, relayed by ${actingHeaders()["x-atelier-acting"]}.` : ""}`);
}
