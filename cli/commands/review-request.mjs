import { I, OWNER, args, call, die, itemArg, project } from "../atelier.mjs";

export default async function reviewRequestCommand() {
  const name = project(), id = itemArg();
  if (typeof args.reviewer !== "string" || !args.reviewer.includes("/")) die("review-request needs --reviewer H/M");
  const r = await call("POST", `${I(name, id)}/review-request`, { reviewer: args.reviewer, wanted: true }, OWNER);
  console.log(JSON.stringify(r));
}
