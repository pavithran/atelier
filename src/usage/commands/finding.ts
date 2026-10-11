import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "finding",
  forms: [
    {
      group: "Owner", line: 1, slot: 70,
      form: "finding ID --head SHA --index N --verdict confirmed|refuted|fixed [--note TEXT] [--as H/M]",
      about: "The project owner records a verdict on one finding of a review: confirmed, that the finding was right and a fix followed; fixed, that it was right and is fixed; refuted, that it was wrong. `--head` names the review's revision and `--index` the finding's position in that review's findings, one based. The event is the record, and the reliability record counts the reviewer's findings confirmed and refuted, which measures its precision. `--as` names the harness/model recording the verdict for the owner: the Models page counts its verdicts upheld, contradicted and unresolved. A later verdict that reverses it on the same finding of the same review (refuted against confirmed or fixed) corrects it, and both stay in the record; confirmed then fixed agree. It prints the verdict's event number, which `defect --contradicts` names.",
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
      "--as H/M": "the harness/model recording the verdict for the owner, kept beside the owner as its acting model",
    },
    example: 'atelier finding t3 --head 0123456789abcdef0123456789abcdef01234567 --index 2 --verdict confirmed --note "fixed in t9"',
  },
};

export default spec;
