// atelier handoff. Its forms, flags and help are declared in src/usage/commands/handoff.ts.
import { COMMAND_USAGE } from "../help.mjs";
import { I, OWNER, actor, args, call, die, itemArg, project } from "../atelier.mjs";

// With no --as, no ATELIER_ACTOR and no claimed workspace, the developer is
// the one running it (only the developer sends accepted work back to
// building), as for block, so the command acts as the owner like accept and merge.
export default async function handoffCommand() {
  if (!args.to) die(COMMAND_USAGE.handoff);
  const name = project(), id = itemArg(), as = await actor(OWNER);
  const r = await call("POST", `${I(name, id)}/handoff`, { to: args.to, note: args.note ?? "" }, as);
  console.log(`${id} now belongs to ${r.item.owner}. Your write token is revoked.\nNext: ${r.next}`);
}
