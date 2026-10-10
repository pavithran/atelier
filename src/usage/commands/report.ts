import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "report",
  forms: [
    {
      group: "Agents", line: 2, slot: 60,
      form: 'report [ID] "what you verified and how" [--item ID] [--project P]',
      about: "Records a Reported claim at the current head: what the agent verified and how. It goes on the task named, else on the workspace's task; in a workspace, another task's id needs `--item ID`. It is shown and never counted as a check.",
    },
  ],
  flags: { item: false },
  help: {
    flags: {
      "--item ID": "the task the claim goes on, when it is not the workspace's",
      "--project P": "with an ID, records the claim there even from another task's workspace",
    },
    example: 'atelier report "Ran the app by hand; the parser takes the new form"',
  },
};

export default spec;
