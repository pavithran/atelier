import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "inbox",
  forms: [
    {
      group: "Items", line: 2, slot: 50,
      form: "inbox [--json]",
      about: "Prints each task that waits on the project owner, one per task with what to do and the link to do it, by project; the pipeline and overlapping scopes are counted, not listed. `--json` prints, as before, a list of entries (project, itemId, title, kind, reason, weight), now one per task waiting on the owner, each adding its call, sentence, url and command; what could not be read goes to standard error. `atelier status --json` carries the pipeline and overlaps.",
    },
  ],
  flags: { json: true },
  help: {
    flags: {
      "--json": "prints one entry per task waiting on the owner as JSON",
    },
    example: "atelier inbox",
  },
};

export default spec;
