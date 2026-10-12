import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "criteria-review-claim",
  capabilities: ["reviews.criteria-review.v1"],
  forms: [
    {
      group: "Agents", line: 4, slot: 10,
      form: "criteria-review-claim ID [--runner home:NAME]",
      about: "A reviewer's runner claims the open review of the task's acceptance criteria and gets the brief the server built, the revision and binding of the criteria the verdict must name, and the review's number. The reviewer reads no code: the criteria are judged before the build. `--runner` names the runner.",
    },
  ],
  flags: { runner: false },
  help: {
    flags: { "--runner home:NAME": "names the runner that claims the criteria review" },
    example: "atelier criteria-review-claim t3 --runner home:studio --project demo",
  },
};

export default spec;
