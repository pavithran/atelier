import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "review-release",
  forms: [
    {
      group: "Agents", line: 3, slot: 80,
      form: "review-release ID [--note T]",
      about: "A reviewer whose harness wrote no valid verdict lets the review request go, so another reviewer may take it.",
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
