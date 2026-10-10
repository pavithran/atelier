import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "wrap",
  forms: [
    {
      group: "Sessions", line: 1, slot: 20,
      form: 'wrap "summary" [--next TEXT] [--found TEXT]... [--push] [--no-check | --allow-failing] [--project P]',
      about: "Closes the owner's session in the registered checkout: runs the registered checks and, when every one passes, commits everything with the summary as its subject, updates the baseline and records a session note on the ledger. A failing check refuses the commit, naming each failed check with how it ended, and leaves the checkout, the ledger and every remote as they were; `--allow-failing` commits anyway, and the note records which checks it let through. Check results are Reported, because they ran on the owner's machine. `--push` also pushes the checkout's own remotes; `--found` files a task for each defect found; `--no-check` skips the checks.",
    },
  ],
  flags: { next: false, found: false, push: true, "no-check": true, "allow-failing": true },
  help: {
    flags: {
      "--next TEXT": "what the next session should do; recorded in the note and the commit message",
      "--found TEXT": "files a task with this title; once per defect found, at most 100",
      "--push": "also pushes the registered branch to each of the checkout's own remotes",
      "--no-check": "skips the registered checks; the note records that they were skipped",
      "--allow-failing": "commits past a failing check; the note names each check let through",
    },
    example: 'atelier wrap "Fixed the parser" --next "Add the tests"',
  },
};

export default spec;
