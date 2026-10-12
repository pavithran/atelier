import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "review-request",
  capabilities: ["reviews.post-merge.v1"],
  forms: [{ group: "Agents", line: 3, slot: 65, form: "review-request ID --reviewer H/M", about: "The project owner queues a review for a runner. A merged task is reviewed at its recorded merge commit against the merge's original parent (or fork point for a fast-forward), with the task's criteria. Verdicts and findings stay on the task and count on Models; blocking findings file a linked defect task. The merged task stays merged, including when it landed on an override." }],
  flags: { reviewer: false },
  help: { flags: { "--reviewer H/M": "the independent reviewer whose runner audits the recorded merge" }, example: "atelier review-request t3 --reviewer codex/gpt-6-astra --project demo" },
};
export default spec;
