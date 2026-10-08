// The CLI's printed text, as data, in one place. cli/atelier.mjs prints it
// (`atelier help`, `atelier COMMAND --help`, `atelier guide`) and src/how.ts
// draws the same table on the public How it works page, so the two cannot
// differ. Every form carries a description for that page; the CLI prints only
// the forms, and test/fixtures/cli pins what it prints byte for byte.

import { FILING_RELAY } from "./sessions.ts";

export interface Command {
  // The synopsis, as `atelier help` prints it.
  form: string;
  // One or two sentences for the web reference. Not printed by the CLI.
  about: string;
  // Text printed in parentheses after the form in `atelier help`.
  aside?: string;
}

export interface HelpGroup {
  name: string;
  // `atelier help` leaves a blank line before this group.
  gap?: true;
  // Each inner array is one printed line; its forms are joined with " · ".
  lines: Command[][];
}

export const HELP_TITLE = "atelier — one owner per task, observed evidence, the project owner decides.";

export const HELP_GROUPS: HelpGroup[] = [
  { name: "Sessions", lines: [[
    { form: "unwrap [--project P]", about: "Reads where the project stands, the state of this checkout, where its branch stands against each of the checkout's remotes as last fetched or pushed, the newest session note, the state file (the first of `docs/STATE.md`, `STATE.md` and `PROJECT.md` that exists) and any dated handoffs. It fetches and writes nothing. The project owner's session starts here." },
    { form: 'wrap "summary" [--next TEXT] [--found TEXT]... [--push] [--no-check | --allow-failing] [--project P]', about: "Closes the owner's session in the registered checkout: runs the registered checks and, when every one passes, commits everything with the summary as its subject, updates the baseline and records a session note on the ledger. A failing check refuses the commit, naming each failed check with how it ended, and leaves the checkout, the ledger and every remote as they were; `--allow-failing` commits anyway, and the note records which checks it let through. Check results are Reported, because they ran on the owner's machine. `--push` also pushes the checkout's own remotes; `--found` files a task for each defect found; `--no-check` skips the checks." },
  ]] },
  { name: "Setup", lines: [[
    { form: "login --server URL", about: "Stores this server's address and the owner's token, asking for the token when none is stored for it. A token the server refuses is not stored." },
    { form: "login --store", about: "Names the token store in use and whether it holds a token. It never prints the token." },
    { form: "init [--title TEXT] [--check CMD]... [--declare-read-only TEXT] [--protect GLOB]... [--core GLOB]... [--sandbox-only] [--refuse-overlap] [--approval TEXT] [--regenerate CMD] [--review-bar TEXT] [--review-tier H/M,H/M] [--reset] [--history-since YYYY-MM-DD]", about: "Run by the project owner in the project checkout: creates the baseline repository in Artifacts, pushes the current branch to it, and records that branch as the project's branch, the required checks, the protected paths and an optional title. Run again, it changes only what it names. `--sandbox-only` counts only checks run in a Cloudflare container, and `--refuse-overlap` refuses a claim whose scope overlaps another live item's. `--core` records the project's core files: the queue holds a dispatch whose scope overlaps, within a core file, the scope of a live item (claimed, submitted or accepted, outside the dispatch's own plan) until that item merges or is abandoned; unset, nothing is held. `--regenerate` records the command that regenerates the project's generated fixtures, which `atelier land` runs in a task's workspace after it merges main. `--review-bar` records what may block a review, which every review brief states; unset, the brief states the default bar (correctness, security or data-loss defects only). `--review-tier` names the top review tier, which reviews every protected change: the gate's cross-family review goes to a tier model first and then serves both, and only a gate reviewer outside the tier gets a separate tier review beside it; unset, none does. Every check must be read-only: a command that deploys, installs, publishes, pushes or spends money is refused, a known build or test command is read-only by its words, and `--declare-read-only` records the owner's reason for the others. `--reset` rebuilds the policy from the defaults; `--history-since` gives a project too large for Artifacts a baseline with its recent history only." },
    { form: "sync", about: "Refreshes the stored policy from the project's ControlPlane files. For a baseline built with `--history-since`, it also carries commits made in the checkout outside Atelier to the baseline." },
    { form: "publish", about: "Pushes the registered branch to the baseline with a write token. It is refused for a baseline that holds only part of the history; `sync` does that job." },
  ], [
    { form: "notes-remote [REMOTE | --off]", about: "Names a git remote that receives `refs/notes/atelier`, the merge provenance, and only that ref, on every merge. `--off` stops it; with no argument it says what is set. The setting is kept on this machine." },
  ]] },
  { name: "Items", lines: [[
    { form: 'new "short title" [--brief TEXT] [--accept TEXT]... [--scope GLOB]... [--non-goal TEXT]... [--stop-when TEXT]... [--next-gate TEXT]', about: "The project owner creates a task with a short title (at most 80 characters, what every list shows), and optionally its brief (the whole task, shown on its page and given to the agents that build and review it), its acceptance criteria (a change that fails one is rejected in review), the globs it intends to touch, what it is not to do, what tells its holder to stop and ask, and the gate it goes to next. One long text with no --brief is kept as the brief, and the title is derived from its first clause. The brief, `atelier start` and the task's page show them." },
    { form: "edit ID [--title TEXT] [--brief TEXT] [--accept TEXT]... [--non-goal TEXT]... [--stop-when TEXT]... [--next-gate TEXT]", about: "The project owner changes a task's title, brief, acceptance criteria, non-goals, stop conditions or next gate. A flag given replaces that field, one left out keeps it, and an empty value clears it; the title cannot be cleared." },
  ], [
    { form: "ls [--all] [--json]", about: "Lists the project's tasks with state, owner and head. Merged and abandoned tasks need `--all`. `--json` prints them for scripts, each task with its created, updated and last-push times, as Observatory reads them." },
    { form: "show ID [--reviews] [--json]", about: "Prints a task's decision brief: what is decided, the recorded evidence, a recommendation and the task's address. `--reviews` also prints each review at each head with its whole note and findings; `--json` prints the brief, carrying the reviews, for scripts." },
    { form: "receipt ID [--json]", about: "Prints one task's whole story from the ledger, in the order it was recorded: created, claimed, each handoff and release, each pushed head as Artifacts answered it, each observed check at each head, each review with its verdict and every finding with the owner's verdict on it (confirmed, refuted or fixed), then the submission, acceptance and merge or abandonment that ended it. `--json` prints the task's events as the ledger holds them, in order." },
    { form: "owners [--json]", about: "Prints one line per live task: its state, its owner and since when." },
    { form: "inbox [--json]", about: "Prints the decision brief of each task that needs the project owner, most urgent first. `--json` prints the entries for scripts." },
    { form: "status [--project P] [--json]", aside: "with a project: where it stands, as text", about: "Prints the owner's queue for every project: what waits for the owner, which pairs of live tasks name overlapping scopes (each pair once, nothing waiting on the owner), what is in progress and what waits for a runner, with the live item each dispatch the project's core files hold waits on, each open review request among it with its reviewer named, and, for any queued job no live runner offers, that it can never be claimed until a runner that offers it is started, which is a mismatch between the dispatch and the runners rather than a wait. With `--project` it prints where one project stands instead, ending with whether this checkout is in step with the baseline and, when any of the project's tasks has a workspace on this Mac, an On this Mac section: each live task's workspace with its uncommitted changes, commits not pushed to its fork, a merge in progress and a waiting COMMIT_MSG.txt, a count of the merged or abandoned tasks' workspaces left behind, and whether a landing is running here for the project. `--json` prints machine-readable records, each task with its created, updated and last-push times, as Observatory reads them, the overlapping pairs under `overlaps` and the same local facts under `local`." },
    { form: "open", about: "Opens the server in a browser, using the macOS `open` command." },
  ]] },
  { name: "Agents", lines: [[
    { form: "start ID [--as H/M] [--runner home:NAME]", about: "Claims the task, prepares its workspace as `claim` does, and prints its title, brief, acceptance criteria, scope and any dispatch note. `--runner` names the runner when a runner claims a dispatched task." },
    { form: 'done "summary" [--sandbox]', about: "Pushes, runs the required checks and submits, in that order, and stops at the first step that fails, naming it. `--sandbox` runs the checks in a Cloudflare container. Its last line says `Ready for the owner` or what still blocks the task." },
  ], [
    { form: "claim ID --as H/M [--runner home:NAME]", about: "Takes ownership of a task, forks the baseline into the task's workspace, mints a write token for the claimant alone, clones the workspace and records the project's branch as the one it pushes to. Claiming again refreshes the token and that branch, saying when the branch changed. `--runner` names the runner when a runner claims a dispatched task." },
    { form: "finish [--sandbox] [--summary T]", about: "Run in the claimed workspace: pushes, runs the required checks and submits, only if they pass and the workspace has not changed meanwhile. `--sandbox` runs the checks in a Cloudflare container. `done` is `finish` with a required summary." },
    { form: "push [--force | --rollback]", about: "Pushes the workspace to the task's fork, then asks the Worker to read the head from Artifacts. The ledger records the head Atelier saw, not the one the agent named. It refuses, pushing nothing, when the workspace's branch is not the one the fork's HEAD names, since Atelier reads only that one. After `update`, `--force` pushes with a lease. `--rollback` returns the fork to an earlier commit of the recorded history, as the plan integrator does after a failed integration." },
    { form: "update", about: "Rebases the workspace onto whatever has merged to the baseline since the fork, then names the next step, `atelier push --force`, whose lease refuses to overwrite anything pushed since the workspace last fetched." },
    { form: "check [--sandbox] [--merged] [-- CMD]", about: "Runs each required check, or the command after `--`, in a clean clone of exactly the head Artifacts holds, measures which paths changed since the baseline, and records each result as Observed. `--sandbox` runs them in a Cloudflare container instead. `--merged` runs them on the would-be merge, the head merged with main as main is now, in a temporary merge commit that is never pushed; the result is recorded against both revisions, shown beside the merge preview, and goes stale when either moves. A local check runs with the caller's file access, so it can read their files and Keychain and reach the network; it is given only the environment variables toolchains need, and Atelier's tokens are redacted from its output before upload. Run untrusted code with `--sandbox`." },
    { form: "report [ID] \"what you verified and how\" [--item ID] [--project P]", about: "Records a Reported claim at the current head: what the agent verified and how. It goes on the task named, else on the workspace's task; in a workspace, another task's id needs `--item ID`. It is shown and never counted as a check." },
    { form: "submit [--summary T]", about: "Marks the task ready for the owner and prints what still blocks it, if anything. `--summary` stores a summary of the change with the submission." },
  ], [
    { form: "handoff ID --to H/M [--note TEXT]", about: "Moves ownership to another agent, with `--note` saying why. The old write token is revoked; the workspace and its history carry over." },
    { form: "release ID [--note TEXT]", about: "Gives the task up: it returns to open and the write token is revoked." },
    { form: 'block [ID] "what it is waiting on"', about: "The holder or the project owner blocks the task with what it is waiting on. It keeps its owner and workspace, leaves the runner queue and stuck detection, cannot be pushed, submitted, reviewed, handed off or released, and sits in the owner's inbox with the reason until it is unblocked." },
    { form: "unblock [ID]", about: "The holder or the project owner lifts the block, and the task returns to the state it was in." },
    { form: "diff ID", about: "For a reviewer: prints the task's commits and diff against the baseline, from a clean read-only clone." },
    { form: "review ID --approve|--reject [--note TEXT] [--head SHA] [--findings JSON]", about: "Records a verdict on the task's current head, with `--note` giving the reason. `--head` names the revision the verdict is for, and the server refuses one for any head but the current. `--findings` attaches a reviewer's structured findings. The rules say whose approval counts." },
    { form: "review-claim ID [--runner home:NAME]", about: "A reviewer's runner claims the task's open review request and gets the part, its brief's inputs and a read token for its fork." },
    { form: "review-release ID [--note T]", about: "A reviewer whose harness wrote no valid verdict lets the review request go, so another reviewer may take it." },
  ], [
    { form: "read-token ID", about: "Reads a token for the task's own fork, with its head and base, for a job that clones it outside a task or a review." },
    { form: "base-token ID", about: "Reads a token for the repository the task is measured against: the plan's fork for a part, the baseline otherwise." },
    { form: "integrated ID --part KEY --merge-commit SHA", about: "The integrator reports a verified merge of one part onto the plan's branch; the server checks the commit against the branch before recording it." },
    { form: "integration-failed ID --part KEY --reason TEXT [--kind conflict|checks]", about: "The integrator reports a failed merge, which sends the part back to its builder for rework with the reason. `--kind` says the failure was the part's own, a merge conflict or failing checks, which charges its builder an attempt; without it the builder is charged nothing." },
    { form: "refreshed ID --main-head SHA [--merge-commit SHA]", about: "The integrator reports a refresh: main's head, the one the refresh job names, merged into the plan's branch. The server checks the merge commit against the branch before recording it, and it becomes the commit later parts fork from and later integrations build on. Without `--merge-commit` the branch already held main's head, which the server checks." },
    { form: "refresh-failed ID --main-head SHA --reason TEXT [--kind conflict|checks]", about: "The integrator reports a refresh that conflicted or failed the plan's checks, after rolling the branch back. It is recorded on the plan with the reason and charges no part's builder; the tick does not try it again for that main head." },
  ]] },
  { name: "Owner", lines: [[
    { form: "accept ID [--head SHA] [--override-review REASON] [--note TEXT]", about: "The project owner accepts the task at its current head; `--head` names that head, and any other is refused. `--note` keeps the owner's word on the acceptance with it in the ledger. It is refused unless the gate is clear. When the change still lacks its independent review because no reviewer qualifies, `--override-review` overrides that review and accepts: the reason is required, the override is recorded as an event of its own, never as a review, and the task page and the inbox show it with its reason." },
    { form: "merge ID [--head SHA [--approve [--note TEXT]] [--override-review REASON]] [--policy-changed-ok]", about: "The project owner lands the accepted head in the registered checkout and publishes the merge to the baseline. With `--head`, a submitted task is accepted at that exact revision first: `--approve` records the owner's review, with `--note` as its reason, which is not the independent review, and `--override-review` accepts with the owner's override, as `accept` does. Run again, it resumes an interrupted merge; `--cancel` ends one. A plan whose branch would conflict with main is not accepted, and one accepted that conflicts at the merge is put back to building through `plan refresh`, which takes main into its branch." },
    { form: "merge ID --cancel [--discard-local]", about: "Ends an interrupted merge: the landing lease is released, so the task's owner can push again. An unpublished merge commit in the checkout is kept unless `--discard-local` removes it and returns the branch to where the merge began." },
    { form: "land ID [--reviewer H/M] [--no-review] [--wait] [--dry-run] [--release-lease] [--workflow [--checks local|container]]", about: "The project owner lands one task whole; a plan is refused before the lease, since it lands with `atelier merge ID --head H` at the integration head `plan show` prints and takes main through `plan refresh`. It takes the project's landing lease on the server, so two sessions never race main, then merges main into the task's workspace, stopping on conflicts and leaving them for the owner, naming the files. It regenerates the project's fixtures when the policy declares how (`init --regenerate`), pushes, runs the required checks and submits. It requests the independent review the gate needs through the review-request routes and waits for the verdict (up to 60 minutes, or ATELIER_LAND_REVIEW_TIMEOUT milliseconds), saying what the runners are busy with while the request is unclaimed, and, when no live runner offers the reviewer for the review job, that the request can never be claimed until one does, with the review by hand and the `--reviewer` that asks a model a runner offers, then accepts and merges. A named `--reviewer` is always asked, even where the gate needs no review, and a rejection stops the landing. Each step, its duration and the commits that came from main are recorded as land.* events, for the integration record. It refuses to start when the server's route level is lower than this CLI's, saying to deploy, and while another task's landing holds the lease, naming who holds it and since when, unless `--wait` queues behind it: the server keeps the landings waiting for the lease in the order they queued and hands it to the first of them when it frees, so one landing cannot take it ahead of another that waited longer, however their polls land. While it waits the landing asks the server again on every poll, says whose landing it waits behind and which landings are queued ahead, and starts when its turn comes (three hours at most, or ATELIER_LAND_WAIT_TIMEOUT milliseconds), so several landings started at once run in turn; a landing that stops asking drops out of the queue once 15 minutes pass without an ask. The lease is renewed while the landing runs, released on SIGINT or SIGTERM, and treated as free by the server once 15 minutes pass without a renewal, which the next landing reports when it takes the lease over. `--reviewer` names the reviewer; `--no-review` leaves the task submitted; `--wait` queues for the lease, in the order the landings queued; `--dry-run` prints the steps and the refusals without changing anything; `--release-lease` frees the project's lease, saying which task held it since when. `--workflow` lands through a Cloudflare Workflow instead: the lease, the submission, the review wait and the acceptance run on the server as durable steps, each retried through transient failures (an Artifacts 503, a lost connection) and needing no token, while this command shows the Workflow's stage and does the steps that need Git with a working tree when the Workflow asks: merging main and pushing (only once the Workflow holds the lease), and `atelier merge` once it has accepted. `--checks` says where the required checks run: `local` (the default) runs them on this machine in a clean clone of the pushed head before the head is reported, as the plain landing does, and the Workflow goes on only once the server has recorded every one passing, observed, at that head (failing ends the landing; no result within 30 minutes does too); `container` has the Workflow run them in a Cloudflare container, for a project whose suite finishes there. A conflict pauses the Workflow with the lease released and the files named; resolve and commit them, then run the same command again to resume. If the command stops (a closed laptop), the Workflow keeps its place: run it again to attach. `--dry-run` and `--workflow` together are refused." },
    { form: "abandon ID [--note TEXT] [--delivered-by tN]", about: "Closes the task without merging it. The holder's write token is revoked; the history and evidence stay. `--note` says why. `--delivered-by` records that the merged task tN delivered it, for work another task already brought in." },
    { form: "defect ID --note TEXT [--found-in ID]", about: "The project owner traces a defect to the revision the task was accepted at. Nothing about the task changes; the reliability record counts the defect against the model that built that revision and against each model that approved it. `--found-in` names the task the defect was found or fixed in." },
    { form: "finding ID --head SHA --index N --verdict confirmed|refuted|fixed [--note TEXT]", about: "The project owner records a verdict on one finding of a review: confirmed, that the finding was right and a fix followed; fixed, that it was right and is fixed; refuted, that it was wrong. `--head` names the review's revision and `--index` the finding's position in that review's findings, one based. The event is the record, and the reliability record counts the reviewer's findings confirmed and refuted, which measures its precision." },
  ], [
    { form: "run-report --actor H/M --role build|review --outcome KIND [--project P] [--item ID] [--detail TEXT]", about: "The project owner records a run that ended without a result the ledger saw, for a run outside the runner: an early stop, a permission stop, a duplicate design or an incomplete merge, beside stalled, timed-out and refused, which the runner reports itself. The reliability record counts it against the actor, and a review run counts as a review that never reached a verdict." },
    { form: "served MODEL --recorded H/M --from TIME --to TIME [--item ID]... [--note T] [--apply]", about: "The project owner records which model served events recorded under another, as when zcode served deepseek-flash while its events named glm-5.3. Each event recorded as `--recorded` from `--from` up to `--to`, on the tasks `--item` names or on every task, gets an annotation of its own, and the track record, the reliability record and the graph count it under the served model; the event itself never changes. Without `--apply` it lists the matches and records nothing. `--note` says how the owner knows." },
    { form: "approve ACTION --head SHA [--note T] [--expires 24h]", about: "The project owner approves one protected action, such as `deploy`, `install`, `paid-run` or `photos-writeback`, at one exact revision of the main line: the full SHA of a commit the baseline holds. `atelier ship` uses the approval once, at that revision only, and a later revision needs its own. It stands for 24 hours unless `--expires` gives from `1m` to `30d`; `--note` records why. Any other kind must be one the project's ship files name." },
    { form: "approvals [--all]", about: "Lists the approvals that stand, each with its kind, revision and expiry. `--all` adds the used, withdrawn and expired ones." },
    { form: "approvals withdraw ID [--note T]", about: "The project owner withdraws an approval no ship has used, so none can use it." },
  ], [
    { form: "ship [--dry-run] [--push]", about: "Run by the project owner in the registered checkout, clean and at the baseline's head: composes the ship order from the project's ControlPlane ship policy and adapter, or from `docs/atelier/ship.json`, and refuses before running anything when a protected step has no approval at that revision, naming the command that approves it. It then runs the steps in order and stops at the first that fails, recording each step's command, exit status, duration and redacted output tail on the ledger. It pushes only with `--push`, which needs no approval since ship is owner-only and runs at one exact revision, and never forces a push. `--dry-run` prints the steps and which approvals are present or missing, and runs nothing." },
  ]] },
  { name: "Plans", lines: [[
    { form: 'plan "goal" [--scope GLOB]... [--planner H/M]', about: "The project owner states a goal. Atelier creates the plan task and queues it as a plan job for the planner named, or else for the first model in the pool for research work that is not refused, not paid per token and may plan. A project has one active plan at a time. A runner that offers plan jobs takes it: the planner claims the plan task, reads its brief from the job-brief route and posts the plan document the harness wrote; by hand, a planner claims with `--runner` and runs `plan post`." },
    { form: "plan show ID [--json]", about: "Prints a plan: its phase, the newest proposal with its hash, or once approved each part with its state, dependencies, scope, routing and attempts, the live item outside the plan a queued part waits on while the project's core files hold it, any live review request naming the reviewer asked and whether a runner claimed it, and saying, when no live runner offers that reviewer for the review job, that the request can never be claimed until one does, with the reroute that names another, then the part dispatches used, why it is blocked, the main head the branch last took against main's head now with any refresh in flight or failed, and the command for each decision waiting on the owner. Before approval it shows the routing an approval would fix now, its reviewers judged against the live runner offers the same way. It accepts a part's id too." },
  ], [
    { form: "plan approve ID --hash HASH [--allow-paid]", about: "Approves the split, once, by the hash of its newest proposal; an older hash is refused. The routing of each part is fixed then, with the limits: 2 parts live at once, 3 attempts a part, 4 dispatches a part, 24 hours. A part that no model can build, or that no model of another family can review, refuses the approval; a reviewer counts only when a live runner offers it for the review job, and when no runner is live the pool stands, with the routing saying so. `--allow-paid` lets models paid per token build and review." },
    { form: 'plan revise ID --note TEXT', about: "Before approval, sends the plan back to its planner with a note; its next proposal replaces the one before." },
  ], [
    { form: "plan reroute ID --to H/M", about: "Names who builds an open part from now on, its attempts counted afresh; for a submitted part, or one blocked for want of an eligible reviewer, names its reviewer, in the pool or not, which must be of another family than every contributor; before approval, names another planner for the plan." },
    { form: "plan retry ID", about: "Counts an open part's attempts afresh, so its builder is asked again; before approval, asks the planner again." },
    { form: "plan refresh ID [--resolve [--to H/M]]", about: "Queues the plan's refresh job for the integrator, which merges main's head into the plan's branch, so later parts fork from it; parts wait for it before they are dispatched. The tick does this itself before it dispatches a part when main has moved, once per main head; this runs it again, as after a failed refresh. On a plan submitted or accepted, it first withdraws the submission and any acceptance and puts the plan back to building, and says so; the integrator submits it again once every part is integrated on a branch that holds main. It is refused before approval, once the plan is closed, while the plan's integrate or refresh job is queued or held, while a merge of the plan holds its landing lease, and when the branch already holds main's head. A refresh that conflicts adds a merge-main part to the plan, which a model builds: the runner merges main into the part's workspace and leaves the conflicts for it to resolve, and its integration puts main on the branch; no other part is dispatched until it is integrated. `--resolve` adds that part for main's head now without trying a refresh first, built by `--to` when named; it is refused while a refresh is queued, when the part for that head exists, while another merge-main part is not integrated, and when the branch already holds main's head." },
    { form: "plan stop ID [--note TEXT]", about: "Closes the plan and every part not yet merged, revoking their write tokens. The history and evidence stay." },
  ], [
    { form: "plan post ID FILE", about: "The holder of the plan task's claim, its planner, posts the plan document in FILE. An invalid one is refused with every error, and the planner gets one more attempt before the plan blocks." },
  ]] },
  { name: "Models", lines: [[
    { form: "models", about: "Lists the model pool: each model's harness, where it runs, its family and what a runner last found." },
    { form: "models add ID --harness H --where home|cloud [--provider P] [--endpoint URL] [--keychain NAME] [--alias A]... [--note TEXT]", about: "Adds or replaces a pool entry. Atelier never stores a key: `--keychain` names the Keychain entry that holds it, and a request that carries a key is refused. `--note` keeps a note with the entry." },
    { form: "models remove ID", about: "Removes a model from the pool." },
  ], [
    { form: "dispatch ID [--to home|cloud|any] [--agent A] [--model M] [--note T] [--job merge-main [--head H]] [--overlap-ok]", about: "Queues an open task for a kind of runner, and optionally an agent and model, instead of waiting for an agent to choose it; a held task is released and queued in the same step, keeping its workspace and commits. While the task's scope overlaps, within one of the project's core files (`init --core`), the scope of a live item, the queue holds it and offers it to no runner until that item merges or is abandoned; `atelier status` and `atelier queue` say which item it waits on, and `--overlap-ok` lets this dispatch through at once. `--job merge-main` sends a task whose landing conflicted with main back to its builder: the runner merges main at the named head into its workspace (main's head as the baseline holds it, unless `--head` names one) and leaves the conflicts for the builder to resolve and commit; then `atelier land ID` again. Project owner only." },
    { form: "undispatch ID", about: "Takes the task out of the queue." },
    { form: "queue", about: "Lists everything waiting for a runner, across projects, oldest first, and for each dispatch the project's core files hold, the live item it waits on." },
  ]] },
  { name: "Projects", lines: [[
    { form: "projects rename OLD NEW", about: "The project owner gives a project a new name on the server, and this machine's config entry moves to it. The ledger, the baseline repository and every fork stay where they are. The old name keeps working: the API serves it, old page links redirect, and tokens and workspaces that use it need no change. A name another project has or had, or one a removed project's ledger is kept under, is refused." },
    { form: "projects remove NAME [--force]", about: "Removes a project from the index and from this machine's config. The Artifacts repository and the ledger are kept. It is refused while work is live unless `--force` is given." },
    { form: "showcase set NAME [--named|--anonymous]", about: "The project owner adds a project to the public showcase. Anonymous is the default: the project's card and its task stories carry a neutral label from the project's kind, never its name, a task title, a path, a commit message or an address. `--named` shows the project by name. Nothing is public until this is run." },
    { form: "showcase remove NAME", about: "Takes the project off the public showcase. With no subcommand, `showcase` lists what is shown and how." },
    { form: "init --name NAME --rename-local", about: "Changes only this machine's local name for the registered checkout. Nothing on the server changes." },
  ], [
  ], [
    { form: "adopt --project NAME [--as H/M]", aside: "a ControlPlane project moves to Atelier", about: "Moves a ControlPlane project to Atelier as an ordinary task: claims it and, in its workspace, writes `bin/control-plane`, inserts the text `atelier guide` prints into AGENTS.md and commits without pushing. It then lists what the finishing agent must settle." },
  ]] },
  { name: "Local", lines: [[
    { form: "gc [--project NAME] [--dry-run | --apply]", about: "Previews the local workspace and check clones that are safe to remove; `--apply` removes them. It never touches Artifacts or the project checkout." },
    { form: "runner --name home:NAME [--once] [--config PATH] [--integrate]", about: "The home runner: polls the queue every 30 seconds, claims one eligible task and runs its configured harness in the claimed workspace. Each opencode run gets a data folder of its own beside the workspace, removed when the run ends, because opencode runs that share one deadlock on its database. When the harness commits, the runner runs `finish`. `--integrate` runs no harness: it offers only the integrate and refresh jobs and merges each part onto its plan's branch as atelier/integrator. `--once` handles at most one task." },
  ], [
    { form: "runner --discover [--name home:NAME] [--probe] [--dry-run] [--config PATH]", aside: "what each home model's harness serves", about: "Reports which model each home harness actually served, from the records the harness keeps, and sends the result to the server as each model's status. `--probe` also sends one short prompt to each model that can be probed; `--dry-run` reports nothing." },
  ], [
    { form: "runner --usage [--name home:NAME] [--dry-run] [--config PATH]", aside: "each tool's windows, served models, costs and balances", about: "Reports how much of each tool's allowance this machine has used: Codex's 5-hour and weekly windows, the requests and tokens zcode and opencode recorded by served model over the last 5 hours, 24 hours and 7 days (with cost, for opencode), and the DeepSeek balance when the runner config names its Keychain entry. After the tools' own figures it prints what the server read of the AI Gateway: each model's calls, tokens, cost and durations, and the calls per task the runners' cf-aig-metadata tags name; then each model's speed over the last 14 days (median build, review and claim-to-merge times with n, and the share of runs that stalled). Each tool's summary goes to the server under the runner's name, for the Usage page and its alerts; `--dry-run` reports nothing. It runs once, not as part of the runner loop. Claude's plan limits and Gemini's spend have no record on the machine and are not reported." },
  ]] },
  { name: "Ops", lines: [[
    { form: "ops COMMAND [ARGS...]", aside: "portfolio operations, run by the private atelier-ops toolkit when installed", about: "Hands everything after `ops` to the private `atelier-ops` toolkit, named by `ATELIER_OPS` or found on `PATH`. Without one it says so and exits 2." },
  ]] },
  { name: "Docs", lines: [[
    { form: "guide", aside: "paste into a project's AGENTS.md", about: "Prints the instructions an agent needs, to paste into a project's AGENTS.md or CLAUDE.md. `atelier adopt` inserts the same text." },
  ]] },
  { name: "Tokens", gap: true, lines: [[
    { form: "token issue --as H/M [--project P]... [--days N] [--label TEXT]", about: "The project owner issues a token bound to one actor and shown once. It expires in 30 days unless `--days` (1 to 365) says otherwise, and covers the named projects or all of them." },
    { form: "token ls", about: "Lists token records without the tokens or their hashes." },
    { form: "token revoke ID", about: "Revokes a token; later API requests with it are refused. Git credentials already issued keep their own lifetime." },
  ]] },
];

