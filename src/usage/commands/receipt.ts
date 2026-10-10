import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "receipt",
  forms: [
    {
      group: "Items", line: 2, slot: 30,
      form: "receipt ID [--json]",
      about: "Prints one task's whole story from the ledger, in the order it was recorded: created, claimed, each handoff and release, each pushed head as Artifacts answered it, each observed check at each head, each review with its verdict and every finding with the owner's verdict on it (confirmed, refuted or fixed), then the submission, acceptance and merge or abandonment that ended it. `--json` prints the task's events as the ledger holds them, in order.",
    },
  ],
  flags: { json: true },
  help: {
    flags: {
      "--json": "prints the receipt as JSON: the task's own fields and its whole event stream in the ledger's order",
    },
    example: "atelier receipt t3 --project demo",
  },
};

export default spec;
