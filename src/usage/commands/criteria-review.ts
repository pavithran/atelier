import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "criteria-review",
  capabilities: ["reviews.criteria-review.v1"],
  forms: [
    {
      group: "Developer", line: 2, slot: 10,
      form: "criteria-review ID [--reviewer H/M]",
      about: "The developer asks for a review of the task's acceptance criteria before it is built, apart from any review of the change: a model of another family than every model that wrote the criteria judges whether each can be observed and whether the set says what the brief requires. The criteria are kept by revision with their authors, and the review binds to the revision they are at now; any edit of the criteria takes the approval back for good, an identical edit changes nothing, and a verdict that arrives after an edit is refused. `--reviewer` names the reviewer; otherwise the pool picks one. It is refused when no author is recorded, when a model author's family is not recognised, when no reviewer qualifies, and while a rejection's blocking findings wait for the developer. Under `init --require-criteria-review` a build is dispatched and claimed only while the approval stands; a plan asks for the review itself before it dispatches each part.",
    },
  ],
  flags: { reviewer: false },
  help: {
    flags: { "--reviewer H/M": "names the reviewer, which must be of another family than every model that wrote the criteria; otherwise the pool picks one" },
    example: "atelier criteria-review t3 --project demo",
  },
};

export default spec;
