// atelier decide. Its forms, flags and help are declared in src/usage/commands/decide.ts.
import { COMMAND_USAGE } from "../help.mjs";
import { OWNER, P, args, at, call, die, project } from "../atelier.mjs";

// The project owner records a standing decision for the project
// (src/decisions.ts), with the owner's own words it rests on. The server
// takes it from the owner's token alone.
export default async function decideCommand() {
  const text = args._[1];
  if (args._.length !== 2 || !text?.trim()) die(COMMAND_USAGE.decide);
  if (typeof args.quote !== "string" || !args.quote.trim()) die(`a decision needs the owner's words: atelier decide "text" --quote "what the owner said"`);
  const name = project();
  const d = await call("POST", `${P(name)}/decisions`, { text, quote: args.quote }, OWNER);
  console.log(`${d.id}: recorded ${d.at.slice(0, 10)} for ${name}. Every review brief of ${name} and atelier guide --role orchestrate --project ${name} carry it. To withdraw it: atelier decisions withdraw ${d.id} --note "why"`);
}
