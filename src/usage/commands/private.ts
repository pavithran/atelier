import type { CommandSpec } from "../command.ts";

// Private files (t645): kept in the project's iCloud folder, linked into the
// checkout, ignored by Git and never pushed. Local to this Mac: no server
// route is read or written.
const spec: CommandSpec = {
  name: "private",
  forms: [
    {
      group: "Setup", line: 3, slot: 10,
      form: "private add PATH… [--home DIR]",
      about: "Names files of the project that stay private to the developer, such as PROJECT.md: kept in the project's iCloud folder (`~/Library/Mobile Documents/com~apple~CloudDocs/ai-projects/` and the folder named for the project, or DIR), linked into this Mac's checkout, ignored by Git through `.git/info/exclude`, and never committed or pushed by Atelier. A file already in the checkout is never overwritten, and a file Git tracks is refused. `clone` links them on every Mac that names them.",
    },
    {
      group: "Setup", line: 3, slot: 20,
      form: "private ls",
      about: "Lists the project's private files, the folder that keeps them and whether each is linked into this Mac's checkout and ignored by Git. It changes nothing.",
    },
  ],
  flags: { home: false },
  subcommands: { add: { takes: ["home"] }, ls: { takes: [] } },
  help: {
    flags: {
      "--home DIR": "the folder that keeps the private files, in place of the iCloud ai-projects folder named for the project",
    },
    example: "atelier private add PROJECT.md --project demo",
  },
};

export default spec;
