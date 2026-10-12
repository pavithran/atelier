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
    {
      group: "Agents", line: 4, slot: 62,
      form: "refresh-lease ID (--renew LEASE | --release LEASE [--reason TEXT] [--provider-limit] | --status LEASE)",
      about: "The leaseholder renews its lease through a long run (a resolver's harness, the required checks), or gives it back with no outcome: a provider's usage limit stopped its harness, or the job failed before it could report anything else. A released lease leaves the refresh as it was before it, queued, or waiting for the same resolver, and its write token is revoked. --status prints the task's head as recorded now and whether the lease is still live and running checks, which a leaseholder whose report went unanswered reads before it takes its push back.",
    },
  ],
  flags: { job: false, runner: false, renew: false, release: false, status: false, reason: false, "provider-limit": true },
  help: {
    flags: {
      "--job refresh|resolve": "refresh (the integrator's, the default) or resolve (the resolver's)",
      "--runner NAME": "the runner that runs the job, recorded with the lease",
      "--renew LEASE": "renew the lease its holder runs under",
      "--release LEASE": "give the lease back with no outcome",
      "--status LEASE": "read the task's recorded head and whether the lease is live",
      "--reason TEXT": "why the lease is given back, kept in the task's log",
      "--provider-limit": "the lease is given back because a provider's usage limit stopped the harness",
    },
    example: "atelier refresh-lease t3 --project demo --as atelier/integrator",
  },
};

export default spec;
