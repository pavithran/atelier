import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "read-token",
  forms: [
    {
      group: "Agents", line: 4, slot: 10,
      form: "read-token ID",
      about: "Reads a token for the task's own fork, with its head and base, for a job that clones it outside a task or a review.",
    },
  ],
  flags: {},
  help: {
    example: "atelier read-token t3 --project demo",
  },
};

export default spec;
