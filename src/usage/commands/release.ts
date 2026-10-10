import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "release",
  forms: [
    {
      group: "Agents", line: 3, slot: 20,
      form: "release ID [--note TEXT]",
      about: "Gives the task up: it returns to open and the write token is revoked.",
    },
  ],
  flags: { note: false },
  help: {
    flags: {
      "--note TEXT": "why; kept with the release",
    },
    example: 'atelier release t3 --note "Blocked on the schema"',
  },
};

export default spec;
