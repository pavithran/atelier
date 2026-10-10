import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "served",
  forms: [
    {
      group: "Owner", line: 2, slot: 20,
      form: "served MODEL --recorded H/M --from TIME --to TIME [--item ID]... [--note T] [--apply]",
      about: "The project owner records which model served events recorded under another, as when zcode served deepseek-flash while its events named glm-5.3. Each event recorded as `--recorded` from `--from` up to `--to`, on the tasks `--item` names or on every task, gets an annotation of its own, and the track record, the reliability record and the graph count it under the served model; the event itself never changes. Without `--apply` it lists the matches and records nothing. `--note` says how the owner knows.",
    },
  ],
  flags: { recorded: false, from: false, to: false, item: false, note: false, apply: true },
  help: {
    flags: {
      "--recorded H/M": "the actor the events were recorded under",
      "--from TIME": "the start of the span, as a date and time",
      "--to TIME": "the end of the span, up to which events are counted",
      "--item ID": "limits it to one task, once per task; every task unless given",
      "--note TEXT": "how the owner knows which model served them",
      "--apply": "records the annotations; without it, only lists the matches",
    },
    example: "atelier served deepseek-flash --recorded zcode/glm-5.3 --from 2026-10-01T00:00 --to 2026-10-03T00:00 --apply",
  },
};

export default spec;