export const HELP_FOOTER = "Common flags: --project NAME, --as harness/model (or ATELIER_ACTOR). A switch such as --approve, --json or --sandbox-only is on when named alone. It takes the word true or false after it and never any other word: --sandbox-only false or --sandbox-only=false turns it off.";

// What `atelier help` prints, without the final newline.
export function helpText(): string {
  const out: string[] = [HELP_TITLE, ""];
  for (const group of HELP_GROUPS) {
    if (group.gap) out.push("");
    group.lines.forEach((line, i) => {
      const lead = i === 0 ? group.name.padEnd(11) : " ".repeat(11);
      out.push(lead + line.map((c, j) => (c.aside ? `${c.form}${j === line.length - 1 ? "   " : " "}(${c.aside})` : c.form)).join(" · "));
    });
  }
  out.push(HELP_FOOTER);
  return out.join("\n");
}

// Every form the help prints, in order.
export const HELP_FORMS: string[] = HELP_GROUPS.flatMap((g) => g.lines.flat().map((c) => c.form));

// What the usage of every command that runs checks locally says about them.
const LOCAL_CHECK = "A local check runs on this machine with your file access: it can read your files and your Keychain and reach the network. It is given only PATH, HOME and the few other environment variables toolchains need, and Atelier's tokens are redacted from its output before it is uploaded. Run untrusted code in the sandbox: atelier check --sandbox, atelier finish --sandbox, or a project set up with atelier init --sandbox-only.";
const LOCAL_CHECK_COMMANDS = new Set(["done", "finish", "check"]);

