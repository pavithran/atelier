import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "inbox",
  forms: [
    {
      group: "Items", line: 2, slot: 50,
      form: "inbox [--json]",
      about: "Prints each task that waits on the project owner, one per task with what to do and the link to do it, by project; the pipeline and overlapping scopes are counted, not listed. `--json` prints each project's placement for scripts.",
    },
  ],
  flags: { json: true },
  help: {
    flags: {
      "--json": "prints each project's placement as JSON",
    },
    example: "atelier inbox",
  },
};

export default spec;
