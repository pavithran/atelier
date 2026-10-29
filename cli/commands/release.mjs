// atelier release. Its forms, flags and help are declared in src/usage/commands/release.ts.
import { I, actor, args, call, itemArg, project } from "../atelier.mjs";

export default async function releaseCommand() {
  const name = project(), id = itemArg(), as = await actor();
  const r = await call("POST", `${I(name, id)}/release`, { note: args.note ?? "", ...(args.blocked !== undefined ? { blocked: args.blocked } : {}) }, as);
  if (r.already) return console.log(`${id} is already released and nobody holds it; nothing changed.`);
  console.log(`${id} released; your write token is revoked.`);
}
