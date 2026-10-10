// atelier refresh-failed. Its forms, flags and help are declared in src/usage/commands/refresh-failed.ts.
import { I, actor, args, call, die, itemArg, project } from "../atelier.mjs";

export default async function refreshFailedCommand() {
  const name = project(), id = itemArg(), as = await actor();
  if (typeof args["main-head"] !== "string" || !/^[a-f0-9]{40,64}$/.test(args["main-head"])) die("usage: atelier refresh-failed tP --main-head SHA --reason TEXT [--kind conflict|checks]");
  if (args.kind !== undefined && args.kind !== "conflict" && args.kind !== "checks") die("--kind is conflict or checks");
  const r = await call("POST", `${I(name, id)}/refresh-failed`, { mainHead: args["main-head"], reason: args.reason ?? "", ...(args.kind ? { kind: args.kind } : {}) }, as);
  console.log(JSON.stringify(r));
}
