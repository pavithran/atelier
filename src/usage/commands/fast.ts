import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "fast",
  // The mode routes (t585).
  capabilities: ["projects.mode.v1"],
  forms: [
    { group: "Developer", line: 7, slot: 20, form: "fast status [--json] [--project P]", about: "Prints the mode, every task landed in fast mode with its receipt and post-merge review state, and every build a runner made in fast mode and reported ready, one tN=SHA line each." },
    { group: "Developer", line: 7, slot: 30, form: "fast close [--project P]", about: "The developer switches back to full mode (atelier mode full) and prints what landed in fast mode and each post-merge review's state." },
    { group: "Agents", line: 2, slot: 12, form: "fast take ID --as H/M [--runner home:NAME] [--dispatch AT] [--json]", about: "In fast mode, takes a dispatched build without a fork: records the holder as a claim does, with no fork and no write token, and makes a clean clone of main for it on this machine. A clone that holds a commit an earlier run never reported is reported without a rebuild when it was made for the same dispatch; any other existing clone is moved aside to a .parked- folder beside it, never removed. A runner calls it in place of claim while the project is in fast mode." },
    { group: "Agents", line: 2, slot: 14, form: "fast ready ID --as H/M [--commit SHA]", about: "In the clone fast take made, reports its head (or SHA) as ready to merge, with the main it was built on and the builder its Agent line names. Nothing is pushed; the developer merges it and records the merge with `record-merge`." },
  ],
  flags: { json: true, runner: false, dispatch: false, commit: false },
  subcommands: {
    status: { takes: ["json"], capabilities: ["runners.fast-build.v1"] },
    close: { takes: [] },
    // A runner's fast build (t589): the take without a fork and the report.
    take: { takes: ["runner", "dispatch", "json"], capabilities: ["runners.fast-build.v1"] },
    ready: { takes: ["commit"], capabilities: ["runners.fast-build.v1"] },
  },
  help: {
    flags: {
      "--json": "fast status prints the mode, the fast landings and the ready builds as JSON; fast take prints the workspace, its base and whether it was kept",
      "--runner home:NAME": "fast take names the runner taking the build",
      "--dispatch AT": "fast take resumes an earlier clone only when it was made for this dispatch (the time the queue's assignment names); a runner passes it",
      "--commit SHA": "fast ready reports this commit of the clone instead of its head",
    },
    example: "atelier fast status --project atelier",
  },
};

export default spec;
