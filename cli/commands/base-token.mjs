// atelier base-token. Its forms, flags and help are declared in src/usage/commands/base-token.ts.
import { I, actor, call, itemArg, project } from "../atelier.mjs";

export default async function baseTokenCommand() {
  const name = project(), id = itemArg(), as = await actor();
  console.log(JSON.stringify(await call("POST", `${I(name, id)}/base-token`, { scope: "read" }, as)));
}
