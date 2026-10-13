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

// The life of a task in five verbs, the words the app, the README, the docs
// and the video share. They are labels only: the commands keep their names
// (`start`, `push`, `check`, `review`, `land`, `merge`).
export type Verb = "Claim" | "Fork" | "Prove" | "Review" | "Land";

export interface Verbed {
  verb: Verb;
  // The step in a few words, as the video says it.
  line: string;
  // What the step means here, in a sentence or two.
  about: string;
}

export const STEPS: Verbed[] = [
  { verb: "Claim", line: "One holder per task.", about: "An agent claims an open task with `atelier start`. The project's Durable Object grants it atomically, so a second claimant is refused." },
  { verb: "Fork", line: "Every task its own fork.", about: "The claim forks the baseline into a workspace for that task alone, with one write token for its holder. The agent commits and pushes there, never to the project." },
  { verb: "Prove", line: "The checks run on the exact head.", about: "`atelier check` runs the required checks on a clean clone of exactly the head Atelier reads from Artifacts, on the machine that asks or, with `--sandbox`, in a Cloudflare container, and only those Observed results count; what an agent says it ran is shown and never counted." },
  { verb: "Review", line: "Another company reviews, or in single-family mode another model.", about: "A change to a protected path needs an approval from a model of another family than every contributor by default; a project set to single-family mode takes a different model of its one company from every contributor, and says so wherever the review shows. No agent reviews its own work." },
  { verb: "Land", line: "One merge at a time, with a receipt.", about: "The developer accepts one exact head through the gate and it merges, one merge per project at a time under the landing lease, with the task's record attached as a git note." },
];

// Where a page sums the five steps up, it says these three words.
export const TAKEAWAYS = "Proven. Reviewed. Recorded.";
export const TAGLINE = "Git keeps the code. Atelier brings the receipts.";

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
    detail: "The developer creates the task with `atelier new \"title\" --scope 'src/**'`. The scope is the paths the task intends to touch. Overlapping live scopes are flagged in the inbox, and a project whose policy says so refuses a claim that overlaps another. A project that names core files holds a dispatch in the queue while its scope overlaps, within one, the scope of a claimed item or of the item a live landing lease names.",
  },
  {
    name: "Claim", lane: "agent", command: "start", moves: "a claim",
    records: ["One holder, set", "atomically; a", "second claim", "is refused"],
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
    detail: "`atelier check` clones the workspace afresh at that head on the machine that runs it, runs each required check and posts each result. Atelier records a result as Observed only when it names the head Atelier reads from Artifacts, with the paths the change touches, which the Worker measures itself. `--sandbox` runs the checks in a Cloudflare container instead. `--merged` runs them on the would-be merge, the head merged with main as it is now, and the result stands beside the merge preview, bound to both revisions. `atelier report` adds a Reported claim. `atelier submit` marks the task ready, and `atelier done \"summary\"` runs push, check and submit in order.",
  },
  {
    name: "Review", lane: "reviewer", command: "review", moves: "a review", conditional: true,
    records: ["Verdict at that", "head; it counts", "if the reviewer", "is independent"],
    detail: "A reviewer, an agent that did not work on the task, reads the change with `atelier diff t3` and records `atelier review t3 --approve`, or `--reject --note \"…\"`. A review is required when the change touches a protected path and, under a ControlPlane policy, when it is a coordinated change; Independent review of protected paths says whose approval counts. The developer may review too, and their rejection blocks, but their approval is never the required review.",
  },
  {
    name: "Accept", lane: "owner", command: "accept", moves: "an acceptance",
    records: ["Head pinned; the", "gate must be", "clear first"],
    detail: "The developer accepts with `atelier accept t3` or the Accept button. The gate, set out under Developer acceptance and merge, must be clear. Acceptance pins the head. When a required review is all that is missing and no reviewer qualifies, the developer accepts with `atelier accept t3 --override-review \"reason\"` instead, which records an override with its reason, not a review, and is taken only once they have allowed it on the task's page within the last 15 minutes, confirming there with the Cloudflare Access sign-in or the server's confirmation secret, never the developer token or the session it signs in.",
  },
  {
    name: "Merge", lane: "owner", command: "merge", moves: "a merge commit",
    records: ["Merge commit", "found on the", "baseline"],
    detail: "In the project checkout the developer runs `atelier merge t3`. It fetches exactly the accepted head, merges it with `--no-ff`, attaches the task's provenance as a git note on `refs/notes/atelier`, and pushes the project's branch to the baseline. Pushing to the project's own remotes and deploying remain separate decisions.",
  },
];

