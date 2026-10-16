import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "show",
  forms: [
    {
      group: "Items", line: 2, slot: 20,
      form: "show ID [--reviews] [--json]",
      about: "Prints a task's decision brief: what is decided, the brief the developer filed it with (without claiming the task, as `start` does), the recorded evidence, a recommendation and the task's address. When a required check fails at the current head as the gate reads it (the latest counting run of each check at that head, and a failing run on the merge with main that blocks), it also prints each failed check by command, head and evidence id (and container run id), the failing tests its reporter named (node:test, TAP, vitest, jest, pytest, go test, cargo test, XCTest and swift-testing are read; any other output, or a typecheck, says the names are unavailable, and a log kept as a tail may have lost the lines naming them, which is said, unless the run kept the lines naming its failure from the whole output, which are then read and printed first), and the last 20 lines, at most 2,000 characters, of its log, the whole log read from where it is stored or the inline tail labelled as such. `--reviews` also prints each review at each head with its whole note and findings, then the reviews of the acceptance criteria themselves with the developer's resolutions; `--json` prints the brief, carrying the filed brief as `brief`, the reviews, the criteria reviews and the failed checks, for scripts.",
    },
  ],
  flags: { reviews: true, json: true },
  help: {
    flags: {
      "--reviews": "prints each review at each head, with its whole note and every finding; a tier review is labelled as one, and a gate review by a tier model as the gate review, top tier; then the reviews of the acceptance criteria themselves, with each revision's author, their findings and the developer's resolutions",
      "--json": "prints the brief as JSON, with every review and its findings, and the record of the criteria reviews",
    },
    example: "atelier show t3 --project demo",
  },
};

export default spec;
