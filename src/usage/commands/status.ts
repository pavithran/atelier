import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "status",
  forms: [
    {
      group: "Items", line: 2, slot: 60,
      form: "status [--project P] [--brief] [--json]",
      aside: "with a project: where it stands, as text",
      about: "Prints the owner's queue for every project: what waits for the owner, which pairs of live tasks name overlapping scopes (each pair once, nothing waiting on the owner), what is in progress and what waits for a runner, with the live item each dispatch the project's core files holds waits on, each open review request among it with its reviewer named, and, for any queued job no live runner offers, that it can never be claimed until a runner that offers it is started, which is a mismatch between the dispatch and the runners rather than a wait. It warns first, under Token expiries, from 14 days before each named token's recorded expiry day (`atelier ops token-expiry NAME --on YYYY-MM-DD` records it), naming the token and the date. With `--project` it prints where one project stands instead, ending with whether this checkout is in step with the baseline and, when any of the project's tasks has a workspace on this Mac, an On this Mac section: each live task's workspace with its uncommitted changes, commits not pushed to its fork, a merge in progress and a waiting COMMIT_MSG.txt, a count of the merged or abandoned tasks' workspaces left behind, and whether a landing is running here for the project. `--brief` prints the report to give the owner after each landing, in under 20 lines: the recent merges, the commit the server is deployed at, live builds, reviews and the landing running, and 24-hour spend against the daily limit. `--json` prints machine-readable records, each task with its created, updated and last-push times, as Observatory reads them, the overlapping pairs under `overlaps` and the same local facts under `local`.",
    },
  ],
  flags: { json: true, brief: true },
  help: {
    flags: {
      "--brief": "the report to give the owner after each landing, in under 20 lines: recent merges, the deployed commit, live builds, reviews and landings, and spend against the daily limit; the project is --project, else this checkout's",
      "--project P": "where one project stands, as text, instead of the owner's queue for every project; ends with an On this Mac section when any of its tasks has a workspace here",
      "--json": "prints machine-readable records, each item with its created, updated and last-push times and each project's overlapping task pairs under `overlaps`; with --project, also the local facts of this Mac's workspaces and any landing",
    },
    example: "atelier status --project demo",
  },
};

export default spec;
