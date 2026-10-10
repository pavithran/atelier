// atelier finding. Its forms, flags and help are declared in src/usage/commands/finding.ts.
import { I, OWNER, args, call, die, itemArg, project } from "../atelier.mjs";

// The project owner records a verdict on one finding of a review, at the
// head the review was made at and the finding's position in its findings.
export default async function findingCommand() {
  const name = project(), id = itemArg();
  const verdict = args.verdict;
  if (!["confirmed", "refuted", "fixed"].includes(verdict)) die('--verdict must be confirmed, refuted or fixed: atelier finding ID --head SHA --index N --verdict ...');
  if (typeof args.head !== "string" || !/^[a-f0-9]{40,64}$/.test(args.head)) die('--head needs the full revision the review was made at: atelier finding ID --head SHA --index N --verdict ...');
  const index = Number(args.index);
  if (!Number.isInteger(index) || index < 1) die('--index needs the finding\'s position in the review, one based: atelier finding ID --head SHA --index N --verdict ...');
  await call("POST", `${I(name, id)}/finding`, { head: args.head, index, verdict, note: args.note ?? "" }, OWNER);
  console.log(`Recorded ${verdict} on finding ${index} of ${id}'s review at ${args.head.slice(0, 8)}. The Models page counts it under the reviewer.`);
}
