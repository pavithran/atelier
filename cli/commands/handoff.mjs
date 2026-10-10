// atelier handoff. Its forms, flags and help are declared in src/usage/commands/handoff.ts.
import { COMMAND_USAGE } from "../help.mjs";
import { I, actor, args, call, die, itemArg, project } from "../atelier.mjs";

export default async function handoffCommand() {
  if (!args.to) die(COMMAND_USAGE.handoff);
  const name = project(), id = itemArg(), as = await actor();
  const r = await call("POST", `${I(name, id)}/handoff`, { to: args.to, note: args.note ?? "" }, as);
  console.log(`${id} now belongs to ${r.item.owner}. Your write token is revoked.\nNext: ${r.next}`);
}
