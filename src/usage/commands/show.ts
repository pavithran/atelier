import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "show",
  forms: [
    {
      group: "Items", line: 2, slot: 20,
      form: "show ID [--reviews] [--json]",
      about: "Prints a task's decision brief: what is decided, the recorded evidence, a recommendation and the task's address. `--reviews` also prints each review at each head with its whole note and findings; `--json` prints the brief, carrying the reviews, for scripts.",
    },
  ],
  flags: { reviews: true, json: true },
  help: {
    flags: {
      "--reviews": "prints each review at each head, with its whole note and every finding; a tier review is labelled as one, and a gate review by a tier model as the gate review, top tier",
      "--json": "prints the brief as JSON, with every review and its findings",
    },
    example: "atelier show t3 --project demo",
  },
};

export default spec;
