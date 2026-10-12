// atelier release. Its forms, flags and help are declared in src/usage/commands/release.ts.
import { I, actor, args, call, itemArg, project } from "../atelier.mjs";

export default async function releaseCommand() {
  const name = project(), id = itemArg(), as = await actor();
  await call("POST", `${I(name, id)}/release`, { note: args.note ?? "" }, as);
  console.log(`${id} released; your write token is revoked.`);
}
