import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "defect",
  forms: [
    {
      group: "Developer", line: 1, slot: 60,
      form: "defect ID --note TEXT [--found-in ID] [--contradicts SEQ#N]",
      about: "The developer traces a defect to the revision the task was accepted at. Nothing about the task changes; the reliability record counts the defect against the model that built that revision and against each model that approved it. `--found-in` names the task the defect was found or fixed in. `--contradicts` names a refuted or fixed verdict on one of this task's findings, by its event number and the finding's position, that the defect shows was wrong; it is refused for another task's or project's verdict, a confirmed one, or a review at a revision this task was not submitted at before its acceptance. The Models page counts it against the model that recorded the verdict, once however many defects name it; a defect that names no verdict counts against none.",
    },
  ],
  flags: {
    note: '--note needs text: atelier defect ID --note "what is wrong"',
    "found-in": false,
    contradicts: "--contradicts needs the verdict: atelier defect ID --note TEXT --contradicts SEQ#N",
  },
  help: {
    flags: {
      "--note TEXT": "what is wrong; required",
      "--found-in ID": "the task the defect was found or fixed in",
      "--contradicts SEQ#N": "the verdict event (its number, as atelier finding and atelier receipt print it) and the finding it judged, which the defect shows was wrong; also tN@SEQ#N or PROJECT/tN@SEQ#N, naming this task and project",
    },
    example: 'atelier defect t3 --note "It drops the last row" --found-in t9 --contradicts 42#1 --project demo',
  },
};

export default spec;
