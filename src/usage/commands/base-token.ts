import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "base-token",
  forms: [
    {
      group: "Agents", line: 5, slot: 20,
      form: "base-token ID",
      about: "Uses the 2.0 `git-token` route with kind read. Outside a claimed workspace, supply `--as H/M` on the developer token or an agent's own `ATELIER_TOKEN`. Reads a read grant naming the branch the task merges into: the plan's branch for a part, the project's otherwise.",
    },
  ],
  flags: {},
  help: {
    example: "atelier base-token t3 --project demo --as claude-code/opus-5.5",
  },
};

export default spec;