export const LOOP_RETURN = "a later push moves the head: back to step 4";

export const LOOP_CAPTION = "The loop from task to merge. The developer, an agent and a reviewer act in the three upper lanes. Each step sends one thing to Atelier, named on its arrow, and the lowest lane shows what Atelier records. The review is dashed because only some changes require one. A push after step 4 moves the head, so checks, reviews and acceptance start again.";

export const LOOP_LABEL = "The loop from task to merge in seven steps across four lanes. The developer creates a task. An agent claims it, pushes work to its own fork, and runs checks that Atelier records as Observed at that head. A reviewer reviews when the change requires it. The developer accepts the exact head and merges it, and Atelier records the merge commit found on the baseline. A later push returns the task to the checks.";

export interface Term { term: string; meaning: string }

export const TERMS: Term[] = [
  { term: "Task", meaning: "One piece of work: a title, a scope of the paths it intends to touch and, once claimed, a holder. The API reference calls it an item." },
  { term: "Baseline", meaning: "Atelier's copy of the project's branch, the one `atelier init` registered (often `main`), held in an Artifacts repository." },
  { term: "Workspace", meaning: "A task's own fork of the baseline, also an Artifacts repository. Only the task's holder has a write token for it." },
  { term: "Head", meaning: "The latest commit in a workspace. Results, reviews and acceptance each name the head they apply to." },
  { term: "Observed", meaning: "A required check's result, recorded against the head Atelier read from Artifacts, from a run on a clean clone of that head, on the machine that ran it or in a Cloudflare container." },
  { term: "Reported", meaning: "A statement an agent made about its own work. It is shown and never counted." },
  { term: "Pending", meaning: "A required check with no Observed result at the current head." },
  { term: "Gate", meaning: "The function that decides whether a task can be accepted and lists what still blocks it: `gate` in `src/rules.ts`." },
  { term: "Protected path", meaning: "A path whose change needs an independent review. The project lists some; Atelier adds the files its required checks execute." },
];

export interface Rule {
  title: string;
  // The step of the five it guards; /how lists the rules under it.
  verb: Verb;
  // What the code does.
  enforced: string;
  // Why, in one sentence.
  why: string;
  // Where it is enforced; the test finds each symbol in its file.
  where: { file: string; symbol: string }[];
}

