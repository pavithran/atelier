// atelier design. Its forms, flags and help are declared in src/usage/commands/design.ts.
import { COMMAND_USAGE } from "../help.mjs";
import { OWNER, P, actingHeaders, args, call, die, project } from "../atelier.mjs";

// The developer records how many tasks a design plans (src/designs.ts), with
// the words that approved the plan. The server takes it from the developer's
// token alone and checks the name, the count and the words.
export default async function designCommand() {
  if (args._.length !== 2) die(COMMAND_USAGE.design);
  if (typeof args.planned !== "string" || typeof args.quote !== "string") die(COMMAND_USAGE.design);
  const name = project();
  const planned = /^\d+$/.test(args.planned) ? Number(args.planned) : args.planned;
  const d = await call("POST", `${P(name)}/designs`, { name: args._[1], planned, quote: args.quote }, OWNER, actingHeaders());
  console.log(`Design ${d.name}: ${d.planned} ${d.planned === 1 ? "task" : "tasks"} planned, recorded ${d.at.slice(0, 10)} for ${name}. Words: ${d.quote}`);
}
