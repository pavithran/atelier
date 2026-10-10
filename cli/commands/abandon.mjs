// atelier abandon. Its forms, flags and help are declared in src/usage/commands/abandon.ts.
import { I, OWNER, args, call, itemArg, project } from "../atelier.mjs";

// The server clears the owner and revokes the holder's write token, as a
// handoff or a release does. The holder is read first: the answer carries
// the item with its owner already cleared, and an open item has none.
export default async function abandonCommand() {
  const name = project(), id = itemArg();
  const { item: before } = await call("GET", I(name, id), undefined, OWNER);
  await call("POST", `${I(name, id)}/abandon`, { note: args.note ?? "", ...(typeof args["delivered-by"] === "string" ? { deliveredBy: args["delivered-by"] } : {}) }, OWNER);
  console.log(before.owner ? `${id} abandoned; ${before.owner}'s write token is revoked.` : `${id} abandoned; nobody held it, so no write token was revoked.`);
}