// What `atelier COMMAND --help` adds to the command's forms and descriptions.
export interface CommandHelp {
  // Each flag the command takes, as "--flag VALUE", and what it does. The
  // flags every command takes, --project and --as, are listed only where
  // the command gives them a meaning of their own.
  flags?: Record<string, string>;
  // One command line to copy, printed after "Example: ".
  example: string;
}

// The commands with usage of their own: every one the help lists except
// `ops`, which hands --help to the atelier-ops toolkit with everything after
// it, and `help`, which prints the table. test/command-help.test.mjs holds
// each flag list to the parser's flag table in cli/atelier.mjs.
export const COMMAND_HELP: Record<string, CommandHelp> = {
  unwrap: { example: "atelier unwrap --project demo" },
  wrap: {
    flags: {
      "--next TEXT": "what the next session should do; recorded in the note and the commit message",
      "--found TEXT": "files a task with this title; once per defect found, at most 100",
      "--push": "also pushes the registered branch to each of the checkout's own remotes",
      "--no-check": "skips the registered checks; the note records that they were skipped",
      "--allow-failing": "commits past a failing check; the note names each check let through",
    },
    example: 'atelier wrap "Fixed the parser" --next "Add the tests"',
  },
  login: {
    flags: {
      "--server URL": "the server, as https://HOST; plain http only for a server on this machine",
      "--store": "names the token store in use and whether it holds a token",
    },
    example: "atelier login --server https://atelier.zone",
  },
  init: {
    flags: {
      "--title TEXT": 'the project\'s title on its pages; --title "" clears it',
      "--check CMD": "a required check, run in a clean clone of the head; once per check",
      "--protect GLOB": "a protected path pattern, whose change needs an independent review; once per pattern",
      "--declare-read-only TEXT": "the owner's reason that a check not known to be read-only changes nothing outside the clone; every check must be read-only",
      "--sandbox-only": "counts only checks run in a Cloudflare container",
      "--refuse-overlap": "refuses a claim whose scope overlaps another live task's",
      "--core GLOB": "a core file pattern: the queue holds a dispatch whose scope overlaps a live item's within one until that item merges or is abandoned; once per pattern, replacing the recorded ones; --core \"\" alone clears them",
      "--approval TEXT": "records the project owner's approval of the copy in Artifacts; a ControlPlane project needs it",
      "--reset": "rebuilds the policy from the defaults and the options given",
      "--history-since YYYY-MM-DD": "builds the baseline from the commits since that day only, for a project too large for Artifacts",
      "--regenerate CMD": "the command that regenerates the project's generated fixtures, run by atelier land in a task's workspace after it merges main; --regenerate \"\" clears it",
      "--review-bar TEXT": "what may block a review, stated in every review brief (at most 1000 characters); --review-bar \"\" restores the default: correctness, security or data-loss defects only",
      "--review-tier H/M,H/M": "the top review tier: a protected change's gate review goes first to one of these of another family than every contributor, and serves as the tier review too; when the gate's reviewer is outside the tier, one of these that did not build the change reviews it beside, whatever its family: its rejection sends the change back, its approval never satisfies the gate, and a landing never waits for it; --review-tier \"\" clears it",
      "--name NAME": "the project's name; the checkout folder's name unless given",
      "--rename-local": "with --name, changes only this machine's name for the registered checkout",
    },
    example: 'atelier init --title "Demo" --check "npm test" --protect "src/rules.ts"',
  },
  sync: { example: "atelier sync --project demo" },
  publish: { example: "atelier publish --project demo" },
  "notes-remote": {
    flags: { "--off": "stops pushing refs/notes/atelier to a remote" },
    example: "atelier notes-remote origin --project demo",
  },
  new: {
    flags: {
      "--brief TEXT": "the whole task, shown on its page and given to the agents that build and review it",
      "--accept TEXT": "an acceptance criterion, at most 300 characters; once per criterion, at most 12",
      "--scope GLOB": "a path pattern the task intends to touch; once per pattern",
      "--non-goal TEXT": "something the task is not to do; once per entry",
      "--stop-when TEXT": "what tells the holder to stop and ask; once per entry",
      "--next-gate TEXT": "the gate the task goes to next",
    },
    example: 'atelier new "Fix the parser" --brief "Nested lists fail to parse; make them parse" --accept "A nested list parses" --scope "src/parser/**" --project demo',
  },
  edit: {
    flags: {
      "--title TEXT": "replaces the task's short title, at most 80 characters",
      "--brief TEXT": 'replaces the task\'s brief; --brief "" clears it',
      "--accept TEXT": 'replaces the task\'s acceptance criteria; once per criterion, or --accept "" alone to clear them',
      "--non-goal TEXT": 'replaces the task\'s non-goals; once per entry, or --non-goal "" alone to clear them',
      "--stop-when TEXT": 'replaces what tells the holder to stop and ask; once per entry, or --stop-when "" alone to clear it',
      "--next-gate TEXT": 'replaces the gate the task goes to next; --next-gate "" clears it',
    },
    example: 'atelier edit t3 --stop-when "The schema needs to change" --project demo',
  },
  ls: {
    flags: {
      "--all": "includes merged and abandoned tasks",
      "--json": "prints the tasks as JSON, each with its created, updated and last-push times",
    },
    example: "atelier ls --all --project demo",
  },
  show: {
    flags: {
      "--reviews": "prints each review at each head, with its whole note and every finding; a tier review is labelled as one, and a gate review by a tier model as the gate review, top tier",
      "--json": "prints the brief as JSON, with every review and its findings",
    },
    example: "atelier show t3 --project demo",
  },
  receipt: {
    flags: {
      "--json": "prints the receipt as JSON: the task's own fields and its whole event stream in the ledger's order",
    },
    example: "atelier receipt t3 --project demo",
  },
  owners: { flags: { "--json": "prints the list as JSON" }, example: "atelier owners --project demo" },
  inbox: { flags: { "--json": "prints the entries as JSON" }, example: "atelier inbox" },
  status: {
    flags: {
      "--project P": "where one project stands, as text, instead of the owner's queue for every project; ends with an On this Mac section when any of its tasks has a workspace here",
      "--json": "prints machine-readable records, each item with its created, updated and last-push times and each project's overlapping task pairs under `overlaps`; with --project, also the local facts of this Mac's workspaces and any landing",
    },
    example: "atelier status --project demo",
  },
  open: { example: "atelier open" },
  start: {
    flags: { "--runner home:NAME": "names the runner, when a runner claims a dispatched task" },
    example: "atelier start t3 --project demo --as claude-code/opus-5.5",
  },
  done: {
    flags: { "--sandbox": "runs the checks in a Cloudflare container instead of on this machine" },
    example: 'atelier done "The parser takes the new form"',
  },
  claim: {
    flags: { "--runner home:NAME": "names the runner, when a runner claims a dispatched task" },
    example: "atelier claim t3 --project demo --as claude-code/opus-5.5",
  },
  finish: {
    flags: {
      "--sandbox": "runs the checks in a Cloudflare container instead of on this machine",
      "--summary TEXT": "a summary of the change, stored with the submission",
    },
    example: 'atelier finish --summary "The parser takes the new form"',
  },
  push: {
    flags: {
      "--force": "after atelier update: pushes the rebased head, with a lease on the head Atelier recorded",
      "--rollback": "returns the fork to the workspace's HEAD, an earlier commit of the recorded history, dropping what was recorded after it, with a lease on the recorded head; the plan integrator's rollback",
    },
    example: "atelier push",
  },
  update: { example: "atelier update" },
  check: {
    flags: {
      "--sandbox": "runs the checks in a Cloudflare container instead of on this machine",
      "--merged": "runs the checks on the head merged with main as it is now, in a temporary merge commit that is never pushed; the result is recorded against both revisions",
    },
    example: "atelier check --merged",
  },
  report: {
    flags: {
      "--item ID": "the task the claim goes on, when it is not the workspace's",
      "--project P": "with an ID, records the claim there even from another task's workspace",
    },
    example: 'atelier report "Ran the app by hand; the parser takes the new form"',
  },
  submit: {
    flags: { "--summary TEXT": "a summary of the change, stored with the submission" },
    example: 'atelier submit --summary "The parser takes the new form"',
  },
  handoff: {
    flags: {
      "--to H/M": "the agent that takes the task",
      "--note TEXT": "why; kept with the handoff and shown to the next holder",
    },
    example: 'atelier handoff t3 --to codex/gpt-6-astra --note "Out of time; the tests are in test/parser"',
  },
  release: { flags: { "--note TEXT": "why; kept with the release" }, example: 'atelier release t3 --note "Blocked on the schema"' },
  diff: { example: "atelier diff t3 --project demo" },
  review: {
    flags: {
      "--approve": "records an approval",
      "--reject": "records a rejection",
      "--note TEXT": "the reason, shown with the verdict",
      "--head SHA": "the revision the verdict is for; the task's current head unless given, and any other is refused",
      "--findings JSON": "a JSON list of the reviewer's findings, kept with the verdict",
    },
    example: 'atelier review t3 --approve --note "The tests cover the new form" --as claude-code/opus-5.5',
  },
  accept: {
    flags: {
      "--head SHA": "the revision accepted; the task's current head unless given, and any other is refused",
      "--override-review REASON": "accepts without the independent review, when no reviewer qualifies; the reason is recorded",
      "--note TEXT": "the owner's word on the acceptance, kept with it in the ledger",
    },
    example: "atelier accept t3 --project demo",
  },
  merge: {
    flags: {
      "--head SHA": "the full revision to accept first, when the task is submitted and not yet accepted",
      "--approve": "with --head, records the owner's review of that revision, which is not the independent review",
      "--note TEXT": "with --approve, the review's note",
      "--override-review REASON": "with --head, accepts with the owner's override of a missing independent review",
      "--policy-changed-ok": "lands a change that touches paths the ControlPlane policy began to protect after acceptance, once that change of policy is reviewed",
      "--cancel": "ends an interrupted merge, so the task's owner can push again",
      "--discard-local": "with --cancel, removes the unpublished merge commit from the checkout",
    },
    example: "atelier merge t3 --project demo",
  },
  land: {
    flags: {
      "--reviewer H/M": "names the reviewer the request goes to, and the review is asked for even where the gate needs none; otherwise the server picks a model of another family than every contributor, when the gate needs a review",
      "--no-review": "skips waiting: the task is left submitted for the owner to settle the review by hand",
      "--wait": "queues for the landing lease while another task's landing holds it, saying whose landing it waits behind and which landings are queued ahead; the server hands the lease to the waiting landings in the order they queued, so it starts when its turn comes (three hours at most)",
      "--dry-run": "prints the steps and the refusals without changing anything",
      "--release-lease": "frees the project's landing lease, held by a landing that was killed, and says which task held it since when; the project owner alone may",
      "--workflow": "lands through a Cloudflare Workflow: the lease, the submission, the review wait and the acceptance are durable steps on the server with retries, while this command shows the stage and merges main, pushes and merges when the Workflow asks; a conflict pauses it until you resolve it and run the command again, and a rerun attaches to the live landing",
      "--checks local|container": "with --workflow, where the required checks run: local (the default) runs them on this machine in a clean clone of the pushed head before reporting it, and the Workflow goes on only once the server has recorded each passing, observed, at that head; container has the Workflow run them in a Cloudflare container",
    },
    example: "atelier land t3 --project demo",
  },
  block: { example: 'atelier block t3 "Waiting on the schema decision" --project demo' },
  unblock: { example: "atelier unblock t3 --project demo" },
  "review-claim": {
    flags: { "--runner home:NAME": "names the runner that claims the review request" },
    example: "atelier review-claim t3 --runner home:studio --project demo",
  },
  "review-release": {
    flags: { "--note TEXT": "why the review request is let go; kept with the event" },
    example: 'atelier review-release t3 --note "The harness wrote no verdict" --project demo',
  },
  "read-token": { example: "atelier read-token t3 --project demo" },
  "base-token": { example: "atelier base-token t3 --project demo" },
  integrated: {
    flags: {
      "--part KEY": "the part that was merged; required",
      "--merge-commit SHA": "the full hash of the merge commit on the plan's branch; required",
    },
    example: "atelier integrated t3 --part t4 --merge-commit 0123456789abcdef0123456789abcdef01234567 --project demo",
  },
  refreshed: {
    flags: {
      "--main-head SHA": "the full hash of the main head the refresh merged; required",
      "--merge-commit SHA": "the full hash of the merge commit on the plan's branch; left out when the branch already held main's head",
    },
    example: "atelier refreshed t3 --main-head 0123456789abcdef0123456789abcdef01234567 --merge-commit 89abcdef0123456789abcdef0123456789abcdef --project demo",
  },
  "refresh-failed": {
    flags: {
      "--main-head SHA": "the full hash of the main head the refresh tried to merge; required",
      "--reason TEXT": "why the refresh failed; shown on plan show",
      "--kind conflict|checks": "a merge conflict or failing checks",
    },
    example: 'atelier refresh-failed t3 --main-head 0123456789abcdef0123456789abcdef01234567 --reason "Conflict in docs/a.md" --kind conflict --project demo',
  },
  "integration-failed": {
    flags: {
      "--part KEY": "the part whose merge failed; required",
      "--reason TEXT": "why the merge failed; sent to the part's builder with the rework",
      "--kind conflict|checks": "the part's own failure, a merge conflict or failing checks, which charges its builder an attempt",
    },
    example: 'atelier integration-failed t3 --part t4 --reason "Conflict in src/api.ts" --project demo',
  },
  defect: {
    flags: {
      "--note TEXT": "what is wrong; required",
      "--found-in ID": "the task the defect was found or fixed in",
    },
    example: 'atelier defect t3 --note "It drops the last row" --found-in t9 --project demo',
  },
  finding: {
    flags: {
      "--head SHA": "the full revision the review was made at; required",
      "--index N": "the finding's position in that review's findings, one based; required",
      "--verdict V": "confirmed, refuted or fixed; required",
      "--note TEXT": "why; kept with the verdict",
    },
    example: 'atelier finding t3 --head 0123456789abcdef0123456789abcdef01234567 --index 2 --verdict confirmed --note "fixed in t9"',
  },
  "run-report": {
    flags: {
      "--actor H/M": "the harness/model the run ran; required",
      "--role build|review": "build or review; build unless given",
      "--outcome KIND": "stalled, timed-out, refused, early_stop, permission_stop, duplicate_design or incomplete_merge; required",
      "--project P": "the project the run was in",
      "--item ID": "the task the run was on",
      "--detail TEXT": "what happened",
    },
    example: 'atelier run-report --actor opencode/glm-5.3 --role build --outcome early_stop --project atelier --item t114 --detail "stopped after a refused read"',
  },
  served: {
    flags: {
      "--recorded H/M": "the actor the events were recorded under",
      "--from TIME": "the start of the span, as a date and time",
      "--to TIME": "the end of the span, up to which events are counted",
      "--item ID": "limits it to one task, once per task; every task unless given",
      "--note TEXT": "how the owner knows which model served them",
      "--apply": "records the annotations; without it, only lists the matches",
    },
    example: 'atelier served deepseek-flash --recorded zcode/glm-5.3 --from 2026-10-01T00:00 --to 2026-10-03T00:00 --apply',
  },
  approve: {
    flags: {
      "--head SHA": "the full revision of the main line the approval is for; required",
      "--note TEXT": "why; kept with the approval",
      "--expires DURATION": "how long it stands, from 1m to 30d; 24h unless given",
    },
    example: "atelier approve deploy --head 0123456789abcdef0123456789abcdef01234567 --project demo",
  },
  approvals: {
    flags: {
      "--all": "adds the used, withdrawn and expired approvals",
      "--note TEXT": "with withdraw, why; kept with the event",
    },
    example: "atelier approvals --all --project demo",
  },
  ship: {
    flags: {
      "--dry-run": "composes the ship order and checks its approvals, running nothing",
      "--push": "also pushes the registered branch to the project's own remotes; the owner's own act at this revision, needing no separate approval",
    },
    example: "atelier ship --dry-run --project demo",
  },
  plan: {
    flags: {
      "--scope GLOB": "with a goal, a path pattern the plan is to touch; once per pattern",
      "--planner H/M": "with a goal, the model that plans the work",
      "--json": "with show, prints the plan as JSON",
      "--hash HASH": "with approve, the full hash of the newest proposal",
      "--allow-paid": "with approve, lets models paid per token build parts",
      "--note TEXT": "with revise or stop, why; kept with the event",
      "--to H/M": "with reroute, the model that builds from now on, reviews a submitted part, or plans before approval; with refresh --resolve, the model that builds the merge-main part",
      "--resolve": "with refresh, adds a part that merges main's head into the branch and resolves its conflicts, instead of queuing a refresh",
    },
    example: 'atelier plan "Move the parser to the new grammar" --scope "src/parser/**" --project demo',
  },
  abandon: { flags: { "--note TEXT": "why; kept with the event", "--delivered-by tN": "a merged task that delivered this one's work; kept with the event" }, example: 'atelier abandon t3 --note "Superseded by t5" --project demo' },
  models: {
    flags: {
      "--harness H": "the harness that runs the model: opencode, claude-code, codex, zcode, gemini-cli or antigravity",
      "--where home|cloud": "home, a harness on a home runner; cloud, a hosted service",
      "--provider P": "the provider the harness reaches the model through; a cloud opencode model must name one",
      "--endpoint URL": "the endpoint the harness is pointed at, for a home server",
      "--keychain NAME": "the Keychain entry that holds the key; the key itself is never sent",
      "--alias A": "another name the harness reports the model under; once per alias",
      "--note TEXT": "a note kept with the entry",
    },
    example: "atelier models add gpt-6-astra --harness codex --where cloud",
  },
  dispatch: {
    flags: {
      "--to home|cloud|any": "the kind of runner; any unless given",
      "--agent A": "the agent the runner must run",
      "--model M": "the model the runner must use",
      "--note TEXT": "a note the agent reads with the task",
      "--job merge-main": "sends the task to its builder to merge main into its workspace and resolve the conflicts of a landing that stopped on them",
      "--head H": "with --job merge-main, the full hash of main's head to merge; main's head as the baseline holds it unless given",
      "--overlap-ok": "offers the dispatch to a runner although its scope overlaps a live item's within a core file; kept with this dispatch only",
    },
    example: "atelier dispatch t3 --to home --agent codex --note \"Keep it small\" --project demo",
  },
  undispatch: { example: "atelier undispatch t3 --project demo" },
  queue: { example: "atelier queue" },
  projects: { flags: { "--force": "removes the project although work on it is live" }, example: "atelier projects rename demo demo-site" },
  showcase: {
    flags: {
      "--named": "with set, shows the project by name",
      "--anonymous": "with set, shows the project under a neutral label; the default",
    },
    example: "atelier showcase set demo --named",
  },
  adopt: { example: "atelier adopt --project demo --as claude-code/opus-5.5" },
  gc: {
    flags: {
      "--project NAME": "the project whose clones are looked at; this folder's project unless given",
      "--dry-run": "lists what would be removed and removes nothing",
      "--apply": "removes the workspace and check clones that are safe to remove",
    },
    example: "atelier gc --project demo --apply",
  },
  runner: {
    flags: {
      "--name home:NAME": "this runner's name; home: and this machine's host name unless given",
      "--once": "handles at most one task, then exits",
      "--config PATH": "the runner config file; runner.json in the config folder unless given",
      "--integrate": "runs no harness; offers only the integrate and refresh jobs and merges each part onto its plan's branch",
      "--discover": "reports which model each home harness served, as each model's status",
      "--probe": "with --discover, also sends one short prompt to each model that can be probed",
      "--dry-run": "prints what would be reported and reports nothing",
      "--usage": "reports each tool's windows, served models, costs and balances",
    },
    example: "atelier runner --name home:studio --once",
  },
  guide: { example: "atelier guide >> AGENTS.md" },
  token: {
    flags: {
      "--as H/M": "the actor the token is bound to; every request with it must name that actor",
      "--project P": "limits the token to the named projects, once per project; without it, every project",
      "--days N": "how many days the token lasts, 1 to 365; 30 unless given",
      "--label TEXT": "a label kept with the token's record, to tell tokens apart in token ls",
    },
    example: "atelier token issue --as codex/gpt-6-astra --project demo --days 7",
  },
};