export const RULES: Rule[] = [
  {
    title: "One holder per task", verb: "Claim",
    enforced: "A task has at most one holder. The project's Durable Object handles one request at a time, so when two agents claim a task the second is refused. The holder changes only through a recorded event: a claim, a handoff, a release, an abandonment or a merge.",
    why: "Two agents writing to one workspace overwrite each other, and nobody could say afterwards who did what.",
    where: [{ file: "src/rules.ts", symbol: "assertClaimable" }, { file: "src/rules.ts", symbol: "assertOwner" }],
  },
  {
    title: "Separate forks for agents", verb: "Fork",
    enforced: "A claim forks the baseline into a repository for that task, and the claimant's write token covers that repository alone. Only the developer token can obtain a write token for the baseline; an agent token is refused.",
    why: "A wrong or abandoned change in one workspace cannot touch the baseline or another task's work.",
    where: [{ file: "src/tokens.ts", symbol: "agentRoute" }],
  },
  {
    title: "One write token per workspace", verb: "Fork",
    enforced: "A claim revokes the workspace's earlier write token before it mints a new one, so only one is live. The token lasts eight hours, and a handoff, a release or an abandonment revokes it.",
    why: "An agent that has handed work on or given it up must not be able to keep pushing to it.",
    where: [{ file: "src/index.ts", symbol: "revoke" }],
  },
  {
    title: "Observed evidence only", verb: "Prove",
    enforced: "`atelier check` runs each required check on a clean clone of the head Artifacts holds, on the caller's machine or, with `--sandbox`, in a Cloudflare container, and posts the result as a check. Atelier refuses a result that names any head but the one it reads from Artifacts, and measures the paths the change touches itself; the pass or fail of a local run is the word of the machine that ran it. The Worker stores a check as Observed and a report as Reported, and the gate counts Observed results only. A required check with no Observed result at the head is Pending and blocks acceptance. Under `sandboxOnly`, only results from a Cloudflare container count. A check run with `--merged`, on the head's merge with main as it is now, is recorded against both revisions and never counts as the head's own check; it blocks acceptance only when it fails after main moved past the head the passing checks were recorded against.",
    why: "An agent's own statement that its tests pass is not evidence; the developer needs results taken from a clean clone of the head, though only a container result is produced by Atelier itself, and a local Observed result is posted by the machine that ran it, so a project that wants results no agent can forge requires the container with `atelier init --sandbox-only`.",
    where: [{ file: "src/rules.ts", symbol: "evidenceAt" }, { file: "src/rules.ts", symbol: "gate" }, { file: "src/rules.ts", symbol: "mergedBlockers" }],
  },
  {
    title: "Evidence bound to a head", verb: "Prove",
    enforced: "A result, a review and an acceptance each name the head they apply to. Atelier refuses a result or a review for any head but the task's current one, reads the head from Artifacts instead of taking the agent's word for it, and withdraws acceptance when a push moves the head.",
    why: "An approval of one revision must not authorise another, and a pass at one revision says nothing about the next.",
    where: [{ file: "src/rules.ts", symbol: "assertRevision" }, { file: "src/ledger.ts", symbol: "recordPush" }],
  },
  {
    title: "Independent review of protected paths", verb: "Review",
    enforced: "By default, a change that touches a protected path needs an approving review from a model of another family than every model that contributed to the task, in every project, with or without a ControlPlane policy. The family is read from the model's name, and under the default rule a family Atelier does not recognise never qualifies, in a reviewer or in a contributor. The developer's approval is not this review; they accept and merge. Nor is a tier review's approval: a project's review tier reviews beside this review, and its rejection blocks like any other. When no reviewer qualifies, the developer can override the review while accepting, giving a reason: the override is recorded as an event of its own, never as a review, counts only at that head, and the task page and the inbox show it with its reason. An override needs the developer's confirmation. From the command line, the developer's recorded direction suffices (the developer's decision of 2026-10-13): `atelier accept --override-review REASON --quote WORDS --as H/M` overrides with the developer token, and the words and the acting model are recorded with the override and shown on the task page, in `atelier status` and in the landing receipt, so every override says who asked and why. Without the words, the developer token alone, which an agent session may hold, does not override, nor does the browser session that token signs in: the task page's override form carries a factor no agent holds, their Cloudflare Access identity where the pages are behind Access, else the server's confirmation secret (OVERRIDE_SECRET), typed into the form and never given to a session, and `atelier accept --override-review` without `--quote` is taken only within 15 minutes of the developer pressing Allow an override from the command line on that page with that factor, once per permission. Each project page and `atelier status` count the merges that went in by override and link each. A project set up with `atelier init --no-override` refuses every override, and counts none recorded before the setting. The protected paths are those the project lists (by default `AGENTS.md`, `CLAUDE.md`, `wrangler.*` and `.atelier/prompts/**`, the role prompts) and what a required check executes: the scripts it runs, the recipe files of make and just, the manifest and configuration a package manager or build tool runs scripts from, and the local binary npx would run. Under a ControlPlane policy a coordinated change, one that is neither protected nor direct, needs a review from a model different from every contributor's, under any harness name, and the developer's approval is not that review either. A project may opt out of the cross-company rule with `atelier init --single-family COMPANY`: building and reviewing then use that company's models alone, routing, dispatch and the landing pick no other, and a review counts when the reviewer is a different model of the company from every contributor; a model never counts as reviewer of a change it contributed to, in either mode, and `--no-override` refuses overrides in either mode. Fast mode, in which the developer lands tasks without the gate, is held to the same: `atelier mode fast` needs the developer's direction (`--quote` with the acting model, both recorded) or their permission from the project's Settings page, given with the same factor and good for 15 minutes and one switch, and a project that forbids overrides refuses fast mode and every fast landing. The mode is shown on the project page, in `atelier status`, in every review brief and in each merge's provenance note, so nobody takes such a review for a cross-company one, and `atelier init --cross-family` returns to the default; either switch is recorded with who made it and when. Independence is enforced against agents, whose tokens are bound to their own actor; the developer token can name any actor, so a review it records in a model's name counts as that model's (for a protected change, only when it answers a review request that model claimed for that head), and the developer who holds it is trusted.",
    why: "The model that wrote a change to the files that instruct agents or grade their work must not approve it, and nor should a model of its family, which is likely to share its blind spots; where a client allows one company's models alone, a different model of that company is the most independence there is, and the mode is named everywhere so nobody mistakes it for the stronger rule.",
    where: [{ file: "src/rules.ts", symbol: "changeClass" }, { file: "src/rules.ts", symbol: "checkFiles" }, { file: "src/rules.ts", symbol: "independentApproval" }, { file: "src/rules.ts", symbol: "reviewOverrideFor" }],
  },
  {
    title: "No self-review", verb: "Review",
    enforced: "The task's current holder cannot record a review of it. Everyone who has held the task or pushed to its workspace stays a contributor, so a review by any of them never counts as the independent one. This binds agents; the developer token can act for anyone.",
    why: "A review by the author checks nothing.",
    where: [{ file: "src/ledger.ts", symbol: "addReview" }, { file: "src/rules.ts", symbol: "pushActors" }],
  },
  {
    title: "Developer acceptance and merge", verb: "Land",
    enforced: "Only the developer can accept or merge. Acceptance is refused unless the task is in the submitted state and the gate is clear: every required check Observed passing at the current head, the changed paths measured, no rejection at that head, and a qualifying review where one is required, or the developer's recorded override of it. The merge lands only the accepted head, and the ledger records it only when the merge commit is found on the baseline with the accepted head as a parent.",
    why: "Work enters the project only by the developer's decision, made on evidence for one exact revision.",
    where: [{ file: "src/rules.ts", symbol: "gate" }, { file: "src/ledger.ts", symbol: "beginLanding" }],
  },
  {
    title: "Tokens scoped to an actor", verb: "Claim",
    enforced: "An agent token binds every request to one actor: a request that names another actor is refused. The token expires (after 30 days unless set, and at most 365), can be limited to named projects, and opens only the agent workflow of claiming, pushing, posting results and reports, reviewing, submitting, handing off, releasing and reading, with these routes by name: `block`, `unblock`, `queue`, `sandbox`, `plan`, `integrated`, `integration-failed`, `refreshed`, `refresh-failed`, `refresh-lease`, `refresh-pushing` and `refresh-checked`. The Ledger still takes several of them only from the task's holder. Creating tasks, accepting, merging, dispatching, the model pool, project settings and token management need the developer token, and agent tokens cannot sign in to the browser.",
    why: "A leaked or misused agent token can act only as its own actor, in its own projects, and cannot decide for the developer.",
    where: [{ file: "src/tokens.ts", symbol: "agentRoute" }, { file: "src/tokens.ts", symbol: "tokenActive" }, { file: "src/tokens.ts", symbol: "inScope" }],
  },
  {
    title: "Waiting work stays merged with main", verb: "Land",
    enforced: "When main advances, every unfinished task outside a plan with commits of its own (open after a release, submitted or accepted) is queued to take main's new head, one target per task, a newer head replacing an older one and the same head again changing nothing; a task with no commits of its own starts from main when claimed, and a finished one is dropped. A refresh waits, saying why, while a builder holds the task, it is blocked, a runner is about to rebuild it, a review of its head is under way, or it is landing. The integrator merges in a workspace of its own under a lease naming the head it found, says before it pushes (no landing begins meanwhile), pushes without force, and the Worker verifies the merge on the fork: its head, with that head and main's as its parents, and an Agent line naming who made it. The task's head moves as a push would move it; an acceptance never carries to the new head, which needs its checks and review again. A conflict whose every hunk is one of the documented mechanical transformations goes to a configured frontier resolver of another family than every reviewer whose approval stands, recorded among the contributors, and the runner verifies its files against the transformations before it commits; with none eligible the refresh waits, saying why. Any other conflict goes back to the builder with the merge base, both heads, the paths and the hunks, and so, before any merge, does an edit the task made in code main moved to another file, which Git would merge cleanly into the file left behind. A refresh never claims, accepts or lands the task.",
    why: "A task that waits for review or landing would otherwise meet every conflict main made meanwhile at its landing, where it stops the queue.",
    where: [{ file: "src/refresh/standing.ts", symbol: "refreshStanding" }, { file: "src/refresh/queue.ts", symbol: "enqueue" }, { file: "src/refresh/mechanical.ts", symbol: "TRANSFORMATIONS" }, { file: "src/refresh/resolver.ts", symbol: "pickResolver" }, { file: "src/ledger.ts", symbol: "taskRefreshed" }, { file: "cli/task-refresh.mjs", symbol: "runTaskRefresh" }, { file: "src/moved-code.ts", symbol: "detectMovedEditsAsync" }],
  },
  {
    title: "Core files are built one change at a time", verb: "Land",
    enforced: "A project's policy may name core files (`atelier init --core GLOB`). While a queued dispatch's scope overlaps, within a core file, the scope of a claimed item or of the item named by a live landing lease (unexpired, its item not yet merged or abandoned), the queue offers it to no runner and the developer's listing names every item it waits on. A submitted or accepted item that is not landing holds nothing. The dispatch is offered once each claimed blocker submits or is released and each landing ends. Items of one plan never hold each other, since the plan orders overlapping parts by their dependencies; a claimed plan item holds nothing, and the plan, integrate, refresh and review jobs are never held. The developer lets one task's dispatch through with `atelier dispatch ID --overlap-ok`. With no core files, nothing is held.",
    why: "Tasks built at once on the same hot files stop each other's landings on merge conflicts.",
    where: [{ file: "src/dispatch/rules.ts", symbol: "coreBlockers" }, { file: "src/ledger.ts", symbol: "waiting" }],
  },
];

