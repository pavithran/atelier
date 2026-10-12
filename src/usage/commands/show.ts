import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "show",
  forms: [
    {
      group: "Items", line: 2, slot: 20,
      form: "show ID [--reviews] [--json]",
      about: "Prints a task's decision brief: what is decided, the recorded evidence, a recommendation and the task's address. When a required check fails at the current head as the gate reads it (the latest counting run of each check at that head, and a failing run on the merge with main that blocks), it also prints each failed check by command, head and evidence id (and container run id), the failing tests its reporter named (node:test, TAP, vitest, jest, pytest, go test, cargo test, XCTest and swift-testing are read; any other output, or a typecheck, says the names are unavailable, and a log kept as a tail may have lost the lines naming them, which is said), and the last 20 lines, at most 2,000 characters, of its log, the whole log read from where it is stored or the inline tail labelled as such. `--reviews` also prints each review at each head with its whole note and findings; `--json` prints the brief, carrying the reviews and the failed checks, for scripts.",
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
