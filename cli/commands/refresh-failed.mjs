// atelier refresh-failed. Its forms, flags and help are declared in src/usage/commands/refresh-failed.ts.
import { readFileSync } from "node:fs";
import { I, actor, args, call, die, itemArg, project } from "../atelier.mjs";

const HASH = /^[a-f0-9]{40,64}$/;

export default async function refreshFailedCommand() {
  const name = project(), id = itemArg(), as = await actor();
  if (typeof args["main-head"] !== "string" || !HASH.test(args["main-head"])) die("usage: atelier refresh-failed tP --main-head SHA --reason TEXT [--kind conflict|checks]");
  // A task refresh's report names its lease (t462).
  if (args.lease !== undefined) {
    if (typeof args.lease !== "string" || typeof args["expected-head"] !== "string" || !HASH.test(args["expected-head"]) || !["mechanical", "returned", "superseded"].includes(args.outcome)) {
      die("usage: atelier refresh-failed tN --lease ID --main-head SHA --expected-head SHA --outcome mechanical|returned|superseded [--report FILE] [--reason TEXT]");
    }
    let report;
    if (args.report !== undefined) {
      try { report = JSON.parse(readFileSync(String(args.report), "utf8")); } catch (error) { die(`--report: ${error.message}`); }
    }
    const r = await call("POST", `${I(name, id)}/refresh-failed`, { lease: args.lease, mainHead: args["main-head"], expectedHead: args["expected-head"], outcome: args.outcome, reason: typeof args.reason === "string" ? args.reason : "", ...(report !== undefined ? { report } : {}) }, as);
    return console.log(JSON.stringify(r));
  }
  if (args.kind !== undefined && args.kind !== "conflict" && args.kind !== "checks") die("--kind is conflict or checks");
  const r = await call("POST", `${I(name, id)}/refresh-failed`, { mainHead: args["main-head"], reason: args.reason ?? "", ...(args.kind ? { kind: args.kind } : {}) }, as);
  console.log(JSON.stringify(r));
}
