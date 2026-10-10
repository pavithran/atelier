// atelier approvals. Its forms, flags and help are declared in src/usage/commands/approvals.ts.
import { COMMAND_USAGE } from "../help.mjs";
import { formatApprovals } from "../ship.mjs";
import { OWNER, P, args, call, die, project, short } from "../atelier.mjs";

export default async function approvalsCommand() {
  const [, sub, id] = args._;
  const name = project();
  if (sub === "withdraw") {
    if (!id || args._.length !== 3) die(COMMAND_USAGE.approvals);
    const a = await call("POST", `${P(name)}/actions/${encodeURIComponent(id)}/withdraw`, { note: args.note ?? "" }, OWNER);
    return console.log(`${a.id}: ${a.kind} at ${short(a.commit)} is withdrawn; no ship will use it.`);
  }
  if (sub !== undefined || args.note !== undefined) die(COMMAND_USAGE.approvals);
  const { approvals } = await call("GET", `${P(name)}/actions`, undefined, OWNER);
  const shown = args.all ? approvals : approvals.filter((a) => a.status === "active");
  if (!shown.length) {
    return console.log(args.all || !approvals.length
      ? `No action has been approved for ${name}. The owner approves one with: atelier approve KIND --head SHA`
      : `No approval stands for ${name}; atelier approvals --all lists the used, withdrawn and expired ones.`);
  }
  console.log(formatApprovals(shown));
}
