import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "review-claim",
  forms: [
    {
      group: "Agents", line: 3, slot: 70,
      form: "review-claim ID [--runner home:NAME]",
      about: "A reviewer's runner claims the task's open review request and gets the part, its brief's inputs, the binding of the acceptance criteria the brief carries and the request's number, which the verdict names, and a read token for its fork.",
    },
  ],
  flags: { runner: false },
  help: {
    flags: {
      "--runner home:NAME": "names the runner that claims the review request",
    },
    example: "atelier review-claim t3 --runner home:studio --project demo",
  },
};

export default spec;
