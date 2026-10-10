import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "approvals",
  forms: [
    {
      group: "Owner", line: 2, slot: 40,
      form: "approvals [--all]",
      about: "Lists the approvals that stand, each with its kind, revision and expiry. `--all` adds the used, withdrawn and expired ones.",
    },
    {
      group: "Owner", line: 2, slot: 50,
      form: "approvals withdraw ID [--note T]",
      about: "The project owner withdraws an approval no ship has used, so none can use it.",
    },
  ],
  flags: { all: true, note: false },
  help: {
    flags: {
      "--all": "adds the used, withdrawn and expired approvals",
      "--note TEXT": "with withdraw, why; kept with the event",
    },
    example: "atelier approvals --all --project demo",
  },
};

export default spec;
