import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "show",
  forms: [
    {
      group: "Items", line: 2, slot: 20,
      form: "show ID [--reviews] [--json]",
      about: "Prints a task's decision brief: what is decided, the recorded evidence, a recommendation and the task's address. `--reviews` also prints each review at each head with its whole note and findings, then the reviews of the acceptance criteria themselves with the owner's resolutions; `--json` prints the brief, carrying the reviews and the criteria reviews, for scripts.",
    },
  ],
  flags: { reviews: true, json: true },
  help: {
    flags: {
      "--reviews": "prints each review at each head, with its whole note and every finding; a tier review is labelled as one, and a gate review by a tier model as the gate review, top tier; then the reviews of the acceptance criteria themselves, with each revision's author, their findings and the owner's resolutions",
      "--json": "prints the brief as JSON, with every review and its findings, and the record of the criteria reviews",
    },
    example: "atelier show t3 --project demo",
  },
};

export default spec;
