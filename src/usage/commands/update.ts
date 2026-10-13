import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "update",
  forms: [
    {
      group: "Agents", line: 2, slot: 40,
      form: "update",
      about: "Brings the workspace up to date: first with commits another holder pushed to the fork, then with whatever has merged to the baseline since the fork. Each step is previewed first, and a declaration problem the result would hold, such as a command name both sides declare, stops it with nothing moved. Where the step needs a generator declared in bin/merge-manifest.json, because both sides changed what it reads, it merges through the merge pipeline, which regenerates the outputs, and names `atelier push`; otherwise it rebases through the clone's merge drivers and names `atelier push --force`, whose lease refuses to overwrite anything pushed since the workspace last fetched.",
    },
  ],
  flags: {},
  help: {
    example: "atelier update",
  },
};

export default spec;
