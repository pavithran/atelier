// atelier defect. Its forms, flags and help are declared in src/usage/commands/defect.ts.
import { I, OWNER, args, call, die, itemArg, project, short } from "../atelier.mjs";

// The project owner traces a defect to an item's accepted revision. The
// server refuses an item never accepted, and a blank note.
export default async function defectCommand() {
  const name = project(), id = itemArg();
  if (typeof args.note !== "string" || !args.note.trim()) die('a defect needs a note: atelier defect ID --note "what is wrong" [--found-in ID]');
  const item = await call("POST", `${I(name, id)}/defect`, { note: args.note.trim(), ...(args["found-in"] !== undefined ? { foundIn: args["found-in"] } : {}) }, OWNER);
  console.log(`Defect traced to ${id} at ${short(item.acceptedHead)}. It counts against the model that built that revision and each model that approved it; the Models page shows the record.`);
}
