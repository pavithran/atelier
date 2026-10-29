// atelier base-token. Its forms, flags and help are declared in src/usage/commands/base-token.ts.
import { actor, baseReadGrant, itemArg, project } from "../atelier.mjs";

// A read grant naming the branch the task merges into as defaultBranch
// (POST git-token, kind read).
export default async function baseTokenCommand() {
  const name = project(), id = itemArg(), as = await actor();
  const g = await baseReadGrant(name, id, as);
  console.log(JSON.stringify({ remote: g.remote, token: g.token, defaultBranch: g.defaultBranch }));
}
