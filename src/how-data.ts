// What the How it works page says, as data, apart from its markup (src/how.ts)
// so that node tests can read it without the stylesheets. The command
// reference is not here: it is drawn from src/usage.ts, the table the CLI
// prints. Inline `code` spans use backticks; src/how.ts turns them into <code>.
//
// test/how.test.ts keeps this honest. Every rule names the function that
// enforces it and the test finds that name in that file; every orchestrator
// part says whether it is built, and the test checks its files, the code it
// names and the commands against that answer.

export type Lane = "owner" | "agent" | "reviewer";

export interface Step {
  name: string;
  lane: Lane;
  // The command that does it, as the diagram's second line.
  command: string;
  // What moves from the actor to Atelier, on the diagram's arrow.
  moves: string;
  // What Atelier records, one box of at most four short lines.
  records: string[];
  // The same step in the list under the diagram.
  detail: string;
  // Drawn dashed: required only for some changes.
  conditional?: true;
}

export const LOOP: Step[] = [
  {
    name: "Task", lane: "owner", command: "new", moves: "a new task",
    records: ["Task and scope", "recorded; the", "task is open"],
    detail: "The project owner creates the task with `atelier new \"title\" --scope 'src/**'`. The scope is the paths the task intends to touch. Overlapping live scopes are flagged in the inbox, and a project whose policy says so refuses a claim that overlaps another.",
  },
  {
    name: "Claim", lane: "agent", command: "start", moves: "a claim",
    records: ["One owner, set", "atomically; a", "second claim", "is refused"],
    detail: "An agent claims it with `atelier start t3 --as harness/model`. The project's Durable Object handles one request at a time, so a second claimant is refused.",
  },
  {
    name: "Workspace", lane: "agent", command: "push", moves: "a push",
    records: ["Own fork made;", "head read from", "Artifacts, not", "as reported"],
    detail: "The Worker forks the baseline into a repository for the task and mints an eight-hour write token for the claimant alone. The agent works in a clone outside the project checkout, commits, and runs `atelier push`. Atelier reads the head from Artifacts and records that head; when the agent named a different one, the ledger records the mismatch.",
  },
  {
    name: "Checks", lane: "agent", command: "check", moves: "a check result",
    records: ["Observed result", "at that head:", "pass or fail"],
    detail: "`atelier check` clones the workspace afresh at that head, runs each required check, measures which paths changed since the baseline, and records each result as Observed. `--sandbox` runs the checks in a Cloudflare container instead. `--merged` runs them on the would-be merge, the head merged with main as it is now, and the result stands beside the merge preview, bound to both revisions. `atelier report` adds a Reported claim. `atelier submit` marks the task ready, and `atelier done \"summary\"` runs push, check and submit in order.",
  },
  {
    name: "Review", lane: "reviewer", command: "review", moves: "a review", conditional: true,
    records: ["Verdict at that", "head; it counts", "if the reviewer", "is independent"],
    detail: "A reviewer, an agent that did not work on the task, reads the change with `atelier diff t3` and records `atelier review t3 --approve`, or `--reject --note \"…\"`. A review is required when the change touches a protected path and, under a ControlPlane policy, when it is a coordinated change; Independent review of protected paths says whose approval counts. The owner may review too, and the owner's rejection blocks, but the owner's approval is never the required review.",
  },
  {
    name: "Accept", lane: "owner", command: "accept", moves: "an acceptance",
    records: ["Head pinned; the", "gate must be", "clear first"],
    detail: "The project owner accepts with `atelier accept t3` or the Accept button. The gate, set out under Owner acceptance and merge, must be clear. Acceptance pins the head. When a required review is all that is missing and no reviewer qualifies, the owner accepts with `atelier accept t3 --override-review \"reason\"` instead, which records an override with its reason, not a review.",
  },
  {
    name: "Merge", lane: "owner", command: "merge", moves: "a merge commit",
    records: ["Merge commit", "found on the", "baseline"],
    detail: "In the project checkout the owner runs `atelier merge t3`. It fetches exactly the accepted head, merges it with `--no-ff`, attaches the task's provenance as a git note on `refs/notes/atelier`, and pushes the project's branch to the baseline. Pushing to the project's own remotes and deploying remain separate decisions.",
  },
];

