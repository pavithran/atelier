// atelier finding. Its forms, flags and help are declared in src/usage/commands/finding.ts.
import { I, OWNER, args, call, die, itemArg, project } from "../atelier.mjs";

const USAGE = "atelier finding ID --head SHA [--review-seq N | --reviewer H/M] --index N --verdict ...";

// The project owner records a verdict on one finding of a review, at the
// head the review was made at and the finding's position in its findings.
// --review-seq or --reviewer names the review where more than one at the head
// could be meant; the Ledger refuses an ambiguous one and lists the reviews.
export default async function findingCommand() {
  const name = project(), id = itemArg();
  const verdict = args.verdict;
  if (!["confirmed", "refuted", "fixed"].includes(verdict)) die(`--verdict must be confirmed, refuted or fixed: ${USAGE}`);
  if (typeof args.head !== "string" || !/^[a-f0-9]{40,64}$/.test(args.head)) die(`--head needs the full revision the review was made at: ${USAGE}`);
  const index = Number(args.index);
  if (typeof args.index !== "string" || !/^\d+$/.test(args.index) || !Number.isInteger(index) || index < 1) die(`--index needs the finding's position in the review, one based: ${USAGE}`);
  if (args["review-seq"] !== undefined && args.reviewer !== undefined) die(`name the review by --review-seq or by --reviewer, not both: ${USAGE}`);
  let reviewSeq;
  if (args["review-seq"] !== undefined) {
    reviewSeq = Number(args["review-seq"]);
    if (typeof args["review-seq"] !== "string" || !/^\d+$/.test(args["review-seq"]) || !Number.isInteger(reviewSeq) || reviewSeq < 1) die(`--review-seq needs the review's sequence, a positive integer: ${USAGE}`);
  }
  if (args.reviewer !== undefined && (typeof args.reviewer !== "string" || !args.reviewer.includes("/"))) die(`--reviewer needs the reviewer as harness/model: ${USAGE}`);
  const body = { head: args.head, index, verdict, note: args.note ?? "", ...(reviewSeq !== undefined ? { reviewSeq } : {}), ...(args.reviewer !== undefined ? { reviewer: args.reviewer } : {}) };
  const r = await call("POST", `${I(name, id)}/finding`, body, OWNER);
  // A server from before t486 answers without the review it chose.
  const which = Number.isInteger(r?.review) ? `review ${r.review} by ${r.by}` : "review";
  console.log(`Recorded ${verdict} on finding ${index} of ${id}'s ${which} at ${args.head.slice(0, 8)}. The Models page counts it under the reviewer.`);
}