// Trusted, not enforced: the README's list, restated for a reader of the page.
export const LIMITS: string[] = [
  "Agent tokens prove identity. The developer token may name any actor, a reviewer included: a review it records in a model's name counts as that model's (for a protected change, only when it answers a review request that model claimed for that head), so independence of review holds against agents, not against whoever holds that token, which stays with the developer's tools. A workspace write token is separate and controls only Git pushes.",
  "A local check runs on the caller's machine, which posts its pass or fail. Atelier verifies the head and measures the changed paths, but a caller allowed to post check results, the task's own agent included, could post a pass that was never run, so a local Observed result rests on the command having run the check. A container check runs on the server, and `sandboxOnly` counts only those; the container path is implemented, and a successful run in production has not been confirmed.",
  "The merge happens on the developer's machine. Artifacts can be read through its binding but written only by a git push with a write token, so Atelier merges in git in the developer's checkout and pushes the result.",
];

// The owner's guide, docs/using-atelier.md, in fewer words. Each point
// carries a phrase or command that appears verbatim both in the point and in
// the guide, so test/how.test.ts fails when the two drift apart.
export const USING_WELL_DOC = "docs/using-atelier.md";

export interface Advice {
  point: string;
  // Found verbatim in the point and in USING_WELL_DOC.
  from: string;
}