export const LOOP_RETURN = "a later push moves the head: back to step 4";

export const LOOP_CAPTION = "The loop from task to merge. The owner, an agent and a reviewer act in the three upper lanes. Each step sends one thing to Atelier, named on its arrow, and the lowest lane shows what Atelier records. The review is dashed because only some changes require one. A push after step 4 moves the head, so checks, reviews and acceptance start again.";

export const LOOP_LABEL = "The loop from task to merge in seven steps across four lanes. The owner creates a task. An agent claims it, pushes work to its own fork, and runs checks that Atelier records as Observed at that head. A reviewer reviews when the change requires it. The owner accepts the exact head and merges it, and Atelier records the merge commit found on the baseline. A later push returns the task to the checks.";

export interface Term { term: string; meaning: string }

export const TERMS: Term[] = [
  { term: "Task", meaning: "One piece of work: a title, a scope of the paths it intends to touch and, once claimed, an owner. The API reference calls it an item." },
  { term: "Baseline", meaning: "Atelier's copy of the project's branch, the one `atelier init` registered (often `main`), held in an Artifacts repository." },
  { term: "Workspace", meaning: "A task's own fork of the baseline, also an Artifacts repository. Only the task's owner holds a write token for it." },
  { term: "Head", meaning: "The latest commit in a workspace. Results, reviews and acceptance each name the head they apply to." },
  { term: "Observed", meaning: "A required check's result, recorded against the head Atelier read from Artifacts, from a run on a clean clone of that head." },
  { term: "Reported", meaning: "A statement an agent made about its own work. It is shown and never counted." },
  { term: "Pending", meaning: "A required check with no Observed result at the current head." },
  { term: "Gate", meaning: "The function that decides whether a task can be accepted and lists what still blocks it: `gate` in `src/rules.ts`." },
  { term: "Protected path", meaning: "A path whose change needs an independent review. The project lists some; Atelier adds the files its required checks execute." },
];

export interface Rule {
  title: string;
  // What the code does.
  enforced: string;
  // Why, in one sentence.
  why: string;
  // Where it is enforced; the test finds each symbol in its file.
  where: { file: string; symbol: string }[];
}

