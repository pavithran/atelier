import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "unblock",
  forms: [
    {
      group: "Agents", line: 3, slot: 40,
      form: "unblock [ID]",
      about: "The holder or the developer lifts the block, and the task returns to the state it was in; it also lifts the fence a blocking pre-review left on the task's landing, so atelier land can queue it again.",
    },
  ],
  flags: {},
  help: {
    example: "atelier unblock t3 --project demo",
  },
};

export default spec;
