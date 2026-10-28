// atelier submit. Its forms, flags and help are declared in src/usage/commands/submit.ts.
import { join } from "node:path";
import { I, OWNER_NAME, actor, args, call, cliState, git, itemArg, project, summaryArg, wsConfig } from "../atelier.mjs";

export default async function submitCommand() {
  summaryArg("submit");
  const name = project(), id = itemArg(), as = await actor();
  // The head the workspace holds, so a rerun of a submit that stands is told
  // apart from a submit of newer work.
  let head;
  if (wsConfig("item") === id) { try { head = git(["rev-parse", "HEAD"]); } catch { /* not a checkout: no head named */ } }
  const sent = await call("POST", `${I(name, id)}/submit`, { ...(args.summary === undefined ? {} : { summary: args.summary }), ...(head ? { head } : {}) }, as);
  const d = await call("GET", I(name, id), undefined, as);
  if (cliState.doneStep) return { item: d.item, gate: d.gate };
  const already = sent.already ? `${id} is already submitted at this head; nothing was recorded again. ` : "";
  console.log(already + (d.gate.ready ? `${id} submitted and ready for ${OWNER_NAME}.` : `${id} submitted. Still blocking:\n${d.gate.blockers.map((b) => `  - ${b}`).join("\n")}`));
}
