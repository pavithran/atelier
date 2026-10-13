import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "review-claim",
  // The claim answers the criteria binding and the request number.
  capabilities: ["reviews.criteria-binding.v1"],
  forms: [
    {
      group: "Agents", line: 3, slot: 70,
      form: "review-claim ID [--runner home:NAME]",
      about: "A reviewer's runner claims the task's open review request and gets the part, its brief's inputs, the binding of the acceptance criteria the brief carries and the request's number, which the verdict names, and a read token for its fork. The claim prints as one JSON line, then, for a reviewer serving it by hand, the request, head and criteria binding, the exact `atelier review` command that records the verdict, and that the lease lasts 5 minutes; this machine remembers the request for `atelier review` and `--renew`.",
    },
    {
      group: "Agents", line: 3, slot: 71,
      form: "review-claim ID --renew [--request N]",
      about: "Renews the 5-minute lease on a review request claimed by hand, as a runner renews its own; without `--request`, the request this machine last claimed for the task.",
    },
  ],
  flags: { runner: false, renew: true, request: false },
  help: {
    flags: {
      "--runner home:NAME": "names the runner that claims the review request",
      "--renew": "renews the lease on the claimed request rather than claiming one",
      "--request N": "with --renew, the request to renew, as the claim gave it; defaults to the one this machine last claimed for the task",
    },
    example: "atelier review-claim t3 --runner home:studio --project demo",
  },
};

export default spec;
