import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "ship",
  forms: [
    {
      group: "Developer", line: 5, slot: 10,
      form: "ship [--dry-run] [--push]",
      about: "Run by the developer in the registered checkout, clean and at the baseline's head: composes the ship order from the project's `docs/atelier/ship.json` alone, and refuses before running anything when a protected step has no approval at that revision, naming the command that approves it. It then runs the steps in order and stops at the first that fails, recording each step's command, exit status, duration and redacted output tail on the ledger. A request step may name what its answer must hold: `expect` is the text the body must contain, with `{commit}` standing for the full revision being shipped and `{short}` for its first eight characters; `header` looks for that text in the named response header instead of the body; and `redirect` may be `forbid`, which fails any 3xx answer, naming where it pointed. A verify step that passes with no expected text, and with no command of its own, is reported as delivered with its version not proven. It pushes only with `--push`, which needs no approval since ship is developer-only and runs at one exact revision, and never forces a push; a remote the project declares a public mirror (`init --public-mirror`) takes only commits under the project's no-reply address. `--dry-run` prints the steps and which approvals are present or missing, and runs nothing.",
    },
  ],
  flags: { "dry-run": true, push: true },
  help: {
    flags: {
      "--dry-run": "composes the ship order and checks its approvals, running nothing",
      "--push": "also pushes the registered branch to the project's own remotes; the developer's own act at this revision, needing no separate approval",
    },
    example: "ATELIER_ACTING=claude-code/opus-5.5 atelier ship --dry-run --project demo",
  },
};

export default spec;
