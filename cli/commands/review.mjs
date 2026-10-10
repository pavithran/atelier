// atelier review. Its forms, flags and help are declared in src/usage/commands/review.ts.
import { COMMAND_USAGE } from "../help.mjs";
import { I, actor, args, call, die, itemArg, project, request, short } from "../atelier.mjs";

export default async function reviewCommand() {
  if (!args.approve && !args.reject) die(COMMAND_USAGE.review);
  const name = project(), id = itemArg(), as = await actor();
  const d = await call("GET", I(name, id), undefined, as);
  let findings;
  if (args.findings !== undefined) {
    if (typeof args.findings !== "string" || !args.findings.trim()) die("--findings needs a JSON list of findings");
    try { findings = JSON.parse(args.findings); } catch { die("--findings is not valid JSON"); }
  }
  // The criteria binding is the one the reviewer read, never the task's
  // now: a verdict without it is refused by the server, with how to refresh.
  if (args.criteria !== undefined && !/^[a-f0-9]{64}$/.test(String(args.criteria))) die("--criteria needs the 64-digit binding atelier show prints");
  if (args.request !== undefined && !/^[0-9]+$/.test(String(args.request))) die("--request needs the request number the review claim gave");
  await call("POST", `${I(name, id)}/review`, {
    approve: args.approve === true, note: args.note ?? "", head: args.head ?? d.item.head,
    ...(args.criteria !== undefined ? { criteria: String(args.criteria) } : {}),
    ...(args.request !== undefined ? { request: Number(args.request) } : {}),
    ...(findings !== undefined ? { findings } : {}),
  }, as);
  console.log(`${args.approve ? "Approved" : "Rejected"} ${id} @ ${short(d.item.head)} as ${as}.`);
}
