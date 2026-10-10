// atelier criteria-verdict. Its forms, flags and help are declared in src/usage/commands/criteria-verdict.ts.
import { COMMAND_USAGE } from "../help.mjs";
import { I, actor, args, call, die, itemArg, project } from "../atelier.mjs";

// The verdict on a claimed criteria review (t438), bound to the revision,
// binding and review the claim gave; the server refuses one the criteria
// have left.
export default async function criteriaVerdictCommand() {
  if (!args.approve && !args.reject) die(COMMAND_USAGE["criteria-verdict"]);
  const name = project(), id = itemArg(), as = await actor();
  const rev = Number(args.rev);
  if (!Number.isInteger(rev) || rev < 1) die("--rev needs the revision the criteria review claim gave");
  if (!/^[a-f0-9]{64}$/.test(String(args.criteria))) die("--criteria needs the 64-digit binding the criteria review claim gave");
  const request = Number(args.request);
  if (!Number.isInteger(request) || request < 1) die("--request needs the criteria review's number the claim gave");
  let findings, checks;
  if (args.findings !== undefined) {
    if (typeof args.findings !== "string" || !args.findings.trim()) die("--findings needs a JSON list of findings");
    try { findings = JSON.parse(args.findings); } catch { die("--findings is not valid JSON"); }
  }
  // The criteria the builder cannot verify in its workspace (t457), each
  // the owner's or the orchestrator's check after deploy.
  if (args.checks !== undefined) {
    if (typeof args.checks !== "string" || !args.checks.trim()) die("--checks needs a JSON list of checks after deploy");
    try { checks = JSON.parse(args.checks); } catch { die("--checks is not valid JSON"); }
  }
  await call("POST", `${I(name, id)}/criteria-review`, {
    approve: args.approve === true, rev, criteria: String(args.criteria), request, note: args.note ?? "",
    ...(findings !== undefined ? { findings } : {}),
    ...(checks !== undefined ? { checks } : {}),
  }, as);
  console.log(`${args.approve ? "Approved" : "Rejected"} ${id}'s acceptance criteria at revision ${rev} as ${as}.`);
}
