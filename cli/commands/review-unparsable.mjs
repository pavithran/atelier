// atelier review-unparsable. Its forms, flags and help are declared in src/usage/commands/review-unparsable.ts.
import { readFileSync } from "node:fs";
import { VERDICT_LIMITS } from "../../src/review/verdict.ts";
import { I, actor, args, call, die, itemArg, project } from "../atelier.mjs";

// t407: a reviewer's reply no verdict could be read from is kept on the
// task, its last 100 KB with the reviewer and the head, as the request it
// held goes back to the queue. The reply travels as the file the harness
// wrote, never as an argument, which the operating system caps far below a
// long reply.
export default async function reviewUnparsableCommand() {
  const name = project(), id = itemArg(), as = await actor();
  if (typeof args.head !== "string" || !/^[a-f0-9]{40,64}$/.test(args.head)) die("--head needs the full revision the review read");
  if (typeof args["reply-file"] !== "string" || !args["reply-file"]) die('--reply-file needs the path of the file the harness wrote its reply to');
  let reply;
  try { reply = readFileSync(args["reply-file"], "utf8"); }
  catch (error) { die(`could not read the reply file: ${error.message}`); }
  const r = await call("POST", `${I(name, id)}/review-unparsable`, { head: args.head, note: args.note ?? "", reply: reply.slice(-VERDICT_LIMITS.reply) }, as);
  console.log(`Kept the unparsable review reply on ${id}${r.released === false ? "" : ", and released its review request"}.`);
}
