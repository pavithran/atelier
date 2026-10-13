import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "check-log",
  forms: [
    {
      group: "Items", line: 2, slot: 25,
      form: "check-log ID [--head SHA]",
      about: "Prints the retained logs of every check attempt at a head: the ledger head unless `--head` names one the task stood at earlier. Each attempt is labelled by check, its number among that check's runs at the head, its outcome (passed, failed, not applicable, or on the merge with main), where and when it ran and its evidence id, then its log: the whole log where the run stored one, else the inline tail (the last 3,500 characters of a check run on a machine, the last 4,000 of a container's), labelled as a tail; a stored log that can no longer be read is labelled unavailable and the tail stands in. A failed check run on a machine whose output outgrew its tail also kept the lines naming the failure, read from the whole output (at most 40 lines and 4,000 characters), and they are printed first. Atelier's tokens were redacted from a local check's output before it was recorded.",
    },
  ],
  flags: { head: false },
  help: {
    flags: {
      "--head SHA": "the revision whose attempts to print, 7 to 64 hex digits; the ledger head unless given, and a head the task stood at earlier may be named",
    },
    example: "atelier check-log t3 --project demo",
  },
};

export default spec;
