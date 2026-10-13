import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "fast",
  // The landed-fast route and the mode routes (t585).
  capabilities: ["projects.mode.v1", "land.fast.v1"],
  forms: [
    { group: "Developer", line: 7, slot: 10, form: "fast land tN=SHA [tM=SHA ...] [--reviewer H/M] [--test CMD] [--typecheck CMD] [--regen CMD]", about: "In fast mode, in the developer's clean checkout of main: merges each SHA in order with git merge --no-ff, regenerates, runs the typecheck, the secret scan over the batch and one run of the tests, by default in a temporary clean clone of the batch's head (npm ci --prefer-offline, npm run types, then npm test), removed afterwards. Any failure resets main to where it started. On success it writes the batch's receipts to a file under the checkout's .git directory, then records a landed-fast receipt per task, marks each merged and asks the post-merge review of each of the reviewer named, which may be of the builder's family. A receipt that fails names what was recorded and the atelier fast record command that records the rest. It never pushes or deploys." },
    { group: "Developer", line: 7, slot: 15, form: "fast record [FILE] [--reviewer H/M] [--project P]", about: "Records the receipts a fast land wrote under .git/atelier-fast-land and could not all post (FILE, or the only one there): posts only those not yet recorded, never merges, refuses when main no longer holds a receipt's merge commit or an object of the batch is missing or changed, and removes the file once every receipt is recorded. The reviewer is the one fast land was given unless --reviewer names another." },
    { group: "Developer", line: 7, slot: 20, form: "fast status [--json] [--project P]", about: "Prints the mode, every task landed in fast mode with its receipt and post-merge review state, and every build a runner made in fast mode and reported ready, one tN=SHA line each, which atelier fast land takes as it stands." },
    { group: "Developer", line: 7, slot: 30, form: "fast close [--project P]", about: "The developer switches back to full mode (atelier mode full) and prints what landed in fast mode and each post-merge review's state." },
    { group: "Agents", line: 2, slot: 12, form: "fast take ID --as H/M [--runner home:NAME] [--json]", about: "In fast mode, takes a dispatched build without a fork: records the holder as a claim does, with no fork and no write token, and makes a clean clone of main for it on this machine. A clone that holds a commit an earlier run never reported is kept. A runner calls it in place of claim while the project is in fast mode." },
    { group: "Agents", line: 2, slot: 14, form: "fast ready ID --as H/M [--commit SHA]", about: "In the clone fast take made, reports its head (or SHA) as ready for fast land, with the main it was built on and the builder its Agent line names. Nothing is pushed; the developer's atelier fast land takes it." },
  ],
  flags: { reviewer: false, test: false, typecheck: false, regen: false, json: true, runner: false, commit: false },
  subcommands: {
    land: { takes: ["reviewer", "test", "typecheck", "regen"] },
    // Resumes a fast land whose receipts did not all post (t602).
    record: { takes: ["reviewer"] },
    status: { takes: ["json"], capabilities: ["runners.fast-build.v1"] },
    close: { takes: [] },
    // A runner's fast build (t589): the take without a fork and the report.
    take: { takes: ["runner", "json"], capabilities: ["runners.fast-build.v1"] },
    ready: { takes: ["commit"], capabilities: ["runners.fast-build.v1"] },
  },
  help: {
    flags: {
      "--reviewer H/M": "the model asked for each task's post-merge review; a model of the builder's family may answer in fast mode, never the builder itself",
      "--test CMD": "the batch's one test run, in the checkout; without it npm test runs in a clean clone of the batch's head, and the receipt says where the tests ran",
      "--typecheck CMD": "the typecheck; npm run typecheck unless given",
      "--regen CMD": "the regeneration; zsh bin/orchestrate/regen-fixtures.sh where the checkout has it",
      "--json": "fast status prints the mode, the fast landings and the ready builds as JSON; fast take prints the workspace, its base and whether it was kept",
      "--runner home:NAME": "fast take names the runner taking the build",
      "--commit SHA": "fast ready reports this commit of the clone instead of its head",
    },
    example: "atelier fast land t575=1a2b3c4 t576=5d6e7f8 --reviewer opencode/glm-5.3 --project atelier",
  },
};

export default spec;
