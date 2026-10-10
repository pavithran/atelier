import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "decisions",
  forms: [
    {
      group: "Owner", line: 3, slot: 20,
      form: "decisions [--all] [--project P]",
      about: "Lists the project's standing decisions, oldest first, each with its id, date, text and the owner's words. `--all` adds the withdrawn ones with their notes.",
    },
    {
      group: "Owner", line: 3, slot: 30,
      form: 'decisions withdraw ID --note "why"',
      about: "The project owner withdraws a standing decision with a note saying why. It stops appearing in the briefs, the guide and the plain list; `--all` still shows it, withdrawn.",
    },
  ],
  flags: {
    all: true,
    note: '--note needs text: atelier decisions withdraw ID --note "why"',
  },
  help: {
    flags: {
      "--all": "adds the withdrawn decisions, each with its note",
      "--note TEXT": "with withdraw, why; required, kept with the decision",
      "--project NAME": "the project; this checkout's or workspace's project unless given",
    },
    example: "atelier decisions --project demo",
  },
};

export default spec;
