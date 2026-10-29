// atelier review-request. Its forms, flags and help are declared in src/usage/commands/review-request.ts.
import { I, OWNER, args, call, die, itemArg, project } from "../atelier.mjs";

export default async function reviewRequestCommand() {
  const name = project(), id = itemArg();
  const reviewers = args.multi.reviewer ?? [];
  if (!reviewers.length || reviewers.some((r) => typeof r !== "string" || !r.includes("/"))) die("review-request needs --reviewer H/M, once per reviewer");
  // G11: the reviews a gate needs are asked together, at one head, in one call.
  if (reviewers.length > 1) {
    const r = await call("POST", `${I(name, id)}/review-request`, { reviewers, wanted: true, ...(args.hand ? { hand: true } : {}) }, OWNER);
    console.log(JSON.stringify(r));
    return;
  }
  const r = await call("POST", `${I(name, id)}/review-request`, { reviewer: args.reviewer, wanted: true, ...(args.hand ? { hand: true } : {}) }, OWNER);
  console.log(JSON.stringify(r));
}
