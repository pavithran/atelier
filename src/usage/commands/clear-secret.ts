import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "clear-secret",
  forms: [
    {
      group: "Developer", line: 1, slot: 55,
      form: 'clear-secret ID --note "why"',
      about: "The developer clears the task's standing secret flags with the reason the flagged lines are safe, as the web page's Clear secret flag does. The reason is kept against each line's file and fingerprint, so a later push that keeps the identical line is not flagged again. A scan still pending has no flag to clear.",
    },
  ],
  flags: { note: false },
  help: {
    flags: {
      "--note TEXT": "why the flagged lines are safe; required, at most 500 characters, kept with the clearance",
    },
    example: 'atelier clear-secret t3 --note "A fake key in a test fixture" --project demo',
  },
};

export default spec;
