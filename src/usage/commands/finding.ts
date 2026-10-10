import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "finding",
  forms: [
    {
      group: "Owner", line: 1, slot: 70,
      form: "finding ID --head SHA --index N --verdict confirmed|refuted|fixed [--note TEXT]",
      about: "The project owner records a verdict on one finding of a review: confirmed, that the finding was right and a fix followed; fixed, that it was right and is fixed; refuted, that it was wrong. `--head` names the review's revision and `--index` the finding's position in that review's findings, one based. The event is the record, and the reliability record counts the reviewer's findings confirmed and refuted, which measures its precision.",
    },
  ],
  flags: {
    head: false,
    index: false,
    verdict: "--verdict needs a value: atelier finding ID --head SHA --index N --verdict confirmed|refuted|fixed",
    note: false,
  },
  help: {
    flags: {
      "--head SHA": "the full revision the review was made at; required",
      "--index N": "the finding's position in that review's findings, one based; required",
      "--verdict V": "confirmed, refuted or fixed; required",
      "--note TEXT": "why; kept with the verdict",
    },
    example: 'atelier finding t3 --head 0123456789abcdef0123456789abcdef01234567 --index 2 --verdict confirmed --note "fixed in t9"',
  },
};

export default spec;
