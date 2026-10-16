import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "criteria-finding",
  capabilities: ["reviews.criteria-review.v1"],
  forms: [
    {
      group: "Developer", line: 2, slot: 20,
      form: "criteria-finding ID --review N --index N --verdict confirmed|refuted|fixed [--note TEXT]",
      about: "The developer answers one finding of a criteria review: refuted, that it was wrong; fixed, that it is answered; confirmed, that it stands and the criteria still need the change. Refuted and fixed settle a finding. An approval of the revision counts only once every blocking finding on it is settled, and a rejection whose blocking findings are all settled is reviewed again rather than changed. `--review` names the criteria review and `--index` the finding's position in it, one based. Build and code-review briefs carry the findings with these answers.",
    },
  ],
  flags: {
    review: false,
    index: false,
    verdict: "--verdict needs a value: atelier criteria-finding ID --review N --index N --verdict confirmed|refuted|fixed",
    note: false,
  },
  help: {
    flags: {
      "--review N": "the criteria review's number, as atelier show prints it; required",
      "--index N": "the finding's position in that review's findings, one based; required",
      "--verdict V": "confirmed, refuted or fixed; refuted and fixed settle the finding; required",
      "--note TEXT": "why; kept with the verdict and shown in later briefs",
    },
    example: 'atelier criteria-finding t3 --review 4 --index 1 --verdict refuted --note "The test named in the brief observes it" --project demo',
  },
};

export default spec;
