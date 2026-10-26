import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "unblock",
  // --quote sends the developer's direction (t178), which a server needs
  // items.developer-direction.v1 for (requiredForCommand).
  capabilities: ["items.developer-direction.v1"],
  forms: [
    {
      group: "Agents", line: 3, slot: 40,
      form: "unblock [ID] [--quote WORDS]",
      about: "The holder or the developer lifts the block, and the task returns to the state it was in; it also lifts the fence a blocking pre-review left on the task's landing, so atelier land can queue it again. A model acting with the developer token needs the developer's words: `--quote WORDS` with `--as H/M` (or ATELIER_ACTOR) naming the model, both recorded on the event and shown where the action shows; without them the call stops and names the command to run once the developer has said yes. The task page's forms stay as an alternative.",
    },
  ],
  flags: { quote: '--quote needs the developer\'s words: atelier unblock ID --quote "what the developer said" --as H/M' },
  help: {
    flags: {
      "--quote WORDS": "the developer's own words directing this; with --as H/M, the model acting on them, they let the developer token alone do it, and both are recorded on the event",
      "--as H/M": "with --quote, the harness/model acting on the developer's words; required with --quote",
    },
    example: "atelier unblock t3 --project demo",
  },
};

export default spec;
