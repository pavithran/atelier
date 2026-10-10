// atelier refreshed. Its forms, flags and help are declared in src/usage/commands/refreshed.ts.
import { I, actor, args, call, die, itemArg, project } from "../atelier.mjs";

// The integrator's reports on a refresh of the plan's branch with main's
// head (docs/orchestrator.md, section 5). The server verifies the merge.
export default async function refreshedCommand() {
  const name = project(), id = itemArg(), as = await actor();
  if (typeof args["main-head"] !== "string" || !/^[a-f0-9]{40,64}$/.test(args["main-head"])) die("usage: atelier refreshed tP --main-head SHA [--merge-commit SHA]; --main-head needs the full hash of the main head merged");
  if (args["merge-commit"] !== undefined && (typeof args["merge-commit"] !== "string" || !/^[a-f0-9]{40,64}$/.test(args["merge-commit"]))) die("--merge-commit needs the full merge commit hash");
  const r = await call("POST", `${I(name, id)}/refreshed`, { mainHead: args["main-head"], ...(args["merge-commit"] ? { mergeCommit: args["merge-commit"] } : {}) }, as);
  console.log(JSON.stringify(r));
}
