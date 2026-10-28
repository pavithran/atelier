import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "record-merge",
  // The record-merge route (t653).
  capabilities: ["land.record-merge.v1"],
  forms: [
    {
      group: "Developer", line: 1, slot: 35,
      form: "record-merge ID --merge SHA [--head SHA] --review H/M=VERDICT@HEAD[@WHEN]... [--note TEXT] [--shipped TEXT]",
      about: "The developer records a task that was merged into main outside Atelier, after the fact: the merge commit on main, the commit it merged and the reviews that approved it, as given (reviewer, approve or reject, the head it read and, when known, the day). The task is marked merged with a record that says the merge was made outside Atelier and recorded afterwards; no checks or test receipt are recorded, since none ran through Atelier. Refused unless the baseline's main holds the merge commit (`sync` brings it in) and its second parent is the task's head (`--head`, or the head the task last pushed), and unless one review approves that head. Outside fast mode the approvals named must also be the independent review the gate would count for the change (a protected change, or one whose paths Atelier never observed, needs an approval from a model of another family than every contributor, or in single-family mode a different model of that company), as the gate's own message says, judged on each reviewer's standing verdict at that head (a later rejection withdraws an approval) and, for a protected change, counting only an approval the Ledger holds as proved: recorded by the reviewer itself, or by the developer answering a review request the reviewer claimed at that head. A protected change's approval named without one is the developer's word, which counts only as an override where the project allows overrides. An override of that review the developer recorded at that head stands in for it, except in a project set up with `--no-override`, which refuses the record. On a baseline begun with `--history-since`, which rebuilds merges with one parent, the second parent is checked in this checkout and the baseline need only hold the commit paired with the merge. With `--shipped`, the developer says the merge's declared protected actions (a deploy, for one) already ran outside `ship`, and the record counts as that run, so `status` no longer lists a ship for it.",
    },
  ],
  flags: {
    merge: "--merge needs the merge commit: atelier record-merge ID --merge FULL_SHA --review H/M=approve@HEAD",
    head: "--head needs the commit merged, a full SHA",
    review: "--review needs H/M=VERDICT@HEAD: atelier record-merge ID --merge FULL_SHA --review codex/gpt-6-astra=approve@HEAD, once per review",
    note: false,
    shipped: "--shipped needs a note of what ran: atelier record-merge ID ... --shipped \"deploy version ID\"",
  },
  help: {
    flags: {
      "--merge SHA": "the merge commit on main, a full SHA; main on the baseline must hold it",
      "--head SHA": "the commit merged, the merge commit's second parent; defaults to the head the task last pushed",
      "--review H/M=VERDICT@HEAD[@WHEN]": "a review of the change: the reviewer as harness/model, approve or reject, the full head it read and, optionally, the day (2026-10-13) or time; once per review, one approving the commit merged",
      "--note TEXT": "what the developer says of the merge, kept with the record",
      "--shipped TEXT": "the merge's declared protected actions already ran; TEXT says what ran, such as a deploy version id, and is kept with the run",
    },
    example: "atelier record-merge t627 --merge a81991fdcf2aef7d75fbf03af9e51c1bee73b703 --review codex/gpt-6-astra=approve@3f313d3b63a07524b807bb6dccce67b615f2b595@2026-10-13 --project atelier",
  },
};

export default spec;