// The forms of one command, in the order the help prints them.
const formsOf = (cmd: string): Command[] => HELP_GROUPS.flatMap((g) => g.lines.flat()).filter((c) => c.form.split(" ")[0] === cmd);

const COMMON_LINE = "Every command also takes --project NAME and --as harness/model (or ATELIER_ACTOR); --help prints this.";

// What `atelier COMMAND --help` prints: a usage line for each of the
// command's forms, what each does, its flags and one example.
export function commandUsage(cmd: string): string {
  const forms = formsOf(cmd), help = COMMAND_HELP[cmd];
  if (!forms.length || !help) throw new Error(`no help for atelier ${cmd}`);
  const out = forms.map((c, i) => `${i ? "       " : "usage: "}atelier ${c.form}`);
  out.push(...forms.map((c) => c.about));
  if (LOCAL_CHECK_COMMANDS.has(cmd)) out.push(LOCAL_CHECK);
  const flags = Object.entries(help.flags ?? {});
  if (flags.length) {
    const width = Math.max(...flags.map(([flag]) => flag.length)) + 2;
    out.push("Flags:", ...flags.map(([flag, what]) => `  ${flag.padEnd(width)}${what}`));
  }
  out.push(COMMON_LINE, `Example: ${help.example}`);
  return out.join("\n");
}

