import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "revert",
  forms: [
    {
      group: "Undo", line: 1, slot: 10, only: "cli",
      form: "revert ID",
      about: "Creates a new task that undoes a recorded merge with git revert -m1, under the normal checks and independent review. Both tasks keep a link in the ledger. Conflicts remain in the new workspace for resolution.",
    },
  ],
  flags: {},
  help: {
    example: "atelier revert t7",
  },
  usage: `usage: atelier revert ID

Creates a new task that undoes a recorded merge with git revert -m1, under the normal checks and independent review. Both tasks keep a link in the ledger. Conflicts remain in the new workspace for resolution.

Every command also takes --project NAME and --as harness/model (or ATELIER_ACTOR); --help prints this.

Example: atelier revert t7`,
};

export default spec;
