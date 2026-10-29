import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "push",
  forms: [
    {
      group: "Agents", line: 2, slot: 30,
      form: "push [--force | --rollback]",
      about: "Pushes the workspace to the task's branch on the server (t/N), then asks the server to read the head there. The ledger records the head Atelier saw, not the one the agent named. It refuses, pushing nothing, when the workspace does not push the task's branch. After `update`, `--force` pushes with a lease. `--rollback` returns the branch to an earlier commit of the recorded history, as the plan integrator does after a failed integration.",
    },
  ],
  flags: { force: true, rollback: true },
  help: {
    flags: {
      "--force": "after an atelier update that rebased: pushes the rebased head, with a lease on the head Atelier recorded",
      "--rollback": "returns the branch to the workspace's HEAD, an earlier commit of the recorded history, dropping what was recorded after it, with a lease on the recorded head; the plan integrator's rollback",
    },
    example: "atelier push",
  },
};

export default spec;
