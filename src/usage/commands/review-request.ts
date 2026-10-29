import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "review-request",
  capabilities: ["reviews.post-merge.v1"],
  forms: [{ group: "Agents", line: 3, slot: 65, form: "review-request ID [--reviewer H/M] [--tier-review] [--hand]", about: "The developer queues a review for a runner. Without `--reviewer` nothing is asked: the server says why no review is needed, or refuses listing every candidate with its reliability and precision figures and why each refused one is refused (a contributor, a family match, no live runner offer); Atelier picks no reviewer. `--tier-review` asks the separate review of the project's review tier for a protected change whose gate reviewer is outside the tier, of the tier model named; `atelier show` says when one is needed and lists its candidates. A merged task is reviewed at its recorded merge commit against the merge's original parent (or fork point for a fast-forward), with the task's criteria. Verdicts and findings stay on the task and count on Models; a post-merge review's blocking findings are notes on the task, which `atelier file-fix ID --from-note N` files as a task. The merged task stays merged, including when it landed on an override." }],
  flags: { reviewer: false, "tier-review": true, hand: true },
  help: { flags: { "--reviewer H/M": "the independent reviewer whose runner audits the recorded merge", "--tier-review": "the separate review of the project's review tier, beside the gate's, of the tier model --reviewer names", "--hand": "open the request although no live runner offers the review job, for a review the developer serves by hand with review-claim --runner home:hand" }, example: "atelier review-request t3 --reviewer codex/gpt-6-astra --project demo" },
};
export default spec;
