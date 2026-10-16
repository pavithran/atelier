// atelier accept. Its forms, flags and help are declared in src/usage/commands/accept.ts.
import { I, OWNER, actingHeaders, args, call, directionArg, itemArg, overrideArg, project, short } from "../atelier.mjs";

// --override-review "reason" accepts with the owner's override of a
// missing independent review; the server records it and refuses it where
// nothing is missing. --quote carries the developer's words, which with the
// acting model confirm it without the page's permission (t629).
export default async function acceptCommand() {
  const name = project(), id = itemArg(), reason = overrideArg("accept ID"), direction = reason !== undefined ? directionArg("accept ID --override-review REASON") : {};
  const d = await call("GET", I(name,id), undefined, OWNER);
  const item = await call("POST", `${I(name, id)}/accept`, {head: args.head ?? d.item.head, ...(reason !== undefined ? { overrideReview: reason, ...direction } : {}), ...(typeof args.note === "string" ? { note: args.note } : {})}, OWNER, reason !== undefined ? actingHeaders() : {});
  const overridden = reason !== undefined
    ? item.availableReviewer
      ? `, with the independent review overridden; ${item.availableReviewer} was available to review it instead: atelier land ${id} --reviewer ${item.availableReviewer}`
      : ", with the independent review overridden"
    : "";
  console.log(`${id} accepted at ${short(item.acceptedHead)}${overridden}. Merge it with: atelier merge ${id}`);
}
