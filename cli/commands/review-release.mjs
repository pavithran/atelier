// atelier review-release. Its forms, flags and help are declared in src/usage/commands/review-release.ts.
import { I, actor, args, call, itemArg, project } from "../atelier.mjs";

export default async function reviewReleaseCommand() {
  const name = project(), id = itemArg(), as = await actor();
  await call("POST", `${I(name, id)}/review-release`, { note: args.note ?? "" }, as);
  console.log(`${id}'s review request released.`);
}
