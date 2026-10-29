import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "sync",
  forms: [
    {
      group: "Setup", line: 1, slot: 40,
      form: "sync",
      about: "Refused: the server keeps the project's repository itself, which is the baseline, and only a landing moves its branch. It names `pull` to bring the checkout to the server's branch, and a landing for commits made in the checkout outside Atelier.",
    },
  ],
  flags: {},
  help: {
    example: "atelier sync --project demo",
  },
};

export default spec;
