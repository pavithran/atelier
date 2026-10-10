import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "undispatch",
  forms: [
    {
      group: "Models", line: 2, slot: 20,
      form: "undispatch ID",
      about: "Takes the task out of the queue.",
    },
  ],
  flags: {},
  help: {
    example: "atelier undispatch t3 --project demo",
  },
};

export default spec;
