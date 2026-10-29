import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "branch",
  // The developer's branches (t641).
  capabilities: ["projects.developer-branches.v2"],
  forms: [
    {
      group: "Setup", line: 3, slot: 10,
      form: "branch push [NAME] [--force]",
      about: "The developer carries work in progress to their other Macs: pushes the checkout's branch `dev/NAME` (the current branch unless NAME is given; a NAME without `dev/` is taken under it) to the project's repository on the server with the server token, which alone may write `dev/`, and records its last commit and this Mac. main, the project's branch, a task's id and any name outside `dev/` are refused before anything is sent, and main is never reached: it changes only through a landing. `--force` replaces a branch the push would not fast-forward.",
    },
    {
      group: "Setup", line: 3, slot: 20,
      form: "branch fetch NAME [--force]",
      about: "Fetches the developer's branch `dev/NAME` from the project's repository into the checkout's `dev/NAME`, which must not be the branch checked out. `--force` replaces a local branch the fetch would not fast-forward.",
    },
    {
      group: "Setup", line: 3, slot: 30,
      form: "branch ls",
      about: "Lists the developer's branches, newest push first, each with its last commit and the Mac it was pushed from, as `atelier status --project` does.",
    },
  ],
  flags: { force: true },
  subcommands: { push: { takes: ["force"] }, fetch: { takes: ["force"] }, ls: { takes: [] } },
  help: {
    flags: {
      "--force": "push or fetch a branch that does not fast-forward, replacing the other side's",
    },
    example: "ATELIER_ACTING=claude-code/opus-5.5 atelier branch push dev/idea --project demo",
  },
};

export default spec;
