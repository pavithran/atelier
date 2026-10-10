// atelier revert. Its forms, flags and help are declared in src/usage/commands/revert.ts.
import { runRevert } from "../revert.mjs";
import { COMMAND_USAGE } from "../help.mjs";
import { OWNER, P, actor, args, call, claimWorkspace, die, git, project } from "../atelier.mjs";

export default async function revertCommand() {
  if (args._.length !== 2) die(COMMAND_USAGE.revert);
  const name = project(), as = await actor(OWNER);
  await runRevert(args._[1], as, {
    create: (body) => call("POST", `${P(name)}/items`, body, as),
    claim: (id, who) => claimWorkspace(name, id, who),
    git, say: console.log,
  });
}
