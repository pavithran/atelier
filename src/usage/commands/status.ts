import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "status",
  forms: [
    {
      group: "Items", line: 2, slot: 60,
      form: "status [--project P] [--brief] [--json]",
      aside: "with a project: where it stands, as text",
      about: "Prints the developer's queue for every project: what waits for the developer, which pairs of live tasks name overlapping scopes (each pair once, nothing waiting on them), what is in progress and what waits for a runner, with every claimed or landing item each dispatch the project's core files holds waits on and when each stops holding, each open review request among it with its reviewer named, and, for any queued job no live runner offers, that it can never be claimed until a runner that offers it is started, which is a mismatch between the dispatch and the runners rather than a wait. The developer's branches of every project follow, each with its last commit and the Mac it was pushed from. It warns first, under Usage warnings, of each vendor window at 80 percent used or heading past its limit before it resets, naming the vendor, window and reset time, and of a usage report not heard from in 3 hours as unknown; then, under Token expiries, from 14 days before each named token's recorded expiry day (`atelier ops token-expiry NAME --on YYYY-MM-DD` records it), naming the token and the date. With `--project` it prints where one project stands instead, ending with whether this checkout is in step with the baseline, the developer's branches (`atelier branch`) with each one's last commit and the Mac it was pushed from, and, when any of the project's tasks has a workspace on this Mac, an On this Mac section: each live task's workspace with its uncommitted changes, commits not pushed to its fork, a merge in progress and a waiting COMMIT_MSG.txt, a count of the merged or abandoned tasks' workspaces left behind, and whether a landing is running here for the project. Both full text forms also list this machine’s live runners and task workspace processes by task, with process ids and ages, never full command lines. With `--project --json`, these appear under `processes`. `--brief` prints the report to give the developer after each landing, in under 20 lines: the recent merges, the commit the server is deployed at, live builds, reviews and the landing running, and 24-hour spend against the daily limit. `--json` prints machine-readable records, each task with its created, updated and last-push times, as Observatory reads them, the overlapping pairs under `overlaps` and the same local facts under `local`.",
    },
    {
      group: "Items", line: 2, slot: 61,
      form: "status --new [--project P] [--since T] [--brief] [--json]",
      aside: "what someone else filed or edited since you last looked",
      about: "Lists the tasks, closed ones included, that someone other than the caller filed or edited since the caller last looked: the latest such actor and time for each task, from the project's item.created and item.edited events, never from a task's holder or update time. The caller is the actor `--as` resolves; the project is `--project`, else this checkout's. The bookmark is the newest event of the last complete read, kept on this Mac per server, project and actor, and moves only after a complete read has been printed; the first run reads the last 24 hours and says so. The server answers only the newest 50 events, so a read that does not reach back to the bookmark says the list may be incomplete and keeps the bookmark. A source that cannot be read, or a bookmark that is corrupt or cannot be saved, prints `unread` and exits with status 1, never none. `--since T` reads from an instant with a time and a zone, such as 2026-10-16T08:00Z, refuses an invalid or future one, and leaves the bookmark alone. `--brief` prints one line; `--json` prints the project, actor, status (ok, incomplete or unread) and the tasks.",
    },
  ],
  flags: { json: true, brief: true, new: true, since: false },
  help: {
    flags: {
      "--brief": "the report to give the developer after each landing, in under 20 lines: recent merges, the deployed commit, live builds, reviews and landings, and spend against the daily limit; the project is --project, else this checkout's",
      "--project P": "where one project stands, as text, instead of the developer's queue for every project; ends with an On this Mac section when any of its tasks has a workspace here",
      "--new": "lists the tasks someone else filed or edited since you last looked (with --project, else this checkout's project); the bookmark is kept on this Mac per server, project and actor",
      "--since T": "with --new, reads from an instant with a time and a zone (2026-10-16T08:00Z) instead of the bookmark, and leaves the bookmark alone",
      "--json": "prints machine-readable records, each item with its created, updated and last-push times and each project's overlapping task pairs under `overlaps`; with --project, also the local facts of this Mac's workspaces and any landing",
    },
    example: "atelier status --project demo",
  },
};

export default spec;