// Per-command usage, shown by --help/-h and by a bad subcommand.
export const COMMAND_USAGE: Record<string, string> = Object.fromEntries(Object.keys(COMMAND_HELP).map((cmd) => [cmd, commandUsage(cmd)]));

// The text `atelier guide` prints, and, without its heading, the section
// `atelier adopt` inserts into a project's AGENTS.md. Kept in one place so the
// two cannot drift apart.
export function guideText(): string {
  return `## Working through Atelier

Several agents may work on this project at once. Each piece of work is a
task with exactly one owner. Never edit the project checkout directly.

1. \`atelier start ID --project NAME --as HARNESS/MODEL\` claims the task
   and prints its workspace, title, brief, acceptance criteria, scope and
   note. Work only there; a change that fails a criterion is rejected.
2. Commit your changes, then run \`atelier done "summary"\` in that workspace.
   It pushes, runs required checks and submits only after they pass. Relay
   its final line to the owner. The project owner accepts and merges.
3. \`atelier inbox\` and \`atelier show ID\` print briefs you can relay to the owner.
4. \`atelier ls --project NAME\` lists tasks. Ask the owner to create one if needed.
5. Individual steps remain available: \`atelier claim\`, \`atelier push\`,
   \`atelier check\` and \`atelier submit --summary "summary"\`.
   \`atelier report "…"\` records a Reported claim, never an Observed pass.
6. If you can't finish, \`atelier handoff ID --to HARNESS/MODEL --note "…"\`
   or \`atelier release ID\`. Your write token is revoked either way.
   Waiting on something only the owner can settle: \`atelier block ID "what"\`.
   The owner sees the reason in the inbox and runs \`atelier unblock ID\`.
7. Reviewing someone else's task: \`atelier diff ID\`, then
   \`atelier review ID --approve|--reject --note "…"\`. Changes to protected
   paths need approval from a model of another family than every agent
   that worked on the task.
8. \`atelier update\` rebases your workspace onto whatever has merged since.

For each session the project owner runs in the registered checkout:

1. Start a session with \`atelier unwrap --project NAME\`; relay its short paragraph.
2. End with \`atelier wrap "summary" --next "what is next"\` in the registered checkout. It runs the registered checks, commits, and always updates Atelier's own copy of the project, the baseline. A failing check stops it before anything is committed: fix the check, or add \`--allow-failing\` to commit anyway and record in the note which checks failed. It never pushes the project's own remotes unless \`--push\` is given; add \`--push\` only with the owner's approval for that session. It never deploys or publishes a release.
3. ${FILING_RELAY} Use repeatable \`--found TEXT\` on wrap to file tasks in this project.

A protected action (a deploy, a device install, a paid model run or a Photos
writeback) runs only with the project owner's approval for one exact revision
of the main line, given with \`atelier approve KIND --head SHA\` and used once.
\`atelier ship\`, run in the registered checkout when the owner asks, runs the
project's ship order, uses those approvals and records every step; its
\`--push\` pushes the branch to the project's own remotes and needs no
approval, being the owner's own act at that exact revision. Never approve an
action for the owner, and never run one without the owner's approval at that
revision.

Session notes keep metadata only, never prompts, transcripts or file contents.
Material for the owner to copy is one complete fenced block with a language
tag: bash for a command the owner runs, text for prose, a brief or an envelope.
Never leave prose the owner must select by hand. Save a copy under
~/Documents/ai-project-data/<project>/, never the portfolio root.
`;
}
