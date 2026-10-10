import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "base-token",
  forms: [
    {
      group: "Agents", line: 4, slot: 20,
      form: "base-token ID",
      about: "Reads a token for the repository the task is measured against: the plan's fork for a part, the baseline otherwise.",
    },
  ],
  flags: {},
  help: {
    example: "atelier base-token t3 --project demo",
  },
};

export default spec;
