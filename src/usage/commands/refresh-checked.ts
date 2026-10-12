import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "refresh-checked",
  capabilities: ["refresh.tasks.v1"],
  forms: [
    {
      group: "Agents", line: 4, slot: 64,
      form: "refresh-checked ID --lease ID --main-head SHA --expected-head SHA (--passed | --failed --reason TEXT)",
      about: "A task refresh's leaseholder reports the required checks it ran at the refreshed head with atelier check (t462). Passed, the refresh is done; failed, it goes back to the task's builder with the reason, and the failing checks stand in the gate. Either way the lease settles and its write token is revoked.",
    },
  ],
  flags: { lease: false, "main-head": false, "expected-head": false, passed: true, failed: true, reason: false },
  help: {
    flags: {
      "--lease ID": "the lease refresh-lease gave",
      "--main-head SHA": "the main head the refresh merged",
      "--expected-head SHA": "the task's head the lease found",
      "--passed": "every required check passed at the refreshed head",
      "--failed": "a required check failed there",
      "--reason TEXT": "what failed",
    },
    example: "atelier refresh-checked t3 --lease 0f3c... --main-head 0123... --expected-head 4567... --passed --project demo",
  },
};

export default spec;