export const RULES: Rule[] = [
  {
    title: "One owner per task",
    enforced: "A task has at most one owner. The project's Durable Object handles one request at a time, so when two agents claim a task the second is refused. Ownership changes only through a recorded event: a claim, a handoff, a release, an abandonment or a merge.",
    why: "Two agents writing to one workspace overwrite each other, and nobody could say afterwards who did what.",
    where: [{ file: "src/rules.ts", symbol: "assertClaimable" }, { file: "src/rules.ts", symbol: "assertOwner" }],
  },
  {
    title: "Separate forks for agents",
    enforced: "A claim forks the baseline into a repository for that task, and the claimant's write token covers that repository alone. Only the owner token can obtain a write token for the baseline; an agent token is refused.",
    why: "A wrong or abandoned change in one workspace cannot touch the baseline or another task's work.",
    where: [{ file: "src/tokens.ts", symbol: "agentRoute" }],
  },
  {
    title: "One write token per workspace",
    enforced: "A claim revokes the workspace's earlier write token before it mints a new one, so only one is live. The token lasts eight hours, and a handoff, a release or an abandonment revokes it.",
    why: "An agent that has handed work on or given it up must not be able to keep pushing to it.",
    where: [{ file: "src/index.ts", symbol: "revoke" }],
  },
  {
    title: "Observed evidence only",
    enforced: "`atelier check` runs each required check on a clean clone of the head Artifacts holds and posts the result as a check. The Worker stores a check as Observed and a report as Reported, and the gate counts Observed results only. A required check with no Observed result at the head is Pending and blocks acceptance. Under `sandboxOnly`, only results from a Cloudflare container count. A check run with `--merged`, on the head's merge with main as it is now, is recorded against both revisions and never counts as the head's own check; it blocks acceptance only when it fails after main moved past the head the passing checks were recorded against.",
    why: "An agent's own statement that its tests pass is not evidence; the owner needs results taken from a clean clone of the head, though only a container result is produced by Atelier itself, and a local Observed result is posted by the machine that ran it.",
    where: [{ file: "src/rules.ts", symbol: "evidenceAt" }, { file: "src/rules.ts", symbol: "gate" }, { file: "src/rules.ts", symbol: "mergedBlockers" }],
  },
  {
    title: "Evidence bound to a head",
    enforced: "A result, a review and an acceptance each name the head they apply to. Atelier refuses a result or a review for any head but the task's current one, reads the head from Artifacts instead of taking the agent's word for it, and withdraws acceptance when a push moves the head.",
    why: "An approval of one revision must not authorise another, and a pass at one revision says nothing about the next.",
    where: [{ file: "src/rules.ts", symbol: "assertRevision" }, { file: "src/ledger.ts", symbol: "recordPush" }],
  },
  {
    title: "Independent review of protected paths",
    enforced: "A change that touches a protected path needs an approving review from a model of another family than every model that contributed to the task, in every project, with or without a ControlPlane policy. The family is read from the model's name, and a family Atelier does not recognise never qualifies, in a reviewer or in a contributor. The project owner's approval is not this review; the owner accepts and merges. When no reviewer qualifies, the owner can override the review while accepting, giving a reason: the override is recorded as an event of its own, never as a review, counts only at that head, and the task page and the inbox show it with its reason. The protected paths are those the project lists (by default `AGENTS.md`, `CLAUDE.md` and `wrangler.*`) and what a required check executes: the scripts it runs, the recipe files of make and just, the manifest and configuration a package manager or build tool runs scripts from, and the local binary npx would run. Under a ControlPlane policy a coordinated change, one that is neither protected nor direct, needs a review from any agent who did not contribute, and the owner's approval is not that review either.",
    why: "The model that wrote a change to the files that instruct agents or grade their work must not approve it, and nor should a model of its family, which is likely to share its blind spots.",
    where: [{ file: "src/rules.ts", symbol: "changeClass" }, { file: "src/rules.ts", symbol: "checkFiles" }, { file: "src/rules.ts", symbol: "independentApproval" }, { file: "src/rules.ts", symbol: "reviewOverrideFor" }],
  },
  {
    title: "No self-review",
    enforced: "The task's current owner cannot record a review of it. Everyone who has held the task or pushed to its workspace stays a contributor, so a review by any of them never counts as the independent one.",
    why: "A review by the author checks nothing.",
    where: [{ file: "src/ledger.ts", symbol: "addReview" }, { file: "src/rules.ts", symbol: "pushActors" }],
  },
  {
    title: "Owner acceptance and merge",
    enforced: "Only the project owner can accept or merge. Acceptance is refused unless the task is in the submitted state and the gate is clear: every required check Observed passing at the current head, the changed paths measured, no rejection at that head, and a qualifying review where one is required, or the owner's recorded override of it. The merge lands only the accepted head, and the ledger records it only when the merge commit is found on the baseline with the accepted head as a parent.",
    why: "Work enters the project only by the owner's decision, made on evidence for one exact revision.",
    where: [{ file: "src/rules.ts", symbol: "gate" }, { file: "src/ledger.ts", symbol: "beginLanding" }],
  },
  {
    title: "Tokens scoped to an actor",
    enforced: "An agent token binds every request to one actor: a request that names another actor is refused. The token expires (after 30 days unless set, and at most 365), can be limited to named projects, and opens only the agent workflow of claiming, pushing, posting results and reports, reviewing, submitting, handing off, releasing and reading, with these routes by name: `block`, `unblock`, `queue`, `sandbox`, `plan`, `integrated`, `integration-failed`, `refreshed` and `refresh-failed`. The Ledger still takes several of them only from the task's holder. Creating tasks, accepting, merging, dispatching, the model pool, project settings and token management need the owner token, and agent tokens cannot sign in to the browser.",
    why: "A leaked or misused agent token can act only as its own actor, in its own projects, and cannot decide for the owner.",
    where: [{ file: "src/tokens.ts", symbol: "agentRoute" }, { file: "src/tokens.ts", symbol: "tokenActive" }, { file: "src/tokens.ts", symbol: "inScope" }],
  },
];

