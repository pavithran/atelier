import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "abandon",
  // --quote sends the developer's direction (t178), which a server needs
  // items.developer-direction.v1 for (requiredForCommand).
  capabilities: ["items.developer-direction.v1"],
  forms: [
    {
      group: "Developer", line: 1, slot: 50,
      form: "abandon ID [--note TEXT] [--delivered-by tN] [--quote WORDS]",
      about: "Closes the task without merging it. The holder's write token is revoked; the history and evidence stay. `--note` says why. `--delivered-by` records that the merged task tN delivered it, for work another task already brought in. A model acting with the developer token needs the developer's words: `--quote WORDS` with `--as H/M` (or ATELIER_ACTOR) naming the model, both recorded on the event and shown where the action shows; without them the call stops and names the command to run once the developer has said yes. The task page's forms stay as an alternative.",
    },
  ],
  flags: { note: false, "delivered-by": false, quote: '--quote needs the developer\'s words: atelier abandon ID --quote "what the developer said" --as H/M' },
  help: {
    flags: {
      "--quote WORDS": "the developer's own words directing this; with --as H/M, the model acting on them, they let the developer token alone do it, and both are recorded on the event",
      "--as H/M": "with --quote, the harness/model acting on the developer's words; required with --quote",
      "--note TEXT": "why; kept with the event",
      "--delivered-by tN": "a merged task that delivered this one's work; kept with the event",
    },
    example: 'atelier abandon t3 --note "Superseded by t5" --project demo',
  },
};

export default spec;
