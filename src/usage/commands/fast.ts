import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "fast",
  // The landed-fast route and the mode routes (t585).
  capabilities: ["projects.mode.v1", "land.fast.v1"],
  forms: [
    { group: "Owner", line: 7, slot: 10, form: "fast land tN=SHA [tM=SHA ...] [--reviewer H/M] [--test CMD] [--typecheck CMD] [--regen CMD]", about: "In fast mode, in the owner's clean checkout of main: merges each SHA in order with git merge --no-ff, regenerates, runs the typecheck, the secret scan over the batch and one run of the tests. Any failure resets main to where it started. On success it records a landed-fast receipt per task, marks each merged and asks the post-merge review of each of the reviewer named, which may be of the builder's family. It never pushes or deploys." },
    { group: "Owner", line: 7, slot: 20, form: "fast status [--json] [--project P]", about: "Prints the mode and every task landed in fast mode, with its receipt and post-merge review state." },
    { group: "Owner", line: 7, slot: 30, form: "fast close [--project P]", about: "The project owner switches back to full mode (atelier mode full) and prints what landed in fast mode and each post-merge review's state." },
  ],
  flags: { reviewer: false, test: false, typecheck: false, regen: false, json: true },
  subcommands: { land: { takes: ["reviewer", "test", "typecheck", "regen"] }, status: { takes: ["json"] }, close: { takes: [] } },
  help: {
    flags: {
      "--reviewer H/M": "the model asked for each task's post-merge review; a model of the builder's family may answer in fast mode, never the builder itself",
      "--test CMD": "the batch's one test run; npm test unless given",
      "--typecheck CMD": "the typecheck; npm run typecheck unless given",
      "--regen CMD": "the regeneration; zsh bin/orchestrate/regen-fixtures.sh where the checkout has it",
      "--json": "fast status prints the mode and the fast landings as JSON",
    },
    example: "atelier fast land t575=1a2b3c4 t576=5d6e7f8 --reviewer opencode/glm-5.3 --project atelier",
  },
};

export default spec;
