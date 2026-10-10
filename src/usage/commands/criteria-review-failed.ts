import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "criteria-review-failed",
  forms: [
    {
      group: "Agents", line: 4, slot: 30,
      form: "criteria-review-failed ID --request N [--note TEXT]",
      about: "A reviewer whose harness stopped, timed out or wrote no valid verdict records the failure on the criteria review it claimed. The review approves nothing, and the criteria may be asked about again.",
    },
  ],
  flags: { request: false, note: false },
  help: {
    flags: {
      "--request N": "the criteria review's number, as the claim gave it; required",
      "--note TEXT": "why no verdict was reached; kept with the review",
    },
    example: 'atelier criteria-review-failed t3 --request 4 --note "The harness timed out" --project demo',
  },
};

export default spec;
