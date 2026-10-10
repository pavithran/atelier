import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "open",
  forms: [
    {
      group: "Items", line: 2, slot: 70,
      form: "open",
      about: "Opens the server in a browser, using the macOS `open` command.",
    },
  ],
  flags: {},
  help: {
    example: "atelier open",
  },
};

export default spec;
