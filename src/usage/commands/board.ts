import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "board",
  // The board snapshot (t456).
  capabilities: ["areas.board.v1"],
  forms: [{
    group: "Items", line: 3, slot: 10,
    form: "board [--json]",
    about: "Groups every task by function area, including empty areas and Unsorted. Shows area purposes, task kinds, titles, ledger-derived stages and holders; merged counts use the displayed membership.",
  }],
  flags: { json: true },
  help: {
    flags: { "--json": "prints the ledger snapshot shared with the project page" },
    example: "atelier board --project demo",
  },
};

export default spec;
