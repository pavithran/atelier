// atelier review-release. Its forms, flags and help are declared in src/usage/commands/review-release.ts.
import { I, actor, args, call, die, itemArg, project } from "../atelier.mjs";

export default async function reviewReleaseCommand() {
  if (args.request !== undefined && (!/^[0-9]+$/.test(String(args.request)) || !Number.isSafeInteger(Number(args.request)) || Number(args.request) < 1)) {
    die("--request needs the request number the review claim gave");
  }
  const name = project(), id = itemArg(), as = await actor();
  await call("POST", `${I(name, id)}/review-release`, {
    note: args.note ?? "",
    ...(args.request !== undefined ? { request: Number(args.request) } : {}),
  }, as);
  console.log(`${id}'s review request released.`);
}