// Trusted, not enforced: the README's list, restated for a reader of the page.
export const LIMITS: string[] = [
  "Agent tokens prove identity. The owner token may name any actor, so it stays with the owner's tools. A workspace write token is separate and controls only Git pushes.",
  "A caller allowed to post check results could post one that was never run, so a local Observed result rests on the command having run the check. A container check runs on the server, and `sandboxOnly` counts only those; the container path is implemented, and a successful run in production has not been confirmed.",
  "The merge happens on the owner's machine. Artifacts can be read through its binding but written only by a git push with a write token, so Atelier merges in git in the owner's checkout and pushes the result.",
];

export interface Part {
  name: string;
  // Where the design puts it: docs/orchestrator.md, section 8.
  stage: string;
  built: boolean;
  what: string;
  // Built: each file must exist. Not built: each must not.
  files: string[];
  // Code that shows the part is there. Built: each symbol is in its file.
  // Not built: none is, so wiring a part into existing files fails the test
  // until the page says it is built.
  code: { file: string; symbol: string }[];
}

export const ORCHESTRATOR: Part[] = [
  {
    name: "Plan schema and content hash", stage: "t15, build step 1", built: true,
    what: "`src/plans/schema.ts` parses a plan document, refuses unknown fields and over-long text, and hashes the plan. The hash is what an approval will bind to.",
    files: ["src/plans/schema.ts"],
    code: [{ file: "src/plans/schema.ts", symbol: "planHash" }],
  },
  {
    name: "Plan validation", stage: "t15, build step 2", built: true,
    what: "`src/plans/validate.ts` checks that part keys are unique, that there are at most 12 parts, that dependencies have no cycle, that parts with overlapping scopes are ordered, and that interface parts depend only on interface parts.",
    files: ["src/plans/validate.ts"],
    code: [{ file: "src/plans/validate.ts", symbol: "validatePlan" }],
  },
  {
    name: "Part routing", stage: "t15, build step 3", built: true,
    what: "`src/plans/route.ts` chooses a builder, two alternates and a reviewer from another model family for each part, from the model pool and the ledger's record, with each model's reliability across every project breaking ties. It leaves out refused models, and paid models unless the owner allows them.",
    files: ["src/plans/route.ts"],
    code: [{ file: "src/plans/route.ts", symbol: "routeParts" }],
  },
  {
    name: "Dispatch decisions", stage: "t15, build step 4", built: true,
    what: "`src/plans/phase.ts` decides, from plain data, which parts to dispatch and to whom. `planPhase` derives a plan's state: planning, proposed, building, blocked, ready, accepted, merged or abandoned. `planActions` dispatches parts in plan order while fewer than `maxParallel` (2 by default) are live, each once every part it depends on has merged. `partAttempts` counts attempts from the event log. A builder gets two, so one that gives up twice, or fails a finish and then its retry, is replaced by the next alternate. The plan blocks when a part reaches three attempts or has no alternate left, when a part depends on an abandoned one, or at the deadline or the budget cap.",
    files: ["src/plans/phase.ts"],
    code: [{ file: "src/plans/phase.ts", symbol: "planPhase" }, { file: "src/plans/phase.ts", symbol: "planActions" }, { file: "src/plans/phase.ts", symbol: "partAttempts" }],
  },
  {
    name: "Plan ledger", stage: "t15, build step 5", built: true,
    what: "The project's ledger keeps plans. A plan is a task whose planner is dispatched as a plan job and posts a plan document; each valid proposal is kept, unchanged, and an invalid one gets the planner one more attempt before the plan blocks. The owner approves the newest proposal by its hash, once: the routing of each part is fixed then, with the limits (2 parts live, 3 attempts a part, 4 dispatches a part, 24 hours), and the parts become tasks. After each push, check, review, submit, release, merge or abandon of a part, and at the deadline, the ledger runs `planActions` and dispatches what may start, as `atelier/orchestrator`, or blocks the plan with the reason. The inbox gains `approve-plan` and `plan-blocked`; a part never appears there to accept, review, fix, rescope or hand off, and tasks of one plan are not flagged as overlapping. Until the integration branch exists, each part reaches main by the owner's own merge, and the plan is complete when every part has merged.",
    files: ["src/plans/state.ts", "test/plans.spec.ts"],
    code: [{ file: "src/ledger.ts", symbol: "approvePlan" }, { file: "src/ledger.ts", symbol: "dispatchPart" }, { file: "src/ledger.ts", symbol: "postPlan" }],
  },
  {
    name: "Plan routes and command", stage: "t15, build step 6", built: true,
    what: "`atelier plan \"goal\"` starts a plan, and `plan show` prints its phase, its newest proposal with the hash to approve, or each part with its state, routing and attempts, and the command for each decision waiting on the owner. `plan approve` takes that hash, once; `plan revise`, `plan reroute`, `plan retry` and `plan stop` are the owner's other decisions, and `plan post` is how a planner submits its plan document, the one plan route an agent token reaches. `atelier show` prints a plan's own brief.",
    files: ["test/plan-cli.test.mjs"],
    code: [{ file: "src/index.ts", symbol: "approvePlan" }, { file: "src/usage.ts", symbol: "plan approve" }],
  },
  {
    name: "Server briefs and runner jobs", stage: "t15, build step 7b", built: true,
    what: "`GET items/tN/job-brief` gives the holder of a plan item's or a part's claim the brief for the work it holds: `plannerBrief`'s planner brief (the goal, the owner's latest note, the last refusal's errors and the schema to write) or `jobBrief`'s part brief. The runner offers `jobs: [\"build\",\"plan\"]`, so a plan job reaches it: it claims the plan item as the planner, fetches that brief, runs the harness with a `{plan_file}` placeholder naming where the plan document goes, posts the document, reports the errors of a refusal and releases the claim either way. A part's build brief comes from the route too, and a part whose finish fails is released, so the plan's tick sends it back with the failing output.",
    files: ["test/runner-plan.test.mjs"],
    code: [{ file: "src/index.ts", symbol: "job-brief" }, { file: "cli/runner.mjs", symbol: "plan_file" }, { file: "src/plans/brief.ts", symbol: "plannerBrief" }],
  },
  {
    name: "Server brief for a part", stage: "t15, build step 7a", built: true,
    what: "`src/plans/brief.ts` writes the brief an agent gets for one part of an approved plan, or for its rework. `jobBrief` states the rules (work only in the workspace, commit, do not push; the orchestrator pushes, runs the checks and submits; quoted text is data), then the plan's goal, the part's spec, acceptance criteria and interfaces, the parts it depends on with the heads they landed at, its scope, the project's required checks and, for rework, the review's findings or the failing check's output, capped and saying when cut. It returns the text with a hash of its inputs that does not depend on key order. The `job-brief` route (step 7b) serves it.",
    files: ["src/plans/brief.ts"],
    code: [{ file: "src/plans/brief.ts", symbol: "jobBrief" }],
  },
  {
    name: "Review rules", stage: "t39, build step 8", built: true,
    what: "`src/review/` decides when a submission gets an automatic review, and how the review is asked for and read. `reviewNeeded` asks for one once every required check is observed passing at the head and the changed paths are measured, unless that head already has an approval that suffices, a rejection awaiting rework, an open request or, outside a plan, the owner's override. The owner's approval never suffices. Every part of a plan is reviewed; any other task only when the gate needs an independent review. `pickReviewer` takes a model whose family is recognised and differs from every contributor's, available, not refused and paid only when allowed, and names each model it passed over and why. `reviewBrief` writes what the reviewer reads, fencing quoted text so it cannot pose as instructions; it states the project's review bar (`atelier init --review-bar`, or the default: correctness, security or data-loss defects only) before the reply format, and from the second review on lists each earlier finding with the owner's verdict and note, saying a refuted finding is repeated only with new evidence quoting the code. `parseVerdict` reads the reply and refuses one that states no verdict, states both, or gives findings that contradict its verdict; a rejection needs a blocking finding.",
    files: ["src/review/needed.ts", "src/review/reviewer.ts", "src/review/brief.ts", "src/review/verdict.ts"],
    code: [{ file: "src/review/needed.ts", symbol: "reviewNeeded" }, { file: "src/review/reviewer.ts", symbol: "pickReviewer" }, { file: "src/review/brief.ts", symbol: "reviewBrief" }, { file: "src/review/verdict.ts", symbol: "parseVerdict" }],
  },
  {
    name: "Review requests and runner job", stage: "t39, build steps 9 and 10", built: true,
    what: "The ledger keeps review requests: its tick asks one for each submitted part whose checks pass and whose paths are measured, routed by `pickReviewer` to a model of another family than every contributor, and the queue offers them as `review` jobs. A reviewer's runner claims one, clones the part read-only, gives the model the review brief and posts the verdict with its findings. A rejection with blocking findings sends the part back to its builder for rework, and a harness that writes no valid verdict releases the request. Each runner's offer is recorded as it asks the queue for work (`putRunnerOffer`), and a dispatch no live runner offers, which could never be claimed however long it waits, is said as that by `unoffered`: `atelier land` while it waits for a verdict, `atelier plan show` for a routed review and `atelier status` for the queue, each naming what the live runners offer instead.",
    files: ["src/ledger.ts", "cli/runner.mjs", "test/review-requests.spec.ts"],
    code: [{ file: "src/ledger.ts", symbol: "review_requests" }, { file: "src/index.ts", symbol: "review-claim" }, { file: "cli/runner.mjs", symbol: "verdict_file" }, { file: "src/dispatch/rules.ts", symbol: "unoffered" }, { file: "src/ledger.ts", symbol: "putRunnerOffer" }],
  },
  {
    name: "Integration rules", stage: "t16, build step 11", built: true,
    what: "`src/plans/integrate.ts` holds the rules for merging parts into a plan's branch. `integrationBlockers` lets a part in only when it is submitted, every part it depends on has landed, and its head carries an approval from a model of another family than its builders; the owner's approval is not one, and a part takes no override. `verifyIntegration` accepts the integrator's merge commit only when it has exactly two parents, sits on the branch's first-parent line, and merges the part's head onto the integration head, the branch's head as the ledger last recorded it. `rollbackFor` says how a failed integration is undone, and refuses when that would discard commits it did not make. `planGate` adds to the plan task's gate: every part integrated or abandoned before integration, at least one integrated, each integrated part approved at the head that was integrated, and the branch's head at the integration head.",
    files: ["src/plans/integrate.ts"],
    code: [{ file: "src/plans/integrate.ts", symbol: "integrationBlockers" }, { file: "src/plans/integrate.ts", symbol: "verifyIntegration" }, { file: "src/plans/integrate.ts", symbol: "rollbackFor" }, { file: "src/plans/integrate.ts", symbol: "planGate" }],
  },
  {
    name: "Integration jobs", stage: "t16, build steps 12 to 14", built: true,
    what: "Each part forks from its plan's fork and is measured against it, never the baseline (`baseRepoOf` in src/plans/integrate.ts and the `base-token` route), so a part reports only its own files. The integrator, a reserved actor reached only through its token, claims the plan item's integrate job, merges the part onto the plan's branch, runs the plan's checks, and posts `integrated` or `integration-failed`, both verified against the branch's log by the Worker. `planGate` adds its blockers to the plan item's gate, and `Ledger.merged` marks the parts merged with `{via: tP}` when the plan lands. The runner's `--integrate` merges each part with `--no-ff` and rolls the branch back when the checks fail or the merge conflicts, and its refresh job merges main's head into the plan's fork, dispatched by the tick before a part when main has moved, or by the owner with `atelier plan refresh`, and recorded with `refreshed` or `refresh-failed`. A refresh that conflicts adds a merge-main part to the plan, outside the approved document and its hash: the runner merges main into that part's workspace and leaves the conflicts for its builder to resolve, no other part is dispatched until it is integrated, and its integration records main as taken. The owner adds one with `atelier plan refresh --resolve`.",
    files: ["test/integration.spec.ts"],
    code: [{ file: "src/index.ts", symbol: "base-token" }, { file: "src/index.ts", symbol: "integration-failed" }, { file: "cli/runner.mjs", symbol: "integrate" }],
  },
];