export const USING_WELL: Advice[] = [
  { from: "atelier status", point: "Start with `atelier status`. It lists, for every project, what needs the developer: a plan to approve, work to accept, failing checks, a change outside its scope. When nothing waits, there is nothing to do." },
  { from: "what should be true afterwards", point: "Something with several parts becomes a plan, `atelier plan \"goal\"`; one clear change becomes a task, `atelier new \"title\"`. A good goal or title says what should be true afterwards, names the files it may touch, and asks that every claim match the code." },
  { from: "Keep scopes narrow", point: "Keep scopes narrow. Two live tasks whose scopes overlap usually conflict when the second lands, and `atelier status` lists such pairs." },
  { from: "atelier plan show", point: "Read a plan before approving it, with `atelier plan show`: the parts sensible and ordered, each routed to a model you want doing it, nothing contradicting what you asked. Then approve once, by the hash of its newest proposal." },
  { from: "never overridden quietly", point: "Accept deliberately. Look at the gate, the reviewer's findings and the scope flag. A finding is a claim about the code and can be wrong: have a wrong one answered with the file and line that show it, never overridden quietly." },
  { from: "`atelier land` never overrides a review", point: "Land one task with `atelier land ID --reviewer H/M`, which merges main, checks, submits, waits for the independent review, then accepts and merges. `atelier land` never overrides a review; an override while accepting takes a reason and is recorded where everyone can see it." },
  { from: "file anything odd as a task", point: "Let a session act for you. Say a standing decision plainly, so it is recorded in the skill's `decisions.md` and every later session follows it, and ask it to file anything odd as a task rather than work around it quietly." },
  { from: "Watch three numbers", point: "Watch three numbers: spend on pay-per-use models against the daily limit, the plan windows of the subscription tools, and each model's record on the Models page when choosing who builds." },
  { from: "ask what task it becomes", point: "Run one home runner per machine, deploy between landings, and do not edit inside an agent's workspace while its agent runs. When something breaks, ask what task it becomes, not only how to get past it." },
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
    what: "`src/plans/route.ts` chooses a builder, two alternates and a reviewer for each part. By default the reviewer is from another model family; in single-family mode all picks belong to the selected company and the reviewer is a different model from every contributor. Picks come from the model pool and the ledger's record, with each model's reliability across every project breaking ties. It leaves out refused models, and paid models unless the developer allows them. A model no live runner offers cannot build or review at all, since no runner could claim its dispatch (`offeredActors` in `src/dispatch/rules.ts`), and a reviewer is routed besides only to a model a live runner offers for the review job (`offering` in `src/dispatch/rules.ts`, which counts a model only when a runner that offers the job lists it, so a model only a build runner offers never reviews, the t210 case of 2026-10-07); when no runner is live the pool stands and the routing says so with a warning.",
    files: ["src/plans/route.ts"],
    code: [{ file: "src/plans/route.ts", symbol: "routeParts" }, { file: "src/dispatch/rules.ts", symbol: "offering" }],
  },
  {
    name: "Dispatch decisions", stage: "t15, build step 4", built: true,
    what: "`src/plans/phase.ts` decides, from plain data, which parts to dispatch and to whom. `planPhase` derives a plan's state: planning, proposed, building, blocked, ready, accepted, merged or abandoned. `planActions` dispatches parts in plan order while fewer than `maxParallel` (2 by default) are live, each once every part it depends on has merged. `partAttempts` counts attempts from the event log. A builder gets two, so one that gives up twice, or fails a finish and then its retry, is replaced by the next alternate. The plan blocks when a part reaches three attempts or has no alternate left, when a part depends on an abandoned one, or at the deadline or the budget cap.",
    files: ["src/plans/phase.ts"],
    code: [{ file: "src/plans/phase.ts", symbol: "planPhase" }, { file: "src/plans/phase.ts", symbol: "planActions" }, { file: "src/plans/phase.ts", symbol: "partAttempts" }],
  },
  {
    name: "Plan ledger", stage: "t15, build step 5", built: true,
    what: "The project's ledger keeps plans. A plan is a task whose planner is dispatched as a plan job and posts a plan document; each valid proposal is kept, unchanged, and an invalid one gets the planner one more attempt before the plan blocks. The developer approves the newest proposal by its hash, once: the routing of each part is fixed then, with the limits (2 parts live, 3 attempts a part, 4 dispatches a part, 24 hours), and the parts become tasks. After each push, check, review, submit, release, merge or abandon of a part, and at the deadline, the ledger runs `planActions` and dispatches what may start, as `atelier/orchestrator`, or blocks the plan with the reason. The inbox gains `approve-plan` and `plan-blocked`; a part never appears there to accept, review, fix, rescope or hand off, and tasks of one plan are not flagged as overlapping. Each part reaches main through the plan's integration branch, and the plan is complete when every part has merged or been abandoned, with at least one merged.",
    files: ["src/plans/state.ts", "test/plans.spec.ts"],
    code: [{ file: "src/ledger.ts", symbol: "approvePlan" }, { file: "src/ledger.ts", symbol: "dispatchPart" }, { file: "src/ledger.ts", symbol: "postPlan" }],
  },
  {
    name: "Plan routes and command", stage: "t15, build step 6", built: true,
    what: "`atelier plan \"goal\"` starts a plan, and `plan show` prints its phase, its newest proposal with the hash to approve, or each part with its state, routing and attempts, and the command for each decision waiting on the developer. `plan approve` takes that hash, once; `plan revise`, `plan reroute`, `plan retry` and `plan stop` are the developer's other decisions, and `plan post` is how a planner submits its plan document, the one plan route an agent token reaches. `atelier show` prints a plan's own brief.",
    files: ["test/plan-cli.test.mjs"],
    code: [{ file: "src/index.ts", symbol: "approvePlan" }, { file: "src/usage.ts", symbol: "plan approve" }],
  },
  {
    name: "Server briefs and runner jobs", stage: "t15, build step 7b", built: true,
    what: "`GET items/tN/job-brief` gives the holder of a plan item's or a part's claim the brief for the work it holds: `plannerBrief`'s planner brief (the goal, the developer's latest note, the last refusal's errors and the schema to write) or `jobBrief`'s part brief. The runner offers `jobs: [\"build\",\"plan\"]`, so a plan job reaches it: it claims the plan item as the planner, fetches that brief, runs the harness with a `{plan_file}` placeholder naming where the plan document goes, posts the document, reports the errors of a refusal and releases the claim either way. A part's build brief comes from the route too, and a part whose finish fails is released, so the plan's tick sends it back with the failing output.",
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
    what: "`src/review/` decides when a submission gets an automatic review, and how the review is asked for and read. `reviewNeeded` asks for one once every required check is observed passing at the head and the changed paths are measured, unless that head already has an approval that suffices, a rejection awaiting rework, an open request or, outside a plan, the developer's override. The developer's approval never suffices. Every part of a plan is reviewed; any other task only when the gate needs an independent review. `pickReviewer` takes a model whose family is recognised and, by default, differs from every contributor's; in single-family mode it takes a different model of the selected company from every contributor. The model must be available, not refused and paid only when allowed, and names each model it passed over and why. `reviewBrief` writes what the reviewer reads, fencing quoted text so it cannot pose as instructions; it states the project's review bar (`atelier init --review-bar`, or the default bar) before the reply format, and from the second review on lists each earlier finding with the developer's verdict and note, saying a refuted finding is repeated only with new evidence quoting the code. `parseVerdict` reads the reply and refuses one that states no verdict, states both, or gives findings that contradict its verdict; a rejection needs a blocking finding. A project with a review tier (`atelier init --review-tier H/M,H/M`) has every protected change reviewed by the tier too, most with one review: `pickReviewer` asks the tier's models first for the gate's review, and a tier model qualifying under the project's family mode gives both (`gateServesTier`), its review marked as the gate review, top tier. Only when the gate's reviewer is outside the tier is a separate tier request asked beside it: `pickTierReviewer` takes the first tier model that did not build the change and is not the gate's reviewer, whatever its family in the default mode, but only of the selected company in single-family mode. If no tier model qualifies, no separate tier review is requested. A tier rejection sends the change back as any rejection does; a separate tier approval never satisfies the gate, and a landing never waits for a tier review, whose open request the acceptance withdraws.",
    files: ["src/review/needed.ts", "src/review/reviewer.ts", "src/review/brief.ts", "src/review/verdict.ts", "src/review/tier.ts"],
    code: [{ file: "src/review/needed.ts", symbol: "reviewNeeded" }, { file: "src/review/reviewer.ts", symbol: "pickReviewer" }, { file: "src/review/brief.ts", symbol: "reviewBrief" }, { file: "src/review/verdict.ts", symbol: "parseVerdict" }, { file: "src/review/tier.ts", symbol: "gateServesTier" }, { file: "src/review/tier.ts", symbol: "pickTierReviewer" }],
  },
  {
    name: "Review requests and runner job", stage: "t39, build steps 9 and 10", built: true,
    what: "The ledger keeps review requests: its tick asks one for each submitted part whose checks pass and whose paths are measured, routed by `pickReviewer` to a model of another family than every contributor by default, or a different model of the selected company from every contributor in single-family mode, and the queue offers them as `review` jobs to a home runner whose config lists that job. The runner's `runReview` claims one, clones the part read-only, gives the model the review brief and the diff, and posts the verdict with its findings. `cli/agy-review.mjs` is the review command for the antigravity harness: it runs Antigravity's CLI on the brief and the diff and writes the reply to the verdict file. A rejection with blocking findings sends the part back to its builder for rework, and a harness that writes no valid verdict releases the request. Each runner's offer is recorded as it asks the queue for work (`putRunnerOffer`), and a dispatch no live runner offers, which could never be claimed however long it waits, is said as that by `unoffered`: `atelier land` while it waits for a verdict, `atelier plan show` for a routed review and `atelier status` for the queue, each naming what the live runners offer instead.",
    files: ["src/ledger.ts", "cli/runner.mjs", "cli/agy-review.mjs", "test/review-requests.spec.ts", "test/review-runner.test.mjs", "test/agy-review.test.mjs"],
    code: [{ file: "src/ledger.ts", symbol: "review_requests" }, { file: "src/ledger.ts", symbol: "reviewTick" }, { file: "src/index.ts", symbol: "review-claim" }, { file: "cli/runner.mjs", symbol: "runReview" }, { file: "cli/runner.mjs", symbol: "verdict_file" }, { file: "src/dispatch/rules.ts", symbol: "unoffered" }, { file: "src/ledger.ts", symbol: "putRunnerOffer" }],
  },
  {
    name: "Integration rules", stage: "t16, build step 11", built: true,
    what: "`src/plans/integrate.ts` holds the rules for merging parts into a plan's branch. `integrationBlockers` lets a part in only when it is submitted, every part it depends on has landed, and its head carries an approval from a model of another family than its contributors by default, or a different model of the selected company from every contributor in single-family mode; the developer's approval is not one, and a part takes no override. `verifyIntegration` accepts the integrator's merge commit only when it has exactly two parents, sits on the branch's first-parent line, and merges the part's head onto the integration head, the branch's head as the ledger last recorded it. `rollbackFor` says how a failed integration is undone, and refuses when that would discard commits it did not make. `planGate` adds to the plan task's gate: every part integrated or abandoned before integration, at least one integrated, each integrated part approved at the head that was integrated, and the branch's head at the integration head. There the parts' reviews are the plan's review, so the plan task asks no independent review of its own and the integrator's merges are not compared with any reviewer.",
    files: ["src/plans/integrate.ts"],
    code: [{ file: "src/plans/integrate.ts", symbol: "integrationBlockers" }, { file: "src/plans/integrate.ts", symbol: "verifyIntegration" }, { file: "src/plans/integrate.ts", symbol: "rollbackFor" }, { file: "src/plans/integrate.ts", symbol: "planGate" }],
  },
  {
    name: "Integration jobs", stage: "t16, build steps 12 to 14", built: true,
    what: "Each part forks from its plan's fork and is measured against it, never the baseline (`baseRepoOf` in src/plans/integrate.ts and the `base-token` route), so a part reports only its own files. A part claimed again with no commits of its own, after the branch has moved, has its fork forked again at the branch's head (`moveEmptyFork` in src/index.ts), so its builder starts from every part integrated since, as a task outside a plan claimed again with no commits of its own starts from main's head; a fork whose head is a later commit of the branch, which a move that failed to record its base leaves, is moved on the next claim the same way, and a fork whose head changes while it is moved is kept. The integrator, a reserved actor reached only through its token, claims the plan item's integrate job, merges the part onto the plan's branch, runs the plan's checks, and posts `integrated` or `integration-failed`, both verified against the branch's log by the Worker. `planGate` adds its blockers to the plan item's gate, and `Ledger.merged` marks the parts merged with `{via: tP}` when the plan lands. The runner's `--integrate` merges each part with `--no-ff` and rolls the branch back when the checks fail or the merge conflicts, and its refresh job merges main's head into the plan's fork, dispatched by the tick before a part when main has moved, or by the developer with `atelier plan refresh`, and recorded with `refreshed` or `refresh-failed`. A refresh that conflicts adds a merge-main part to the plan, outside the approved document and its hash: the runner merges main into that part's workspace and leaves the conflicts for its builder to resolve, no other part is dispatched until it is integrated, and its integration records main as taken. The developer adds one with `atelier plan refresh --resolve`. A plan is accepted only where its branch would merge with main (`assertPlanMergeable` in src/index.ts), and a plan submitted or accepted that must take main, the developer's plan refresh, or atelier merge stopped by a conflict, goes back to building first (`reopenPlan` in src/ledger.ts); the integrator submits it again once every part is integrated on a branch that holds main. A task outside a plan whose landing conflicted with main goes back to its builder the same way (t243): `atelier dispatch ID --job merge-main` queues the merge-main job on the task, whose runner merges main into its workspace and leaves the conflicts for it to resolve, where a plain rework would reset the workspace to a head that cannot reach main.",
    files: ["test/integration.spec.ts"],
    code: [{ file: "src/index.ts", symbol: "base-token" }, { file: "src/index.ts", symbol: "integration-failed" }, { file: "cli/runner.mjs", symbol: "runIntegrate" }],
  },
  {
    name: "Landing a single task", stage: "t187, outside the plan flow", built: true,
    what: "`atelier land ID` lands one task whole, from the developer's machine. It merges main into the task's workspace with `--no-ff` and stops on conflicts, naming the files, regenerates the project's fixtures when its policy says how, then pushes, runs the required checks and submits, each as the CLI's own command, all without the project's landing lease, beside any other task's landing (t550). It asks the server for the review the gate needs through the `review-request` route (`requestReview`), which picks a model of another family than every contributor by default, or a different model of the selected company from every contributor in single-family mode, or takes the one `--reviewer` names subject to the same restrictions, and queues a review job; it waits for the verdict. Only with the head checked and approved does it take the project's landing lease on the server (`beginProjectLanding`), for the merge alone, so two merges never race main and a second landing queues behind the first; under it the landing confirms main is still the commit the head was checked and reviewed against (`confirmLeaseMain`, which the merge's `beginLanding` holds the head to), then accepts and merges. Each step, its duration and the commits that came from main are recorded as `land.*` events (`landEvent`), and the lease is released when the landing ends, by a failure too. `--no-review` leaves the task submitted for the developer to settle, and `--dry-run` prints the steps without changing anything.",
    files: ["cli/land.mjs", "test/land.test.mjs", "test/land-routes.spec.ts"],
    code: [{ file: "cli/land.mjs", symbol: "runLand" }, { file: "src/index.ts", symbol: "landing-lease" }, { file: "src/index.ts", symbol: "review-request" }, { file: "src/ledger.ts", symbol: "beginProjectLanding" }, { file: "src/ledger.ts", symbol: "confirmLeaseMain" }, { file: "src/ledger.ts", symbol: "requestReview" }, { file: "src/ledger.ts", symbol: "landEvent" }, { file: "src/usage.ts", symbol: "land ID" }],
  },
];
