import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "review",
  forms: [
    {
      group: "Agents", line: 3, slot: 60,
      form: "review ID --approve|--reject --criteria BINDING [--request N] [--note TEXT] [--head SHA] [--findings JSON]",
      about: "Records a verdict on the task's current head, with `--note` giving the reason. `--head` names the revision the verdict is for, and the server refuses one for any head but the current. `--criteria` names the binding of the acceptance criteria the verdict judged, as `atelier show` or the review claim gives it; the server refuses a verdict that names none, or criteria the task no longer has, and the reviewer must read them again. `--request` names the review request the reviewer claimed, which the verdict then answers alone. `--findings` attaches a reviewer's structured findings. The rules say whose approval counts.",
    },
  ],
  flags: { approve: true, reject: true, note: false, head: false, findings: false, criteria: false, request: false },
  help: {
    flags: {
      "--approve": "records an approval",
      "--reject": "records a rejection",
      "--note TEXT": "the reason, shown with the verdict",
      "--head SHA": "the revision the verdict is for; the task's current head unless given, and any other is refused",
      "--criteria BINDING": "the binding of the acceptance criteria the verdict judged, as atelier show or the review claim gives it; required, and refused once the criteria change",
      "--request N": "the review request the reviewer claimed, as the claim gives it; the verdict answers it alone, and is refused once it is withdrawn",
      "--findings JSON": "a JSON list of the reviewer's findings, kept with the verdict",
    },
    example: 'atelier review t3 --approve --criteria BINDING --note "The tests cover the new form" --as claude-code/opus-5.5',
  },
};

export default spec;
