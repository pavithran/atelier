import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "defect",
  forms: [
    {
      group: "Owner", line: 1, slot: 60,
      form: "defect ID --note TEXT [--found-in ID]",
      about: "The project owner traces a defect to the revision the task was accepted at. Nothing about the task changes; the reliability record counts the defect against the model that built that revision and against each model that approved it. `--found-in` names the task the defect was found or fixed in.",
    },
  ],
  flags: {
    note: '--note needs text: atelier defect ID --note "what is wrong"',
    "found-in": false,
  },
  help: {
    flags: {
      "--note TEXT": "what is wrong; required",
      "--found-in ID": "the task the defect was found or fixed in",
    },
    example: 'atelier defect t3 --note "It drops the last row" --found-in t9 --project demo',
  },
};

export default spec;
