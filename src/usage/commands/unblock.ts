import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "unblock",
  forms: [
    {
      group: "Agents", line: 3, slot: 40,
      form: "unblock [ID]",
      about: "The holder or the project owner lifts the block, and the task returns to the state it was in.",
    },
  ],
  flags: {},
  help: {
    example: "atelier unblock t3 --project demo",
  },
};

export default spec;
