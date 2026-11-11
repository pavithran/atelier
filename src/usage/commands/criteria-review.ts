import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "criteria-review",
  capabilities: ["reviews.criteria-review.v1"],
  forms: [
    {
      group: "Developer", line: 2, slot: 10,
      form: "criteria-review ID --reviewer H/M",
      about: "The developer asks for a review of the task's acceptance criteria before it is built, apart from any review of the change: a model of another family than every model that wrote the criteria judges whether each can be observed and whether the set says what the brief requires. The criteria are kept by revision with their authors, and the review binds to the revision they are at now; any edit of the criteria takes the approval back for good, an identical edit changes nothing, and a verdict that arrives after an edit is refused. `--reviewer` names the reviewer; without it the review is requested of the first available model of the criteria-review assignment, else of the review assignment, and the request is refused, with the candidates listed and what refuses each, only when neither applies (Atelier picks no reviewer of its own). It is refused when no author is recorded, when a model author's family is not recognised, when no reviewer qualifies, and while a rejection's blocking findings wait for the developer. Under `init --require-criteria-review` a build is dispatched and claimed only while the approval stands; a plan holds each part until its criteria are approved and records when a part needs that review, with its candidates; the model asks it.",
    },
  ],
  flags: { reviewer: false },
  help: {
    flags: { "--reviewer H/M": "names the reviewer, which must be of another family than every model that wrote the criteria; without it the first available model of the criteria-review assignment (else the review assignment) is asked, and the server lists candidates and refuses only when neither applies" },
    example: "ATELIER_ACTING=claude-code/opus-5.5 atelier criteria-review t3 --reviewer codex/gpt-6-astra --project demo",
  },
};

export default spec;
