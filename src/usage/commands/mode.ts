import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "mode",
  // The project's mode routes (t585), which an older server answers 404.
  capabilities: ["projects.mode.v1"],
  forms: [
    { group: "Owner", line: 6, slot: 10, form: "mode [--project P]", about: "Prints the project's mode: \"Mode: full\" (the default, the gated process) or \"Mode: fast since TIME (reason)\"." },
    { group: "Owner", line: 6, slot: 20, form: "mode fast --reason TEXT [--project P]", about: "The project owner switches the project to fast mode, recorded as a standing decision with the reason. In fast mode the owner lands finished tasks in batches with atelier fast land; it has no end time." },
    { group: "Owner", line: 6, slot: 30, form: "mode full [--project P]", about: "The project owner switches back to full mode, withdrawing the fast mode decision, and prints what landed in fast mode and each post-merge review's state." },
  ],
  flags: { reason: "--reason needs text: atelier mode fast --reason \"why\"" },
  subcommands: { fast: { takes: ["reason"] }, full: { takes: [] } },
  help: {
    flags: { "--reason TEXT": "why the project goes to fast mode; required, at most 500 characters" },
    example: 'atelier mode fast --reason "Artifacts fails every new fork" --project demo',
  },
};

export default spec;
