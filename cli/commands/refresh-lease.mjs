// atelier refresh-lease. Its forms, flags and help are declared in src/usage/commands/refresh-lease.ts.
import { I, actor, args, call, die, itemArg, project } from "../atelier.mjs";

// The lease a task's refresh runs under (t462), printed as the server answers it.
export default async function refreshLeaseCommand() {
  const name = project(), id = itemArg(), as = await actor();
  if (args.job !== undefined && args.job !== "refresh" && args.job !== "resolve") die("--job is refresh or resolve");
  const r = await call("POST", `${I(name, id)}/refresh-lease`, { job: args.job ?? "refresh", ...(typeof args.runner === "string" ? { runner: args.runner } : {}) }, as);
  console.log(JSON.stringify(r));
}
