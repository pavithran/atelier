// atelier integration-failed. Its forms, flags and help are declared in src/usage/commands/integration-failed.ts.
import { I, actor, args, call, die, itemArg, project } from "../atelier.mjs";

export default async function integrationFailedCommand() {
  const name = project(), id = itemArg(), as = await actor();
  if (typeof args.part !== "string" || !args.part.trim()) die("usage: atelier integration-failed tP --part KEY --reason TEXT [--kind conflict|checks]");
  if (args.kind !== undefined && args.kind !== "conflict" && args.kind !== "checks") die("--kind is conflict or checks");
  const r = await call("POST", `${I(name, id)}/integration-failed`, { part: args.part, reason: args.reason ?? "", ...(args.kind ? { kind: args.kind } : {}) }, as);
  console.log(JSON.stringify(r));
}
