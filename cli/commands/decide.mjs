// atelier decide. Its forms, flags and help are declared in src/usage/commands/decide.ts.
import { COMMAND_USAGE } from "../help.mjs";
import { OWNER, P, actingHeaders, args, at, call, die, project } from "../atelier.mjs";

// The project owner records a standing decision for the project
// (src/decisions.ts), with the owner's own words it rests on. The server
// takes it from the owner's token alone.
// With --standing KEY VALUE it records a standing instruction (src/standing.ts,
// G6), the only thing the server or the tick does by itself, for a project in
// fast mode, except models, the session plan in either mode.
export default async function decideCommand() {
  const standing = typeof args.standing === "string" ? { key: args.standing, value: args._[1] } : null;
  const text = args._[1];
  if (args._.length !== 2 || !text?.trim()) die(COMMAND_USAGE.decide);
  if (typeof args.quote !== "string" || !args.quote.trim()) die(standing ? `a standing instruction needs the developer's words: atelier decide --standing ${standing.key} ${standing.value} --quote "what the developer said"` : `a decision needs the developer's words: atelier decide "text" --quote "what the developer said"`);
  const name = project();
  const d = await call("POST", `${P(name)}/decisions`, standing ? { standing, quote: args.quote } : { text, quote: args.quote }, OWNER, actingHeaders());
  if (standing) return console.log(`${d.id}: recorded ${d.at.slice(0, 10)} for ${name}. ${d.text} ${standing.key === "models" ? "unwrap prints this plan in either mode." : `It acts while ${name} is in fast mode.`} To withdraw it: atelier decisions withdraw ${d.id} --note "why"`);
  console.log(`${d.id}: recorded ${d.at.slice(0, 10)} for ${name}. Every review brief of ${name} and atelier guide --role orchestrate --project ${name} carry it. To withdraw it: atelier decisions withdraw ${d.id} --note "why"`);
}
