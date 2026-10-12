// atelier criteria-review-failed. Its forms, flags and help are declared in src/usage/commands/criteria-review-failed.ts.
import { I, actor, args, call, die, itemArg, project } from "../atelier.mjs";

// A claimed criteria review that reached no verdict (t438): recorded as
// failed, so it approves nothing and the criteria may be asked about again.
export default async function criteriaReviewFailedCommand() {
  const name = project(), id = itemArg(), as = await actor();
  const request = Number(args.request);
  if (!Number.isInteger(request) || request < 1) die("--request needs the criteria review's number the claim gave");
  await call("POST", `${I(name, id)}/criteria-review-failed`, { request, note: args.note ?? "" }, as);
  console.log(`Recorded criteria review ${request} of ${id} as failed; it approves nothing.`);
}
