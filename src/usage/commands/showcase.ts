import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "showcase",
  forms: [
    {
      group: "Projects", line: 1, slot: 30,
      form: "showcase set NAME [--named|--anonymous]",
      about: "The project owner adds a project to the public showcase. Anonymous is the default: the project's card and its task stories carry a neutral label from the project's kind, never its name, a task title, a path, a commit message or an address. `--named` shows the project by name. Nothing is public until this is run.",
    },
    {
      group: "Projects", line: 1, slot: 40,
      form: "showcase remove NAME",
      about: "Takes the project off the public showcase. With no subcommand, `showcase` lists what is shown and how.",
    },
  ],
  flags: { named: true, anonymous: true },
  help: {
    flags: {
      "--named": "with set, shows the project by name",
      "--anonymous": "with set, shows the project under a neutral label; the default",
    },
    example: "atelier showcase set demo --named",
  },
};

export default spec;
