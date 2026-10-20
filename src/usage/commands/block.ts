import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "block",
  forms: [
    {
      group: "Agents", line: 3, slot: 30,
      form: 'block [ID] "what it is waiting on" [--until YYYY-MM-DD]',
      about: "The holder or the developer blocks the task with what it is waiting on. It keeps its holder and workspace, leaves the runner queue and stuck detection, cannot be pushed, submitted, reviewed, handed off or released, and sits in the developer's inbox with the reason until it is unblocked. With `--until` (a real UTC calendar date, today or later) the block records the last day the wait is expected to hold; from the day after, `atelier status` groups it on one line per project with its unblock and abandon commands instead of a row, and it stays blocked until it is unblocked or abandoned.",
    },
  ],
  flags: { until: "--until needs a date: atelier block ID \"what it is waiting on\" --until YYYY-MM-DD" },
  help: {
    flags: {
      "--until YYYY-MM-DD": "the last UTC day the wait is expected to hold, today or later; refused if it is missing, not a real calendar date or in the past, and nothing is recorded then. From the next day status shows the block as expired, still blocked",
    },
    example: 'atelier block t3 "Waiting on the schema decision" --project demo',
  },
};

export default spec;
