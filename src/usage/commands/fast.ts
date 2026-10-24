import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "fast",
  // The mode routes (t585).
  capabilities: ["projects.mode.v1"],
  forms: [
    { group: "Developer", line: 7, slot: 20, form: "fast status [--json] [--project P]", about: "Prints the mode, every task landed in fast mode with its receipt and post-merge review state, and every build a runner reported ready before the fork-less build was removed and whose task has not landed, one tN=SHA line each." },
    { group: "Developer", line: 7, slot: 30, form: "fast close [--project P]", about: "The developer switches back to full mode (atelier mode full) and prints what landed in fast mode and each post-merge review's state." },
  ],
  flags: { json: true },
  subcommands: {
    status: { takes: ["json"], capabilities: ["runners.fast-build.v1"] },
    close: { takes: [] },
  },
  help: {
    flags: {
      "--json": "fast status prints the mode, the fast landings and the ready builds as JSON",
    },
    example: "atelier fast status --project atelier",
  },
};

export default spec;
