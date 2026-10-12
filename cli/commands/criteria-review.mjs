// atelier criteria-review. Its forms, flags and help are declared in src/usage/commands/criteria-review.ts.
import { I, OWNER, args, call, die, itemArg, project } from "../atelier.mjs";

// Criteria review (t438): the project owner asks for a review of a task's
// acceptance criteria before it is built, by a model of another family
// than every model that wrote them. The server picks the reviewer unless
// one is named, and says why none can be asked.
export default async function criteriaReviewCommand() {
  const name = project(), id = itemArg();
  if (args.reviewer !== undefined && (typeof args.reviewer !== "string" || !args.reviewer.includes("/"))) die("--reviewer needs harness/model: atelier criteria-review ID --reviewer H/M");
  const r = await call("POST", `${I(name, id)}/criteria-review-request`, args.reviewer ? { reviewer: args.reviewer } : {}, OWNER);
  if (r.requested) console.log(`Asked ${r.reviewer} to review ${id}'s acceptance criteria (revision ${r.rev}, criteria review ${r.request}). A runner that offers the criteria-review job takes it; ${r.reason}.`);
  else console.log(`No review was asked: ${r.reason}${r.reviewer ? ` (${r.reviewer}, criteria review ${r.request})` : ""}.`);
}
