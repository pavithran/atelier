// atelier criteria-finding. Its forms, flags and help are declared in src/usage/commands/criteria-finding.ts.
import { I, OWNER, args, call, die, itemArg, project } from "../atelier.mjs";

// The project owner answers one finding of a criteria review (t438).
export default async function criteriaFindingCommand() {
  const name = project(), id = itemArg();
  const verdict = args.verdict;
  if (!["confirmed", "refuted", "fixed"].includes(verdict)) die("--verdict must be confirmed, refuted or fixed: atelier criteria-finding ID --review N --index N --verdict ...");
  const review = Number(args.review);
  if (!Number.isInteger(review) || review < 1) die("--review needs the criteria review's number: atelier criteria-finding ID --review N --index N --verdict ...");
  const index = Number(args.index);
  if (!Number.isInteger(index) || index < 1) die("--index needs the finding's position in the review, one based: atelier criteria-finding ID --review N --index N --verdict ...");
  await call("POST", `${I(name, id)}/criteria-finding`, { review, index, verdict, note: args.note ?? "" }, OWNER);
  console.log(`Recorded ${verdict} on finding ${index} of criteria review ${review} of ${id}.${verdict === "confirmed" ? " It stands; edit the criteria with atelier edit." : ""}`);
}
