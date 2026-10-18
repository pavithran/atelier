import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "board",
  // The board snapshot (t456). Declared as areas.board.v1 since function areas;
  // the name stays because an older CLI's board command requires it.
  capabilities: ["areas.board.v1"],
  forms: [{
    group: "Items", line: 3, slot: 10,
    form: "board [--json]",
    about: "Lists every task with its kind, title, ledger-derived stage and holder, and how many are merged.",
  }],
  flags: { json: true },
  help: {
    flags: { "--json": "prints the ledger snapshot shared with the project page" },
    example: "atelier board --project demo",
  },
};

export default spec;
