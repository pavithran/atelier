// atelier integrated. Its forms, flags and help are declared in src/usage/commands/integrated.ts.
import { I, actor, args, call, die, itemArg, project } from "../atelier.mjs";

// The integrator's reports (docs/orchestrator.md, section 5). Both run as
// atelier/integrator through its token; the server verifies the merge commit.
export default async function integratedCommand() {
  const name = project(), id = itemArg(), as = await actor();
  if (typeof args.part !== "string" || !args.part.trim()) die("usage: atelier integrated tP --part KEY --merge-commit SHA");
  if (typeof args["merge-commit"] !== "string" || !/^[a-f0-9]{40,64}$/.test(args["merge-commit"])) die("--merge-commit needs the full merge commit hash");
  const r = await call("POST", `${I(name, id)}/integrated`, { part: args.part, mergeCommit: args["merge-commit"] }, as);
  console.log(JSON.stringify(r));
}
