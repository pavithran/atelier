import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "ship",
  forms: [
    {
      group: "Owner", line: 4, slot: 10,
      form: "ship [--dry-run] [--push]",
      about: "Run by the project owner in the registered checkout, clean and at the baseline's head: composes the ship order from the project's ControlPlane ship policy and adapter, or from `docs/atelier/ship.json`, and refuses before running anything when a protected step has no approval at that revision, naming the command that approves it. It then runs the steps in order and stops at the first that fails, recording each step's command, exit status, duration and redacted output tail on the ledger. It pushes only with `--push`, which needs no approval since ship is owner-only and runs at one exact revision, and never forces a push. `--dry-run` prints the steps and which approvals are present or missing, and runs nothing.",
    },
  ],
  flags: { "dry-run": true, push: true },
  help: {
    flags: {
      "--dry-run": "composes the ship order and checks its approvals, running nothing",
      "--push": "also pushes the registered branch to the project's own remotes; the owner's own act at this revision, needing no separate approval",
    },
    example: "atelier ship --dry-run --project demo",
  },
};

export default spec;
