import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "update",
  forms: [
    {
      group: "Agents", line: 2, slot: 40,
      form: "update",
      about: "Rebases the workspace onto whatever has merged to the baseline since the fork, then names the next step, `atelier push --force`, whose lease refuses to overwrite anything pushed since the workspace last fetched.",
    },
  ],
  flags: {},
  help: {
    example: "atelier update",
  },
};

export default spec;
