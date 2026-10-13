// atelier refresh-checked. Its forms, flags and help are declared in src/usage/commands/refresh-checked.ts.
import { I, actor, args, call, die, itemArg, project } from "../atelier.mjs";

const HASH = /^[a-f0-9]{40,64}$/;

export default async function refreshCheckedCommand() {
  const name = project(), id = itemArg(), as = await actor();
  if (typeof args.lease !== "string" || !["main-head", "expected-head"].every((f) => typeof args[f] === "string" && HASH.test(args[f])) || !!args.passed === !!args.failed) {
    die("usage: atelier refresh-checked tN --lease ID --main-head SHA --expected-head SHA (--passed | --failed --reason TEXT)");
  }
  const r = await call("POST", `${I(name, id)}/refresh-checked`, { lease: args.lease, mainHead: args["main-head"], expectedHead: args["expected-head"], passed: !!args.passed, reason: typeof args.reason === "string" ? args.reason : "" }, as);
  console.log(JSON.stringify(r));
}
