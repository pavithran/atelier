// atelier prereview. Its forms, flags and help are declared in src/usage/commands/prereview.ts.
import { I, OWNER, args, call, die, itemArg, project } from "../atelier.mjs";

// The queued-landing pre-review, asked by the model (G17): once per call, of
// the reviewer it names. Without one the server lists the candidates and refuses.
export default async function prereviewCommand() {
  const name = project(), id = itemArg();
  if (args.reviewer !== undefined && (typeof args.reviewer !== "string" || !args.reviewer.includes("/"))) die(`--reviewer names the reviewer as harness/model: atelier prereview ${id} --reviewer H/M`);
  const r = await call("POST", `${I(name, id)}/prereview`, typeof args.reviewer === "string" ? { reviewer: args.reviewer } : {}, OWNER);
  console.log(`Pre-review ${r.request} of ${id} at ${r.head.slice(0, 8)} asked of ${r.reviewer}${r.attempts > 1 ? ` (asked ${r.attempts} times at this binding)` : ""}. A runner offering the prereview job claims it while ${id} waits behind the lease; atelier show ${id} prints its verdict.`);
}
