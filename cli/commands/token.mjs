// atelier token. Its forms, flags and help are declared in src/usage/commands/token.ts.
import { normalizeRunner, promptSecret, storeRunnerCredential } from "../credentials.mjs";
import { COMMAND_USAGE } from "../help.mjs";
import { OWNER, actor, args, call, die, project, server } from "../atelier.mjs";

export default async function tokenCommand() {
  const action = args._[1];
  if (action === "store" && args.runner) {
    const name = normalizeRunner(args.runner);
    const token = await promptSecret("Runner token: ");
    const res = await fetch(`${server()}/api/config`, { headers: { authorization: `Bearer ${token}` } });
    const config = await res.json();
    if (!res.ok || config.runner !== name) die("credential is not an active token for this runner");
    console.log(storeRunnerCredential(server(), name, token));
    return;
  }
  if (action === "issue") {
    if (args.runner && args.as) die("a runner token takes --runner and exactly one --project, not --as");
    if (!args.runner && typeof args.as !== "string") die("token issue needs --as HARNESS/MODEL");
    if (args.days !== undefined && (!Number.isInteger(Number(args.days)) || Number(args.days) < 1 || Number(args.days) > 365)) die("--days needs an integer from 1 to 365");
    const result = await call("POST", "/tokens", {
      ...(args.runner ? { runner: args.runner } : { actor: args.as }), ...(args.multi.project ? { projects: args.multi.project } : {}),
      ...(args.days !== undefined ? { days: Number(args.days) } : {}),
      ...(args.label !== undefined ? { label: args.label } : {}),
    }, OWNER);
    console.log(`Token ${result.id} for ${result.runner ?? result.actor}, expires ${result.expiresAt}`);
    console.log(`This token is not shown again. Set ${result.runner ? "ATELIER_RUNNER_TOKEN" : "ATELIER_TOKEN"} to this value in the session:`);
    console.log(result.token);
  } else if (action === "ls") {
    const tokens = await call("GET", "/tokens", undefined, OWNER);
    console.log(JSON.stringify(tokens.map(({ token, hash, ...record }) => record), null, 2));
  } else if (action === "revoke" && args._[2]) {
    const result = await call("DELETE", `/tokens/${encodeURIComponent(args._[2])}`, {}, OWNER);
    console.log(result.revoked ? "Token revoked." : "No such token.");
  } else die(COMMAND_USAGE.token);
}
