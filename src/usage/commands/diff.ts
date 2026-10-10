import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "diff",
  forms: [
    {
      group: "Agents", line: 3, slot: 50,
      form: "diff ID",
      about: "For a reviewer: prints the task's commits and diff against the baseline, from a clean read-only clone.",
    },
  ],
  flags: {},
  help: {
    example: "atelier diff t3 --project demo",
  },
};

export default spec;
