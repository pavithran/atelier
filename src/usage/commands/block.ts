import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "block",
  // --quote sends the developer's direction (t178), which a server needs
  // items.developer-direction.v1 for (requiredForCommand).
  capabilities: ["items.developer-direction.v1"],
  forms: [
    {
      group: "Agents", line: 3, slot: 30,
      form: 'block [ID] "what it is waiting on" [--until YYYY-MM-DD] [--quote WORDS]',
      about: "The holder or the developer blocks the task with what it is waiting on. It keeps its holder and workspace, leaves the runner queue and stuck detection, cannot be pushed, submitted, reviewed, handed off or released, and sits in the developer's inbox with the reason until it is unblocked. With `--until` (a real UTC calendar date, today or later) the block records the last day the wait is expected to hold; from the day after, `atelier status` groups it on one line per project with its unblock and abandon commands instead of a row, and it stays blocked until it is unblocked or abandoned. A model acting with the developer token needs the developer's words: `--quote WORDS` with `--as H/M` (or ATELIER_ACTOR) naming the model, both recorded on the event and shown where the action shows; without them the call stops and names the command to run once the developer has said yes. The task page's forms stay as an alternative.",
    },
  ],
  flags: { until: "--until needs a date: atelier block ID \"what it is waiting on\" --until YYYY-MM-DD", quote: '--quote needs the developer\'s words: atelier block ID "what it is waiting on" --quote "what the developer said" --as H/M' },
  help: {
    flags: {
      "--quote WORDS": "the developer's own words directing this; with --as H/M, the model acting on them, they let the developer token alone do it, and both are recorded on the event",
      "--as H/M": "with --quote, the harness/model acting on the developer's words; required with --quote",
      "--until YYYY-MM-DD": "the last UTC day the wait is expected to hold, today or later; refused if it is missing, not a real calendar date or in the past, and nothing is recorded then. From the next day status shows the block as expired, still blocked",
    },
    example: 'atelier block t3 "Waiting on the schema decision" --project demo',
  },
};

export default spec;
