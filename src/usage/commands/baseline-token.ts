import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "baseline-token",
  forms: [
    {
      group: "Agents", line: 4, slot: 25,
      form: "baseline-token",
      about: "Reads a token for the project's baseline, main as it is now, with the project's regenerate command: a build's runner merges that main into the workspace before it submits (t435). A runner token may read it for any project it serves, where base-token answers only for the job the runner holds.",
    },
  ],
  flags: {},
  help: {
    example: "atelier baseline-token --project demo --as claude-code/opus",
  },
};

export default spec;
