import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "owners",
  forms: [
    {
      group: "Items", line: 2, slot: 40,
      form: "owners [--json]",
      about: "Prints one line per live task: its state, its owner and since when.",
    },
  ],
  flags: { json: true },
  help: {
    flags: {
      "--json": "prints the list as JSON",
    },
    example: "atelier owners --project demo",
  },
};

export default spec;
