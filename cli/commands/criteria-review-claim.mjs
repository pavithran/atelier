// atelier criteria-review-claim. Its forms, flags and help are declared in src/usage/commands/criteria-review-claim.ts.
import { I, actor, args, call, itemArg, project } from "../atelier.mjs";

// The reviewer's runner claims the open criteria review (t438) and prints
// what the server gave: the brief, the revision and binding to name, the
// review's number.
export default async function criteriaReviewClaimCommand() {
  const name = project(), id = itemArg(), as = await actor();
  const r = await call("POST", `${I(name, id)}/criteria-review-claim`, {}, as, args.runner ? { "x-atelier-runner": args.runner } : {});
  console.log(JSON.stringify(r));
}
