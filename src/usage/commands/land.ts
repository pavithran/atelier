import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "land",
  // The brief and criteria the review binds to,
  // the binding the review it waits for names, the criteria requirement
  // the project may hold, and the request number the review request's answer
  // carries, by which the landing counts the runners that skipped it (t353).
  capabilities: ["projects.commit-identity.v1", "items.brief-criteria.v1", "reviews.criteria-binding.v1", "projects.require-criteria.v1", "reviews.skip.v1", "land.post-merge.v1", "land.triage.v1"],
  // cli/land.mjs checks them itself, after --release-lease (the lease route
  // alone, which every server has, so a stuck lease is freed even while the
  // server is behind) and before the lease is read.
  capabilityCheck: "handler",
  forms: [
    {
      group: "Developer", line: 1, slot: 43,
      form: "land ID --queue [--cancel]",
      about: "Queue the landing for a runner that holds this project's registered checkout and lists the land job (t226), instead of running it here. The runner runs `atelier land ID` there, under the landing lease, and resumes from the landing journal after a kill. It refuses, saying why, when the checkout is dirty, and reports a failure once with the failing step and the last lines of that step's output, which `show ID --json` carries as `landing`. A failed landing is not tried again on a timer: only a new head or `--queue` again lets the runner take it. `--cancel` removes the queued landing; run twice, the second says it is not queued and changes nothing; a landing already past its merge step is refused, naming the step, and not interrupted.",
    },
    {
      group: "Developer", line: 1, slot: 41,
      form: "land ID --post-merge status|resume|retry|skip|reconcile [--reason TEXT] [--resolution no-effect|completed]",
      about: "Inspect or resolve a durable post-merge run. Status shows the policy, SHAs, ordered steps and attempts. Resume runs pending work; retry resumes a failed step; skip records a developer waiver and continues. Retry, skip and reconcile require a reason. Running or uncertain attempts require the developer to stop the executor and reconcile its external effect before retry or skip. Completed steps never replay and unresolved work blocks later merges.",
    },
    {
      group: "Developer", line: 1, slot: 42,
      form: "land ID ID… [--parallel N] [land flags]",
      about: "Land several tasks in turn. A bounded pool of ordinary `atelier land` commands runs (`--parallel N`, a positive integer, 3 when omitted, per invocation), started in the order named; each does what `atelier land ID` does, so checks and reviews overlap and merges take the landing lease one at a time. A task named twice lands once. Each result prints the moment its landing ends: landed; asked, not landed (the landing stopped at the review ask or at `--no-review`, so the task is still submitted and nothing merged; the child exits 75); or failed, with the reviewer and blocking findings the landing printed; the others go on, and the exit status is non-zero if any failed or was asked without landing. A task already merged with no post-merge work open is reported as merged; one with post-merge work open resumes it before it counts as complete. After a landing fails with post-merge work open, no queued task is started (a landing already running is held by the server's post-merge barrier on its merge); resolve it with `atelier land ID --post-merge status`, then run the same command. SIGINT and SIGTERM reach every landing, which releases its own lease and no other holder's, and start no more; running the same command again reads the ledger and continues. `--release-lease` and `--post-merge` act on one task and are refused with several.",
    },
    {
      group: "Developer", line: 1, slot: 40,
      form: "land ID [--reviewer H/M] [--no-review] [--triage H/M | --no-triage REASON] [--override-triage REASON] [--wait | --no-wait] [--quote TEXT] [--dry-run] [--release-lease] [--moved-ok]",
      about: "The developer lands one task whole; a plan is refused before the lease, since it lands with `atelier merge ID --head H` at the integration head `plan show` prints and takes main through `plan refresh`. A blocked task is never landed. The landing lands the head the task was checked and reviewed at and never pushes to the task's branch, so its approvals stand as given (G2). Before the project's landing lease, beside any other task's landing: it compares the task's edits with code main moved to another file (a finding stops it, naming source and destination; `--moved-ok` records your approval of exactly those findings and goes on); a task still claimed has its required checks run at its recorded head in a clean clone and is submitted (its workspace must hold nothing unpushed). With a triage model (`--triage H/M`, else the project's `triage` setting; neither runs none) it has that model read the head's diff against its merge base with main and the task's acceptance criteria, and goes on only when every criterion is met: anything else stops the landing before the review request, showing the findings and the commands to run again; the developer may skip the triage with `--no-triage REASON` or go past a stop with `--override-triage REASON`, either recorded with the head and the criteria binding first, and triage is recorded as land.triage events, never as a review. An approval already recorded at the head that the gate counts settles the review with no request: the named `--reviewer`'s where it is recorded, otherwise any other reviewer's the gate counts (t313). Otherwise it requests the independent review the gate needs and does not wait for the verdict (t264): it prints the reviewer and the reason, records a land request (who asked, and the `--quote` words where given) once, and stops with the lease never taken; you run the command again once the review approves, or, in fast mode under the developer's standing queue-landable instruction, the stage tick queues the land job for a runner that holds the registered checkout. Without `--reviewer`, and with no approval recorded at the head, the server names no reviewer: it refuses with every candidate and its reliability (`reviewer_needed`), and the landing stops. A machine with no registered checkout records the request and follows the job a lander takes. Where the project sets risk reviews (`init --risk-reviews`) and a change needs several approvals, ask them together first with `atelier review-request ID --reviewer H/M --reviewer H/M`; the approvals the gate counts at the head settle the landing's review step. In fast mode no review is asked before the merge; the review step is recorded as skipped for fast mode, and the review is asked after the merge. Once the gate holds the head with its checks passing and an approval it counts, the landing takes the project's landing lease (queueing for it, with or without `--wait`, in the order the landings queued, three hours at most or ATELIER_LAND_WAIT_TIMEOUT milliseconds), accepts the head, and runs `atelier merge ID --landing` in the registered checkout: the head is merged into the project's branch there through the merge pipeline (a conflict stops it with the files named and nothing pushed, the approval standing); the project's regenerate command runs on the merged tree and what it changes joins the merge commit; the required checks run once on the merged tree in a clean clone (a failure pushes nothing and leaves the task accepted, not rejected); and only the merge commit is pushed to the project's branch. If main moved between the checks and the push, the push is refused and the merge and checks are made again on the new main, twice at most, then the landing stops and says so. Every step is recorded with its attempt on the task's landing record, which `show ID --json` carries as `landing: {step, attempt, failedStep, tail, at}`: a failure names its step, the last lines of that step's own output and any files it stopped on, and a refusal before any step is the start step failing. A failed landing is not tried again on a timer: the land job waits until the task's head changes or `land ID --queue` is run again. The lease is renewed while the landing runs, released on SIGINT or SIGTERM, and treated as free by the server once 15 minutes pass without a renewal. `--reviewer` names the reviewer; `--no-review` leaves the task submitted; `--dry-run` prints the steps and the refusals without changing anything; `--release-lease` frees the project's lease, saying which task held it since when.",
    },
  ],
  flags: {
    "post-merge": "--post-merge takes status|resume|retry|skip|reconcile",
    reason: "--reason needs the developer’s explanation",
    resolution: "--resolution takes no-effect|completed, after stopping the executor",
    reviewer: false,
    "no-review": true,
    triage: "--triage needs harness/model: atelier land ID --triage H/M",
    "no-triage": "--no-triage needs the reason it is bypassed: atelier land ID --no-triage \"REASON\"",
    "override-triage": "--override-triage needs the reason a stopped triage is overridden: atelier land ID --override-triage \"REASON\"",
    "dry-run": true,
    wait: true,
    "no-wait": true,
    quote: "--quote needs the words that asked for the landing: atelier land ID --quote \"TEXT\"",
    "release-lease": true,
    queue: true,
    cancel: true,
    parallel: "--parallel needs a positive integer: atelier land t1 t2 --parallel 3",
    "moved-ok": true,
  },
  help: {
    flags: {
      "--reason TEXT": "the developer’s explanation for retry, skip or reconciliation, recorded in history",
      "--resolution no-effect|completed": "with reconcile, record the observed external effect after stopping the executor; a deployment still requires independent version verification or a waiver",
      "--post-merge ACTION": "status shows the durable run and attempts; resume executes pending work; retry resumes a failed step; skip --reason records a waiver; reconcile --reason --resolution no-effect|completed settles uncertain effects after stopping the executor",
      "--reviewer H/M": "names the reviewer the request goes to, and the review is asked for even where the gate needs none, unless an approval the gate counts (this reviewer's or another's) is already recorded at the pushed head; without it, when the gate needs a review and none is recorded, the server picks no reviewer and refuses with the candidates, so the landing stops",
      "--no-review": "skips waiting: the task is left submitted for the developer to settle the review by hand",
      "--triage H/M": "names the model that triages the merged diff against the task's acceptance criteria before the review is asked for, in place of the project's triage setting; same-company models may triage, and the pool's access and cost rules apply",
      "--no-triage REASON": "skips the triage the project sets; the developer's reason is recorded with the head and the criteria binding before the landing goes on",
      "--override-triage REASON": "goes on past a triage that stops; the developer's reason is recorded with the head and the criteria binding first. Neither this nor --no-triage stands in for the independent review",
      "--wait": "queues for the landing lease while another task's landing holds it, saying whose landing it waits behind and which landings are queued ahead; the server hands the lease to the waiting landings in the order they queued, so it merges when its turn comes (three hours at most). Since t550 every landing queues this way once its head is checked and approved, so the flag is kept for scripts",
      "--no-wait": "records the land request (and asks for the review where the task is submitted) and returns; run the command again to resume, which records the request once (a land job lands it only under the standing queue-landable instruction)",
      "--quote TEXT": "the words that asked for the landing, kept with the land request",
      "--dry-run": "prints the steps and the refusals without changing anything",
      "--release-lease": "frees the project's landing lease, held by a landing that was killed, and says which task held it since when; the developer alone may",
      "--parallel N": "with several tasks, how many landings run at once (a positive integer, 3 when omitted, per invocation, not across machines)",
      "--moved-ok": "goes on past the edits in code main moved to another file that this landing's comparison detects before merging main (which otherwise stop it, naming source and destination), once your approval of exactly those findings at those revisions is recorded on the ledger; findings at other revisions need a fresh approval, and Git's own conflicts still stop the landing",
      "--cancel": "with --queue, removes the queued landing; nothing queued is said and changes nothing, and a landing past its merge step is refused, naming the step",
      "--queue": "queues the landing for a runner that holds this project's registered checkout and lists the land job (t226); the runner runs atelier land ID there, under the landing lease, and resumes from the landing journal after a kill. It refuses, saying why, when the checkout is dirty or its main is not the baseline's. Nothing runs on this machine. It is refused with --dry-run, which would otherwise queue a real landing",
    },
    example: "ATELIER_ACTING=claude-code/opus-5.5 atelier land t3 --project demo",
  },
};

export default spec;
