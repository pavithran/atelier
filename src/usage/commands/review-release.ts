import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "review-release",
  forms: [
    {
      group: "Agents", line: 3, slot: 80,
      form: "review-release ID [--request N] [--note T]",
      about: "Release the review claim for the actor named by --as, so another reviewer may take it. Agents and runners must send --request with the number returned by review-claim; stale numbers cannot release a successor's claim. Only the developer's credentials may omit --request to recover the actor's current claim.",
    },
  ],
  flags: { request: false, note: false },
  help: {
    flags: {
      "--request N": "the current claim's request number; required for agents and runners",
      "--note TEXT": "why the review request is let go; kept with the event",
    },
    example: 'atelier review-release t3 --request 7 --note "The harness wrote no verdict" --project demo',
  },
};

export default spec;
