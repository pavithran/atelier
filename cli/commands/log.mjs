// atelier log. Its forms, flags and help are declared in src/usage/commands/log.ts.
import { I, OWNER, actor, args, call, itemArg, project } from "../atelier.mjs";
import { printRunnerLog } from "../../src/runner-log.ts";
export default async function logCommand() {
  const name = project(), id = itemArg(), as = await actor(OWNER);
  await printRunnerLog(() => call("GET", `${I(name, id)}/runner-log`, undefined, as), text => console.log(text), !!args.follow);
}
