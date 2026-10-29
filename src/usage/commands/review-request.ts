import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "review-request",
  capabilities: ["reviews.post-merge.v1"],
  forms: [{ group: "Agents", line: 3, slot: 65, form: "review-request ID --reviewer H/M... [--hand]", about: "The developer queues a review for a runner. Given --reviewer more than once, every reviewer named is asked together at the task's head in one step, none replacing another's request, so their reviews run side by side; a refusal for any of them asks none. A merged task is reviewed at its recorded merge commit against the merge's original parent (or fork point for a fast-forward), with the task's criteria. Verdicts and findings stay on the task and count on Models; blocking findings file a linked defect task. The merged task stays merged, including when it landed on an override." }],
  flags: { reviewer: false, hand: true },
  help: { flags: { "--reviewer H/M": "the reviewer to ask; once per reviewer to ask several together at one head", "--hand": "open the request although no live runner offers the review job, for a review the developer serves by hand with review-claim --runner home:hand" }, example: "atelier review-request t3 --reviewer codex/gpt-6-astra --project demo" },
};
export default spec;
