import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "inbox",
  forms: [
    {
      group: "Items", line: 2, slot: 50,
      form: "inbox [--json]",
      about: "Prints the decision brief of each task that needs the project owner, most urgent first. `--json` prints the entries for scripts.",
    },
  ],
  flags: { json: true },
  help: {
    flags: {
      "--json": "prints the entries as JSON",
    },
    example: "atelier inbox",
  },
};

export default spec;
