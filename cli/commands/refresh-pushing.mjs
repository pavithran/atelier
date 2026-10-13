// atelier refresh-pushing. Its forms, flags and help are declared in src/usage/commands/refresh-pushing.ts.
import { I, actor, args, call, die, itemArg, project } from "../atelier.mjs";

const HASH = /^[a-f0-9]{40,64}$/;

export default async function refreshPushingCommand() {
  const name = project(), id = itemArg(), as = await actor();
  if (typeof args.lease !== "string" || !["main-head", "expected-head", "head"].every((f) => typeof args[f] === "string" && HASH.test(args[f]))) {
    die("usage: atelier refresh-pushing tN --lease ID --main-head SHA --expected-head SHA --head SHA, each SHA a full hash");
  }
  const r = await call("POST", `${I(name, id)}/refresh-pushing`, { lease: args.lease, mainHead: args["main-head"], expectedHead: args["expected-head"], head: args.head }, as);
  console.log(JSON.stringify(r));
}
