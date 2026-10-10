import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "start",
  forms: [
    {
      group: "Agents", line: 1, slot: 10,
      form: "start ID [--as H/M] [--runner home:NAME]",
      about: "Claims the task, prepares its workspace as `claim` does, and prints its title, brief, acceptance criteria, scope and any dispatch note. `--runner` names the runner when a runner claims a dispatched task.",
    },
  ],
  flags: { runner: false },
  help: {
    flags: {
      "--runner home:NAME": "names the runner, when a runner claims a dispatched task",
    },
    example: "atelier start t3 --project demo --as claude-code/opus-5.5",
  },
};

export default spec;
