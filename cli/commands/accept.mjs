// atelier accept. Its forms, flags and help are declared in src/usage/commands/accept.ts.
import { I, OWNER, actingHeaders, args, call, die, directionArg, itemArg, overrideArg, project, short } from "../atelier.mjs";

// --head takes the full head or the 7 to 39 character prefix that atelier show
// prints; a prefix the task's head starts with stands for that head.
function headArg(current) {
  if (args.head === undefined) return current;
  const given = String(args.head);
  if (!/^[0-9a-f]{7,40}$/i.test(given)) die("--head needs 7 to 40 hex characters of the task's head, as atelier show prints it");
  if (!current?.toLowerCase().startsWith(given.toLowerCase())) die(`stale_head: ${given} is not the task's current head ${short(current)}`);
  return current;
}

// --override-review "reason" accepts with the owner's override of a
// missing independent review; the server records it and refuses it where
// nothing is missing. --quote carries the developer's words, which with the
// acting model confirm it without the page's permission (t629).
export default async function acceptCommand() {
  const name = project(), id = itemArg(), reason = overrideArg("accept ID"), direction = reason !== undefined ? directionArg("accept ID --override-review REASON") : {};
  const d = await call("GET", I(name,id), undefined, OWNER);
  const head = headArg(d.item.head);
  const item = await call("POST", `${I(name, id)}/accept`, {head,...(reason !== undefined ? { overrideReview: reason, ...direction } : {}), ...(typeof args.note === "string" ? { note: args.note } : {})}, OWNER, reason !== undefined ? actingHeaders() : {});
  const overridden = reason !== undefined
    ? item.availableReviewer
      ? `, with the independent review overridden; ${item.availableReviewer} was available to review it instead: atelier land ${id} --reviewer ${item.availableReviewer}`
      : ", with the independent review overridden"
    : "";
  console.log(`${id} accepted at ${short(item.acceptedHead)}${overridden}. Merge it with: atelier merge ${id}`);
}
