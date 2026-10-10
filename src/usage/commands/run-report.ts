import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "run-report",
  forms: [
    {
      group: "Owner", line: 2, slot: 10,
      form: "run-report --actor H/M --role build|review --outcome KIND [--project P] [--item ID] [--detail TEXT]",
      about: "The project owner records a run that ended without a result the ledger saw, for a run outside the runner: an early stop, a permission stop, a duplicate design or an incomplete merge, beside stalled, timed-out and refused, which the runner reports itself. The reliability record counts it against the actor, and a review run counts as a review that never reached a verdict.",
    },
  ],
  flags: { actor: false, role: false, outcome: false, project: false, item: false, detail: false },
  help: {
    flags: {
      "--actor H/M": "the harness/model the run ran; required",
      "--role build|review": "build or review; build unless given",
      "--outcome KIND": "stalled, timed-out, refused, early_stop, permission_stop, duplicate_design or incomplete_merge; required",
      "--project P": "the project the run was in",
      "--item ID": "the task the run was on",
      "--detail TEXT": "what happened",
    },
    example: 'atelier run-report --actor opencode/glm-5.3 --role build --outcome early_stop --project atelier --item t114 --detail "stopped after a refused read"',
  },
};

export default spec;
