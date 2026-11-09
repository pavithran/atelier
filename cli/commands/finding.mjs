// atelier finding. Its forms, flags and help are declared in src/usage/commands/finding.ts.
import { I, OWNER, actingHeaders, args, call, die, itemArg, project } from "../atelier.mjs";

const USAGE = "atelier finding ID --head SHA [--review-seq N | --reviewer H/M] --index N --verdict ... [--as H/M]";
// The fixed causes (src/review/verdict.ts FINDING_CAUSES).
const CAUSES = ["spec", "wiring", "failure-path", "coding", "tests", "docs"];
const CAUSE_USAGE = `atelier finding ID --index N --cause ${CAUSES.join("|")} [--head SHA] [--review-seq N | --reviewer H/M], or atelier finding ID --failure N --cause ...`;

// --cause corrects the cause of a blocking finding (--index) or sets the cause
// of a failed required check (--failure, the sequence of its
// check.failed_tests record). The server records who changed it and from what.
async function causeCommand(name, id) {
  if (args.verdict !== undefined) die(`record a verdict and a cause with two commands: ${CAUSE_USAGE}`);
  if (typeof args.cause !== "string" || !CAUSES.includes(args.cause)) die(`--cause must be one of ${CAUSES.join(", ")}: ${CAUSE_USAGE}`);
  const whole = (flag, text) => {
    const value = args[flag];
    if (typeof value !== "string" || !/^\d+$/.test(value) || Number(value) < 1) die(`${text}: ${CAUSE_USAGE}`);
    return Number(value);
  };
  if (args.failure !== undefined) {
    if (args.index !== undefined || args.head !== undefined || args["review-seq"] !== undefined || args.reviewer !== undefined) die(`--failure names a failed check; it takes no --index, --head, --review-seq or --reviewer: ${CAUSE_USAGE}`);
    const failure = whole("failure", "--failure needs the sequence of the failed-check record, a positive integer");
    const r = await call("POST", `${I(name, id)}/check-cause`, { failure, cause: args.cause }, OWNER, actingHeaders());
    const who = r.acting ? `, set by ${r.acting}` : "";
    console.log(r.event === null ? `The cause of ${id}'s failed check ${failure} is already ${r.cause}; nothing recorded.` : `Recorded cause ${r.cause} (was ${r.from}) on ${id}'s failed check ${failure} as event ${r.event}${who}.`);
    return;
  }
  const index = whole("index", "--index needs the finding's position in the review, one based");
  if (args.head !== undefined && (typeof args.head !== "string" || !/^[a-f0-9]{40,64}$/.test(args.head))) die(`--head needs the full revision the review was made at: ${CAUSE_USAGE}`);
  if (args["review-seq"] !== undefined && args.reviewer !== undefined) die(`name the review by --review-seq or by --reviewer, not both: ${CAUSE_USAGE}`);
  const reviewSeq = args["review-seq"] === undefined ? undefined : whole("review-seq", "--review-seq needs the review's sequence, a positive integer");
  if (args.reviewer !== undefined && (typeof args.reviewer !== "string" || !args.reviewer.includes("/"))) die(`--reviewer needs the reviewer as harness/model: ${CAUSE_USAGE}`);
  const body = { index, cause: args.cause, ...(args.head !== undefined ? { head: args.head } : {}), ...(reviewSeq !== undefined ? { reviewSeq } : {}), ...(args.reviewer !== undefined ? { reviewer: args.reviewer } : {}) };
  const r = await call("POST", `${I(name, id)}/finding-cause`, body, OWNER, actingHeaders());
  const who = r.acting ? `, changed by ${r.acting}` : "";
  console.log(r.event === null ? `The cause of finding ${index} of ${id}'s review ${r.review} by ${r.by} is already ${r.cause}; nothing recorded.` : `Recorded cause ${r.cause} (was ${r.from}) on finding ${index} of ${id}'s review ${r.review} by ${r.by} as event ${r.event}${who}.`);
}

// The project owner records a verdict on one finding of a review, at the
// head the review was made at and the finding's position in its findings.
// --review-seq or --reviewer names the review where more than one at the head
// could be meant; the Ledger refuses an ambiguous one and lists the reviews.
export default async function findingCommand() {
  const name = project(), id = itemArg();
  if (args.cause !== undefined || args.failure !== undefined) return causeCommand(name, id);
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
  const r = await call("POST", `${I(name, id)}/finding`, body, OWNER, actingHeaders());
  // A server from before t486 answers without the review it chose.
  const which = Number.isInteger(r?.review) ? `review ${r.review} by ${r.by}` : "review";
  const event = typeof r.event === "number" ? ` as event ${r.event}${r.acting ? `, declared acting ${r.acting}` : ""}; a defect that shows it wrong names it with --contradicts ${r.event}#${index}` : "";
  console.log(`Recorded ${verdict} on finding ${index} of ${id}'s ${which} at ${args.head.slice(0, 8)}${event}. The Models page counts it under the reviewer.`);
}
