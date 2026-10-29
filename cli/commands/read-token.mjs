// atelier read-token. Its forms, flags and help are declared in src/usage/commands/read-token.ts.
import { actor, itemArg, project, taskReadGrant } from "../atelier.mjs";

// A read grant the runner uses outside a task or review job (POST
// git-token, kind read), with the task's branch, head and base.
export default async function readTokenCommand() {
  const name = project(), id = itemArg(), as = await actor();
  const g = await taskReadGrant(name, id, as);
  console.log(JSON.stringify({ remote: g.remote, token: g.token, defaultBranch: g.defaultBranch, branch: g.branch, head: g.head, base: g.base }));
}
