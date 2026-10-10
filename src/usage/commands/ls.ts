import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "ls",
  forms: [
    {
      group: "Items", line: 2, slot: 10,
      form: "ls [--all] [--json]",
      about: "Lists the project's tasks with state, owner and head. Merged and abandoned tasks need `--all`. `--json` prints them for scripts, each task with its created, updated and last-push times, as Observatory reads them.",
    },
  ],
  flags: { all: true, json: true },
  help: {
    flags: {
      "--all": "includes merged and abandoned tasks",
      "--json": "prints the tasks as JSON, each with its created, updated and last-push times",
    },
    example: "atelier ls --all --project demo",
  },
};

export default spec;
