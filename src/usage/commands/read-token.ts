import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "read-token",
  forms: [
    {
      group: "Agents", line: 5, slot: 10,
      form: "read-token ID",
      about: "Uses the 2.0 `git-token` route with kind read. Outside a claimed workspace, supply `--as H/M` on the developer token or an agent's own `ATELIER_TOKEN`. Reads a read grant for the task's own branch, with its head and base, for a job that clones it outside a task or a review.",
    },
  ],
  flags: {},
  help: {
    example: "atelier read-token t3 --project demo --as claude-code/opus-5.5",
  },
};

export default spec;
