// atelier accept. Its forms, flags and help are declared in src/usage/commands/accept.ts.
import { I, OWNER, args, call, itemArg, overrideArg, project, short } from "../atelier.mjs";

// --override-review "reason" accepts with the owner's override of a
// missing independent review; the server records it and refuses it where
// nothing is missing.
export default async function acceptCommand() {
  const name = project(), id = itemArg(), reason = overrideArg("accept ID");
  const d = await call("GET", I(name,id), undefined, OWNER);
  const item = await call("POST", `${I(name, id)}/accept`, {head: args.head ?? d.item.head, ...(reason !== undefined ? { overrideReview: reason } : {}), ...(typeof args.note === "string" ? { note: args.note } : {})}, OWNER);
  const overridden = reason !== undefined
    ? item.availableReviewer
      ? `, with the independent review overridden; ${item.availableReviewer} was available to review it instead: atelier land ${id} --reviewer ${item.availableReviewer}`
      : ", with the independent review overridden"
    : "";
  console.log(`${id} accepted at ${short(item.acceptedHead)}${overridden}. Merge it with: atelier merge ${id}`);
}
