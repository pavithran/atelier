// atelier abandon. Its forms, flags and help are declared in src/usage/commands/abandon.ts.
import { I, OWNER, actingHeaders, actor, args, call, die, directionArg, itemArg, project, tokenActor } from "../atelier.mjs";

// The server clears the owner and revokes the holder's write token, as a
// handoff or a release does. The holder is read first: the answer carries
// the item with its owner already cleared, and an open item has none.
// --quote carries the developer's words (t178), recorded on the event with
// the model (--as) that relayed them; a model acting on the developer token
// without them is stopped by the server, which names the command to run on
// the developer's yes.
export default async function abandonCommand() {
  const name = project(), id = itemArg();
  const direction = directionArg(`abandon ${id}`);
  await actor(OWNER);
  if (direction.quote !== undefined && tokenActor) die("an agent's own token cannot carry the developer's words: --quote goes with the developer token");
  const { item: before } = await call("GET", I(name, id), undefined, OWNER);
  await call("POST", `${I(name, id)}/abandon`, { note: args.note ?? "", ...(typeof args["delivered-by"] === "string" ? { deliveredBy: args["delivered-by"] } : {}), ...direction }, OWNER, actingHeaders());
  const said = direction.quote !== undefined ? ` Recorded on the developer's words, relayed by ${args.as ?? process.env.ATELIER_ACTOR}.` : "";
  console.log(`${before.owner ? `${id} abandoned; ${before.owner}'s write token is revoked.` : `${id} abandoned; nobody held it, so no write token was revoked.`}${said}`);
}
