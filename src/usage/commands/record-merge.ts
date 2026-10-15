import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "record-merge",
  // The record-merge route (t653).
  capabilities: ["land.record-merge.v1"],
  forms: [
    {
      group: "Developer", line: 1, slot: 35,
      form: "record-merge ID --merge SHA [--head SHA] --review H/M=VERDICT@HEAD[@WHEN]... [--note TEXT]",
      about: "The developer records a task that was merged into main outside Atelier, after the fact: the merge commit on main, the commit it merged and the reviews that approved it, as given (reviewer, approve or reject, the head it read and, when known, the day). The task is marked merged with a record that says the merge was made outside Atelier and recorded afterwards; no checks or test receipt are recorded, since none ran through Atelier. Refused unless the baseline's main holds the merge commit (`sync` brings it in) and its second parent is the task's head (`--head`, or the head the task last pushed), and unless one review approves that head.",
    },
  ],
  flags: {
    merge: "--merge needs the merge commit: atelier record-merge ID --merge FULL_SHA --review H/M=approve@HEAD",
    head: "--head needs the commit merged, a full SHA",
    review: "--review needs H/M=VERDICT@HEAD: atelier record-merge ID --merge FULL_SHA --review codex/gpt-6-astra=approve@HEAD, once per review",
    note: false,
  },
  help: {
    flags: {
      "--merge SHA": "the merge commit on main, a full SHA; main on the baseline must hold it",
      "--head SHA": "the commit merged, the merge commit's second parent; defaults to the head the task last pushed",
      "--review H/M=VERDICT@HEAD[@WHEN]": "a review of the change: the reviewer as harness/model, approve or reject, the full head it read and, optionally, the day (2026-10-13) or time; once per review, one approving the commit merged",
      "--note TEXT": "what the developer says of the merge, kept with the record",
    },
    example: "atelier record-merge t627 --merge a81991fdcf2aef7d75fbf03af9e51c1bee73b703 --review codex/gpt-6-astra=approve@3f313d3b63a07524b807bb6dccce67b615f2b595@2026-10-13 --project atelier",
  },
};

export default spec;
