// atelier read-token. Its forms, flags and help are declared in src/usage/commands/read-token.ts.
import { I, actor, call, itemArg, project } from "../atelier.mjs";

// Read-only access tokens the runner uses outside a task or review job: the
// item's own fork, or the repository it is measured against.
export default async function readTokenCommand() {
  const name = project(), id = itemArg(), as = await actor();
  console.log(JSON.stringify(await call("POST", `${I(name, id)}/read-token`, {}, as)));
}
