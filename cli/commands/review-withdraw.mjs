// atelier review-withdraw. Its forms, flags and help are declared in src/usage/commands/review-withdraw.ts.
import { I, OWNER, args, call, die, itemArg, project } from "../atelier.mjs";

export default async function reviewWithdrawCommand() {
  if (typeof args.reason !== "string" || !args.reason.trim()) die('review-withdraw needs --reason "TEXT": why the request is withdrawn');
  if (args.request !== undefined && (!/^[0-9]+$/.test(String(args.request)) || !Number.isSafeInteger(Number(args.request)) || Number(args.request) < 1)) {
    die("--request needs a review request's number");
  }
  const name = project(), id = itemArg();
  const r = await call("POST", `${I(name, id)}/review-withdraw`, {
    reason: args.reason,
    ...(args.request !== undefined ? { request: Number(args.request) } : {}),
  }, OWNER);
  console.log(`${id}'s review request ${r.request}${r.reviewer ? ` for ${r.reviewer}` : ""} at ${String(r.head).slice(0, 8)} withdrawn: ${r.reason}. Ask another reviewer with atelier land ${id} --reviewer H/M.`);
}
