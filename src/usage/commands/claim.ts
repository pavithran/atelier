import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "claim",
  forms: [
    {
      group: "Agents", line: 2, slot: 10,
      form: "claim ID --as H/M [--runner home:NAME]",
      about: "Takes ownership of a task, forks the baseline into the task's workspace, mints a write token for the claimant alone, clones the workspace and records the project's branch as the one it pushes to. Claiming again refreshes the token and that branch, saying when the branch changed. `--runner` names the runner when a runner claims a dispatched task.",
    },
  ],
  flags: { runner: false },
  help: {
    flags: {
      "--runner home:NAME": "names the runner, when a runner claims a dispatched task",
    },
    example: "atelier claim t3 --project demo --as claude-code/opus-5.5",
  },
};

export default spec;
