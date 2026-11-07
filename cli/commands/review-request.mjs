// atelier review-request. Its forms, flags and help are declared in src/usage/commands/review-request.ts.
import { I, OWNER, args, call, die, itemArg, project } from "../atelier.mjs";

// With --reviewer the developer opens that review request, wanted
// whether or not the gate needs it. Without one the server picks none (G17):
// it answers why no review is needed when the gate needs none (a rejection
// stands, the round cap, an approval counted), and otherwise refuses with
// every candidate, its reliability and precision figures, and why each
// refused one is refused (a contributor, a family match, no live offer).
export default async function reviewRequestCommand() {
  const name = project(), id = itemArg();
  const reviewers = (args.multi.reviewer ?? []).filter((r) => r !== undefined);
  // G11: two or more reviewers are asked together, at one head, in one call.
  if (reviewers.length > 1) {
    if (reviewers.some((r) => typeof r !== "string" || !r.includes("/"))) die("--reviewer names the reviewer as harness/model, once per reviewer: atelier review-request ID --reviewer H/M --reviewer H/M");
    const r = await call("POST", `${I(name, id)}/review-request`, { reviewers, wanted: true, ...(args.hand ? { hand: true } : {}) }, OWNER);
    console.log(JSON.stringify(r));
    return;
  }
  if (args.reviewer !== undefined && (typeof args.reviewer !== "string" || !args.reviewer.includes("/"))) die("--reviewer names the reviewer as harness/model: atelier review-request ID --reviewer H/M");
  const named = typeof args.reviewer === "string";
  const r = await call("POST", `${I(name, id)}/review-request`, { ...(named ? { reviewer: args.reviewer, wanted: true } : {}), ...(args.hand ? { hand: true } : {}) }, OWNER);
  if (!named && r.needed === false) die(`${id} needs no review now: ${r.reason}. To ask one all the same, name the reviewer: atelier review-request ${id} --reviewer H/M`);
  console.log(JSON.stringify(r));
}
