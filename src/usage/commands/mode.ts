import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "mode",
  // The project's mode routes (t585), which an older server answers 404.
  // mode fast --quote sends the developer's direction (t629), which needs
  // projects.developer-direction.v1 (requiredForCommand).
  capabilities: ["projects.mode.v1"],
  forms: [
    { group: "Developer", line: 6, slot: 10, form: "mode [--project P]", about: "Prints the project's mode: \"Mode: full\" (the default, the gated process) or \"Mode: fast since TIME (reason)\"." },
    { group: "Developer", line: 6, slot: 20, form: "mode fast --reason TEXT [--quote WORDS] [--project P]", about: "The developer switches the project to fast mode, recorded as a standing decision with the reason. The developer's direction confirms it: `--quote` with the developer's own words and `--as H/M` (or ATELIER_ACTOR) naming the model acting on them, both recorded with the switch and shown in the mode line. The refusal without them names the command to run on the developer's yes; the developer's permission from the project's Settings page (good for 15 minutes) still works. A project set up with --no-override refuses it either way. In fast mode the developer merges finished tasks and records each with atelier record-merge; it has no end time." },
    { group: "Developer", line: 6, slot: 30, form: "mode full [--quote WORDS] [--project P]", about: "The developer switches back to full mode, withdrawing the fast mode decision, and prints what landed in fast mode and each post-merge review's state. `--quote` with `--as H/M` records the developer's words and the acting model on the switch." },
  ],
  flags: { reason: "--reason needs text: atelier mode fast --reason \"why\"", quote: "--quote needs the developer's words: atelier mode fast --reason \"why\" --quote \"what the developer said\"" },
  subcommands: { fast: { takes: ["reason", "quote"], capabilities: ["projects.developer-direction.v1"] }, full: { takes: ["quote"], capabilities: ["projects.developer-direction.v1"] } },
  help: {
    flags: { "--reason TEXT": "why the project goes to fast mode; required, at most 500 characters", "--quote WORDS": "the developer's own words directing the switch; with --as H/M, the model acting on them, they confirm it with the developer token alone, and both are recorded" },
    example: 'atelier mode fast --reason "Artifacts fails every new fork" --project demo',
  },
};

export default spec;
