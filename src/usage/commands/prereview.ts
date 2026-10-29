import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "prereview",
  forms: [
    {
      group: "Models", line: 2, slot: 50,
      form: "prereview ID --reviewer H/M [--project P] [--as H/M]",
      about: "Asks the pre-review of a task waiting in the landing queue: the named reviewer reviews it against the tree its landing would test, while the landing ahead holds the lease. Once per call; nothing asks one by itself. Without `--reviewer`, or with one a gate filter refuses (a contributor, a family match, no live runner offering the prereview job), it refuses, listing every candidate with its figures. A blocking verdict fences the landing until `atelier unblock ID`.",
    },
  ],
  flags: { reviewer: false },
  help: {
    flags: { "--reviewer H/M": "the reviewer whose runner pre-reviews the queued landing; a live runner must offer it the prereview job" },
    example: "ATELIER_ACTING=claude-code/opus-5.5 atelier prereview t3 --reviewer codex/gpt-6-astra --project demo",
  },
};

export default spec;
