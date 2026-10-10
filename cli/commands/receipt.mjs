// atelier receipt. Its forms, flags and help are declared in src/usage/commands/receipt.ts.
import { receiptJson, receiptText } from "../receipt.mjs";
import { I, OWNER, actor, args, call, itemArg, project, server } from "../atelier.mjs";

// The task's whole story from the ledger, in order (cli/receipt.mjs): one
// line per event that says what became of it, the same detail route `show
// --reviews` reads, printed from created to merged or abandoned.
export default async function receiptCommand() {
  const name = project(), id = itemArg(), as = await actor(OWNER);
  const d = await call("GET", I(name, id), undefined, as);
  if (args.json) return console.log(JSON.stringify(receiptJson(name, id, d), null, 2));
  console.log(receiptText(name, id, d, server()));
}
