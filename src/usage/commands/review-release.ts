import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "review-release",
  forms: [
    {
      group: "Agents", line: 3, slot: 80,
      form: "review-release ID [--note T]",
      about: "Using the owner's credentials, release the current review claim for the actor named by --as, so another reviewer may take it. This also recovers a claim left by a stopped runner. Agent and runner API clients must send the current request number when releasing a claim.",
    },
  ],
  flags: { note: false },
  help: {
    flags: {
      "--note TEXT": "why the review request is let go; kept with the event",
    },
    example: 'atelier review-release t3 --note "The harness wrote no verdict" --project demo',
  },
};

export default spec;
