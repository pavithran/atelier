// atelier submit. Its forms, flags and help are declared in src/usage/commands/submit.ts.
import { join } from "node:path";
import { I, OWNER_NAME, actor, args, call, cliState, itemArg, project, summaryArg } from "../atelier.mjs";

export default async function submitCommand() {
  summaryArg("submit");
  const name = project(), id = itemArg(), as = await actor();
  await call("POST", `${I(name, id)}/submit`, args.summary === undefined ? {} : { summary: args.summary }, as);
  const d = await call("GET", I(name, id), undefined, as);
  if (cliState.doneStep) return { item: d.item, gate: d.gate };
  console.log(d.gate.ready ? `${id} submitted and ready for ${OWNER_NAME}.` : `${id} submitted. Still blocking:\n${d.gate.blockers.map((b) => `  - ${b}`).join("\n")}`);
}
