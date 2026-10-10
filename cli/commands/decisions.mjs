// atelier decisions. Its forms, flags and help are declared in src/usage/commands/decisions.ts.
import { COMMAND_USAGE } from "../help.mjs";
import { OWNER, P, args, at, call, die, formatDecisions, project } from "../atelier.mjs";

export default async function decisionsCommand() {
  const [, sub, id] = args._;
  const name = project();
  if (sub === "withdraw") {
    if (!id || args._.length !== 3) die(COMMAND_USAGE.decisions);
    if (typeof args.note !== "string" || !args.note.trim()) die(`withdrawing a decision needs a note saying why: atelier decisions withdraw ${id} --note "why"`);
    const d = await call("POST", `${P(name)}/decisions/${encodeURIComponent(id)}/withdraw`, { note: args.note }, OWNER);
    return console.log(`${d.id}: withdrawn ${d.withdrawn.at.slice(0, 10)}; it no longer appears in ${name}'s review briefs or its orchestrator's guide. atelier decisions --all still lists it.`);
  }
  if (sub !== undefined || args.note !== undefined) die(COMMAND_USAGE.decisions);
  const { decisions } = await call("GET", `${P(name)}/decisions`, undefined, OWNER);
  const shown = args.all ? decisions : decisions.filter((d) => d.status === "standing");
  if (!shown.length) {
    return console.log(args.all || !decisions.length
      ? `No standing decision is recorded for ${name}. The owner records one with: atelier decide "text" --quote "the owner's words"`
      : `No decision stands for ${name}; atelier decisions --all lists the withdrawn ones.`);
  }
  console.log(formatDecisions(shown));
}
