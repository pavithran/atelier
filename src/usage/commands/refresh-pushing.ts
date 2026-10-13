import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "refresh-pushing",
  capabilities: ["refresh.tasks.v1"],
  forms: [
    {
      group: "Agents", line: 4, slot: 63,
      form: "refresh-pushing ID --lease ID --main-head SHA --expected-head SHA --head SHA",
      about: "A task refresh's leaseholder says it pushes the refreshed merge next (t462). Refused when the task moved from the head the lease found, or is busy or landing; taken, no landing of the task begins until the push is reconciled: recorded by the leaseholder, or, once its lease lapses, by the integrator's next refresh job, or released by the owner with `refresh-lease ID --release LEASE --reason TEXT`.",
    },
  ],
  flags: { lease: false, "main-head": false, "expected-head": false, head: false },
  help: {
    flags: {
      "--lease ID": "the lease refresh-lease gave",
      "--main-head SHA": "the main head the refresh merged",
      "--expected-head SHA": "the task's head the lease found",
      "--head SHA": "the refreshed merge about to be pushed",
    },
    example: "atelier refresh-pushing t3 --lease 0f3c... --main-head 0123... --expected-head 4567... --head 89ab... --project demo",
  },
};

export default spec;
