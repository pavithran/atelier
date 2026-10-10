// atelier run-report. Its forms, flags and help are declared in src/usage/commands/run-report.ts.
import { join } from "node:path";
import { OWNER, actor, args, call, die, project } from "../atelier.mjs";

// The project owner records a run that ended without a result the ledger
// saw, for a run outside the runner: an early stop, a permission stop, a
// duplicate design or an incomplete merge, beside stalled, timed-out and
// refused, which the runner reports itself.
export default async function runReportCommand() {
  if (typeof args.actor !== "string" || !args.actor.includes("/")) die('usage: atelier run-report --actor H/M --role build|review --outcome KIND [--project P] [--item ID] [--detail TEXT]');
  const role = args.role === undefined ? "build" : args.role;
  if (!["build", "review"].includes(role)) die('--role must be build or review');
  const outcomes = ["stalled", "timed-out", "refused", "early_stop", "permission_stop", "duplicate_design", "incomplete_merge"];
  if (!outcomes.includes(args.outcome)) die(`--outcome must be one of ${outcomes.join(", ")}`);
  await call("POST", "/runs", {
    actor: args.actor, role, outcome: args.outcome,
    ...(args.project !== undefined ? { project: args.project } : {}),
    ...(args.item !== undefined ? { item: args.item } : {}),
    detail: args.detail ?? "",
  }, OWNER);
  console.log(`Recorded a ${role} run (${args.outcome}) by ${args.actor}${args.project ? ` on ${args.project}${args.item ? `/${args.item}` : ""}` : ""}.`);
}
