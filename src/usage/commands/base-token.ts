import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "base-token",
  forms: [
    {
      group: "Agents", line: 5, slot: 20,
      form: "base-token ID",
      about: "Reads a read grant naming the branch the task merges into: the plan's branch for a part, the project's otherwise.",
    },
  ],
  flags: {},
  help: {
    example: "atelier base-token t3 --project demo",
  },
};

export default spec;
