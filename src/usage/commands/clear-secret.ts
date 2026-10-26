import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "clear-secret",
  // --quote sends the developer's direction (t178), which a server needs
  // items.developer-direction.v1 for (requiredForCommand).
  capabilities: ["items.developer-direction.v1"],
  forms: [
    {
      group: "Developer", line: 1, slot: 55,
      form: 'clear-secret ID --note "why" [--quote WORDS]',
      about: "The developer clears the task's standing secret flags with the reason the flagged lines are safe, as the web page's Clear secret flag does. The reason is kept against each line's file and fingerprint, so a later push that keeps the identical line is not flagged again. A scan still pending has no flag to clear. A model acting with the developer token needs the developer's words: `--quote WORDS` with `--as H/M` (or ATELIER_ACTOR) naming the model, both recorded on the event and shown where the action shows; without them the call stops and names the command to run once the developer has said yes. The task page's forms stay as an alternative.",
    },
  ],
  flags: { note: false, quote: '--quote needs the developer\'s words: atelier clear-secret ID --note "why" --quote "what the developer said" --as H/M' },
  help: {
    flags: {
      "--quote WORDS": "the developer's own words directing this; with --as H/M, the model acting on them, they let the developer token alone do it, and both are recorded on the event",
      "--as H/M": "with --quote, the harness/model acting on the developer's words; required with --quote",
      "--note TEXT": "why the flagged lines are safe; required, at most 500 characters, kept with the clearance",
    },
    example: 'atelier clear-secret t3 --note "A fake key in a test fixture" --project demo',
  },
};

export default spec;
