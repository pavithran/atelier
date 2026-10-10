// atelier review-claim. Its forms, flags and help are declared in src/usage/commands/review-claim.ts.
import { I, actor, args, call, itemArg, project } from "../atelier.mjs";

export default async function reviewClaimCommand() {
  const name = project(), id = itemArg(), as = await actor();
  const r = await call("POST", `${I(name, id)}/review-claim`, {}, as, args.runner ? { "x-atelier-runner": args.runner } : {});
  console.log(JSON.stringify(r));
}
