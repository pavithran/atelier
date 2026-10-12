// atelier refresh-lease. Its forms, flags and help are declared in src/usage/commands/refresh-lease.ts.
import { I, actor, args, call, die, itemArg, project } from "../atelier.mjs";

// The lease a task's refresh runs under (t462), printed as the server
// answers it; with --renew its holder renews it, and with --release gives
// it back with no outcome.
export default async function refreshLeaseCommand() {
  const name = project(), id = itemArg(), as = await actor();
  if (args.job !== undefined && args.job !== "refresh" && args.job !== "resolve") die("--job is refresh or resolve");
  if (args.renew !== undefined && args.release !== undefined) die("use --renew or --release, not both");
  if ((args.renew !== undefined && typeof args.renew !== "string") || (args.release !== undefined && typeof args.release !== "string")) die("--renew and --release name the lease");
  if ((args.reason !== undefined || args["provider-limit"] !== undefined) && typeof args.release !== "string") die("--reason and --provider-limit go with --release");
  const body = typeof args.renew === "string" ? { renew: args.renew }
    : typeof args.release === "string" ? { release: args.release, reason: typeof args.reason === "string" ? args.reason : "", ...(args["provider-limit"] === true ? { providerLimit: true } : {}) }
      : { job: args.job ?? "refresh", ...(typeof args.runner === "string" ? { runner: args.runner } : {}) };
  const r = await call("POST", `${I(name, id)}/refresh-lease`, body, as);
  console.log(JSON.stringify(r));
}
