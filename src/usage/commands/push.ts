import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "push",
  capabilities: ["items.owner-port.v1"],
  capabilityCheck: "handler",
  forms: [
    {
      group: "Agents", line: 2, slot: 30,
      form: "push [--force | --rollback]",
      about: "Pushes the workspace to the task's fork, then asks the Worker to read the head from Artifacts. The ledger records the head Atelier saw, not the one the agent named. It refuses, pushing nothing, when the workspace's branch is not the one the fork's HEAD names, since Atelier reads only that one. After `update`, `--force` pushes with a lease. `--rollback` returns the fork to an earlier commit of the recorded history, as the plan integrator does after a failed integration. The project owner may push an open, unclaimed task's workspace with `--as owner`: the push asks for a short-lived write token for that fork alone, recorded as the owner's.",
    },
  ],
  flags: { force: true, rollback: true },
  help: {
    flags: {
      "--force": "after an atelier update that rebased: pushes the rebased head, with a lease on the head Atelier recorded",
      "--rollback": "returns the fork to the workspace's HEAD, an earlier commit of the recorded history, dropping what was recorded after it, with a lease on the recorded head; the plan integrator's rollback",
    },
    example: "atelier push",
  },
};

export default spec;
