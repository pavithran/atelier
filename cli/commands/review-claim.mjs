// atelier review-claim. Its forms, flags and help are declared in src/usage/commands/review-claim.ts.
import { REVIEW_LEASE_MS } from "../../src/rules.ts";
import { I, actor, args, call, die, itemArg, project, rememberReviewClaim, rememberedReviewClaim } from "../atelier.mjs";

const MINUTES = REVIEW_LEASE_MS / 60_000;

// What a reviewer serving a claim by hand needs (t575): the request, head and
// criteria binding the verdict names, the exact command that records it, and
// how long the lease lasts and how to renew it. Pure, so it is tested alone.
export function handLines(id, claim, as) {
  const request = claim.request, head = claim.head;
  return [
    `Claimed ${id}'s review request ${request} at ${head} as ${as}.`,
    `Criteria binding: ${claim.criteria}`,
    `Record the verdict with: atelier review ${id} --head ${head} --request ${request} --criteria ${claim.criteria} --approve|--reject --note "…" --as ${as}`,
    `The claim's lease lasts ${MINUTES} minutes and lapses unless renewed: run atelier review-claim ${id} --renew --request ${request} --as ${as} within every ${MINUTES} minutes until the verdict is recorded.`,
  ];
}

export default async function reviewClaimCommand() {
  if (args.request !== undefined && (!/^[0-9]+$/.test(String(args.request)) || !Number.isSafeInteger(Number(args.request)) || Number(args.request) < 1)) {
    die("--request needs the request number the review claim gave");
  }
  if (args.request !== undefined && !args.renew) die("--request names the claim --renew renews; a new claim takes none");
  const name = project(), id = itemArg(), as = await actor();
  if (args.renew) {
    // The route a runner renews its lease with (review-renew, t351).
    const remembered = rememberedReviewClaim(name, id);
    const request = args.request !== undefined ? Number(args.request) : remembered?.request;
    if (request === undefined) die(`no review request of ${id} was claimed on this machine; name it with --request N, as the claim gave it`);
    await call("POST", `${I(name, id)}/review-renew`, { request }, as);
    const how = args.request !== undefined ? "" : ", the one this machine last claimed";
    console.log(`Renewed the lease on ${id}'s review request ${request}${how}, as ${as}: it lasts ${MINUTES} more minutes; renew again before then.`);
    return;
  }
  const r = await call("POST", `${I(name, id)}/review-claim`, {}, as, args.runner ? { "x-atelier-runner": args.runner } : {});
  // The JSON stays the one line on stdout, which a runner parses (runReview
  // in cli/runner.mjs); the plain lines for a reviewer by hand go to stderr.
  console.log(JSON.stringify(r));
  if (Number.isSafeInteger(r?.request) && r.request > 0) {
    rememberReviewClaim(name, id, { request: r.request, head: r.head, criteria: r.criteria, as });
    process.stderr.write(handLines(id, r, as).map((l) => `${l}\n`).join(""));
  }
}
