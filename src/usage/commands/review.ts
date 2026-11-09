import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "review",
  // Posts the verdict with the criteria binding and the request it claimed.
  capabilities: ["reviews.criteria-binding.v1"],
  forms: [
    {
      group: "Agents", line: 3, slot: 60,
      form: "review ID --approve|--reject --criteria BINDING [--request N] [--note TEXT] [--head SHA] [--findings JSON] [--verification JSON] [--tests JSON]",
      about: "Records a verdict on the task's current head, or its recorded merge commit when the task is merged, with `--note` giving the reason. `--head` names the revision the verdict is for; on a merged task it must explicitly name the recorded merge SHA given by the review claim, rather than the submitted head, and `--request` must name the post-merge review request the reviewer claimed. The server refuses a verdict for any other revision. `--criteria` names the binding of the acceptance criteria the verdict judged, as `atelier show` or the review claim gives it; the server refuses a verdict that names none, or criteria the task no longer has, and the reviewer must read them again. `--request` names the review request the reviewer claimed, which the verdict then answers alone; without it, the verdict answers the request this machine last claimed for the task as this reviewer (`atelier review-claim`), and says which. `--findings` attaches a reviewer's structured findings. `--tests` is the proof an approval needs where the project declares its affected tests: each test the reviewer ran at the head, with its result; the server refuses an approval whose tests are missing, failed, for another head or do not cover the changed paths, and a result of could-not-run records that the tests could not run and leaves the task waiting. The rules say whose approval counts.",
    },
  ],
  flags: { approve: true, reject: true, note: false, head: false, findings: false, verification: false, tests: false, criteria: false, request: false },
  help: {
    flags: {
      "--approve": "records an approval",
      "--reject": "records a rejection",
      "--note TEXT": "the reason, shown with the verdict",
      "--head SHA": "the revision the verdict is for; defaults to the task's current head before merge; on a merged task, required and must name the recorded merge SHA from the review claim, with --request naming the claimed post-merge review request; any other revision is refused",
      "--criteria BINDING": "the binding of the acceptance criteria the verdict judged, as atelier show or the review claim gives it; required, and refused once the criteria change",
      "--request N": "the review request the reviewer claimed, as the claim gives it; defaults to the one this machine last claimed for the task as this reviewer; required after merge; the verdict answers it alone, and is refused once it is withdrawn",
      "--findings JSON": "a JSON list of the reviewer's findings, kept with the verdict",
      "--tests JSON": "with --approve, the tests run at the head and their results: [{test, head, result}], the result passed, failed or could-not-run; required where the project declares its affected tests, and the tests must be those covering the changed paths and passed",
      "--verification JSON": "the second model's check of the blocking findings, as a runner records it: {by, answer, demoted: [{index, label, text}]}",
    },
    example: 'atelier review t3 --approve --criteria BINDING --note "The tests cover the new form" --as claude-code/opus-5.5',
  },
};

export default spec;
