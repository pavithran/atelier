import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "criteria-verdict",
  forms: [
    {
      group: "Agents", line: 4, slot: 20,
      form: "criteria-verdict ID --approve|--reject --rev N --criteria BINDING --request N [--note TEXT] [--findings JSON]",
      about: "Records a verdict on the review of the task's acceptance criteria the reviewer claimed. `--rev`, `--criteria` and `--request` name the revision, the binding and the review the claim gave; a verdict for a revision the criteria have left is refused and records nothing. `--findings` attaches the findings, each naming the criterion it concerns; a rejection needs a blocking one and an approval allows none. An approval counts only once the project owner has settled every blocking finding any review raised on that revision.",
    },
  ],
  flags: { approve: true, reject: true, rev: false, criteria: false, request: false, note: false, findings: false },
  help: {
    flags: {
      "--approve": "the criteria can be observed and say what the brief requires; allows no blocking finding",
      "--reject": "at least one blocking finding names a criterion that cannot be judged, contradicts the brief, or leaves the task open",
      "--rev N": "the revision of the criteria the claim gave; a verdict for any other is refused; required",
      "--criteria BINDING": "the 64-digit binding of the criteria the claim gave; required",
      "--request N": "the criteria review's number, as the claim gave it; required",
      "--note TEXT": "the reviewer's summary; kept with the verdict",
      "--findings JSON": "a JSON list of findings, each {file, line, severity, text}, the file naming the criterion as criterion-N or criteria",
    },
    example: 'atelier criteria-verdict t3 --approve --rev 1 --criteria 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef --request 4 --note "Each criterion names a test" --project demo',
  },
};

export default spec;
