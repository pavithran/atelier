import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "refresh-lease",
  capabilities: ["refresh.tasks.v1"],
  forms: [
    {
      group: "Agents", line: 4, slot: 62,
      form: "refresh-lease ID [--job refresh|resolve] [--runner NAME]",
      about: "Takes the lease a task's refresh runs under (t462): the integrator's for merging main into the task's head, a resolver's for resolving the mechanical conflicts that merge left. Refused while the task is busy or blocked, with why. Prints the lease, the task's head it found, the main head to merge, and tokens to fetch main and push to the task's fork; the write token is revoked when the lease settles.",
    },
  ],
  flags: { job: false, runner: false },
  help: {
    flags: {
      "--job refresh|resolve": "refresh (the integrator's, the default) or resolve (the resolver's)",
      "--runner NAME": "the runner that runs the job, recorded with the lease",
    },
    example: "atelier refresh-lease t3 --project demo --as atelier/integrator",
  },
};

export default spec;
