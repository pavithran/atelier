import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "publish",
  forms: [
    {
      group: "Setup", line: 1, slot: 50,
      form: "publish",
      about: "Pushes the registered branch to the baseline with a write token. It is refused for a baseline that holds only part of the history; `sync` does that job.",
    },
  ],
  flags: {},
  help: {
    example: "atelier publish --project demo",
  },
};

export default spec;
