import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "queue",
  forms: [
    {
      group: "Models", line: 2, slot: 30,
      form: "queue",
      about: "Lists everything waiting for a runner, across projects, oldest first, and for each dispatch the project's core files hold, the live item it waits on.",
    },
  ],
  flags: {},
  help: {
    example: "atelier queue",
  },
};

export default spec;
