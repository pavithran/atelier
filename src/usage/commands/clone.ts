import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "clone",
  forms: [
    {
      group: "Setup", line: 1, slot: 35,
      form: "clone PROJECT [DIR] [--replace]",
      about: "Makes this Mac's checkout of a project from its baseline: clones the baseline's main, with every Git hook off, with its whole history and the receipts on `refs/notes/atelier` into DIR (`~/src/PROJECT` unless given, which must be missing or empty), keeps the baseline as origin, with no token kept in the checkout (each command that reaches the baseline mints its own, as `sync` does), sets the project's commit identity, and registers DIR as the project's checkout on this Mac. A baseline holding part of the history is registered as one, each of its commits paired with itself. A project already registered here at another path is refused unless `--replace` is given.",
    },
  ],
  flags: { replace: true },
  help: {
    flags: {
      "--replace": "registers DIR in place of the checkout this Mac already registers for the project; that folder is left as it is",
    },
    example: "atelier clone demo ~/src/demo",
  },
};

export default spec;
