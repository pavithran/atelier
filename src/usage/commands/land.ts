import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "land",
  // The landing-workflow routes, the brief and criteria the review binds to,
  // the binding the review it waits for names, the criteria requirement
  // the project may hold, and the request number the review request's answer
  // carries, by which the landing counts the runners that skipped it (t353).
  capabilities: ["projects.commit-identity.v1", "land.workflow.v1", "items.brief-criteria.v1", "reviews.criteria-binding.v1", "projects.require-criteria.v1", "reviews.skip.v1", "land.post-merge.v1", "land.triage.v1"],
  // cli/land.mjs checks them itself, after --release-lease (the lease route
  // alone, which every server has, so a stuck lease is freed even while the
  // server is behind) and before the lease is read.
  capabilityCheck: "handler",
  forms: [
    {
      group: "Owner", line: 1, slot: 41,
      form: "land ID --post-merge status|resume|retry|skip|reconcile [--reason TEXT] [--resolution no-effect|completed]",
      about: "Inspect or resolve a durable post-merge run. Status shows the policy, SHAs, ordered steps and attempts. Resume runs pending work; retry resumes a failed step; skip records an owner waiver and continues. Retry, skip and reconcile require a reason. Running or uncertain attempts require the owner to stop the executor and reconcile its external effect before retry or skip. Completed steps never replay and unresolved work blocks later merges.",
    },
    {
      group: "Owner", line: 1, slot: 40,
      form: "land ID [--reviewer H/M] [--no-review] [--triage H/M | --no-triage REASON] [--override-triage REASON] [--wait] [--dry-run] [--release-lease] [--moved-ok] [--workflow [--checks local|container]]",
      about: "The project owner lands one task whole; a plan is refused before the lease, since it lands with `atelier merge ID --head H` at the integration head `plan show` prints and takes main through `plan refresh`. It takes the project's landing lease on the server, so two sessions never race main, then merges main into the task's workspace, stopping on conflicts and leaving them for the owner, naming the files. It regenerates the project's fixtures when the policy declares how (`init --regenerate`), pushes, runs the required checks and submits. With a triage model (`--triage H/M`, else the project's `triage` setting; neither runs none) it has that model, after the push and before the checks (whose passing evidence asks again for a review request the push withdrew from a task already submitted), read the pushed head's diff against its merge base with main and the task's acceptance criteria, and submits only when every criterion is met: a criterion not met or unsure, no criteria, an unreadable reply, a timeout or an unavailable model stops the landing before the review request, showing the findings and the commands to run again, releasing the lease and leaving the task with its holder. The owner may skip the triage with `--no-triage REASON` or go past a stop with `--override-triage REASON`; either is recorded with the head and the criteria binding first, and a record the server refuses stops the landing. Triage is recorded as land.triage events, never as a review, so the gate and the review rules after it are unchanged. It requests the independent review the gate needs through the review-request routes and waits for the verdict (up to 60 minutes, or ATELIER_LAND_REVIEW_TIMEOUT milliseconds), saying what the runners are busy with while the request is unclaimed, and, when no live runner offers the reviewer for the review job, that the request can never be claimed until one does, with the review by hand and the `--reviewer` that asks a model a runner offers, then accepts and merges. A named `--reviewer` is always asked, even where the gate needs no review, and a rejection stops the landing. Each step, its duration and the commits that came from main are recorded as land.* events, for the integration record. It refuses to start when the server's route level is lower than this CLI's, saying to deploy, and while another task's landing holds the lease, naming who holds it and since when, unless `--wait` queues behind it: the server keeps the landings waiting for the lease in the order they queued and hands it to the first of them when it frees, so one landing cannot take it ahead of another that waited longer, however their polls land. While it waits the landing asks the server again on every poll, says whose landing it waits behind and which landings are queued ahead, and starts when its turn comes (three hours at most, or ATELIER_LAND_WAIT_TIMEOUT milliseconds), so several landings started at once run in turn; a landing that stops asking drops out of the queue once 15 minutes pass without an ask. The lease is renewed while the landing runs, released on SIGINT or SIGTERM, and treated as free by the server once 15 minutes pass without a renewal, which the next landing reports when it takes the lease over. `--reviewer` names the reviewer; `--no-review` leaves the task submitted; `--wait` queues for the lease, in the order the landings queued; `--dry-run` prints the steps and the refusals without changing anything; `--release-lease` frees the project's lease, saying which task held it since when. `--workflow` lands through a Cloudflare Workflow instead: the lease, the submission, the review wait and the acceptance run on the server as durable steps, each retried through transient failures (an Artifacts 503, a lost connection) and needing no token, while this command shows the Workflow's stage and does the steps that need Git with a working tree when the Workflow asks: merging main and pushing (only once the Workflow holds the lease), and `atelier merge` once it has accepted. `--checks` says where the required checks run: `local` (the default) runs them on this machine in a clean clone of the pushed head, after any triage and before the head is reported, as the plain landing does, and the Workflow goes on only once the server has recorded every one passing, observed, at that head (failing ends the landing; no result within 30 minutes does too); `container` has the Workflow run them in a Cloudflare container, for a project whose suite finishes there. A conflict pauses the Workflow with the lease released and the files named; resolve and commit them, then run the same command again to resume. If the command stops (a closed laptop), the Workflow keeps its place: run it again to attach. `--dry-run` and `--workflow` together are refused.",
    },
  ],
  flags: {
    "post-merge": "--post-merge takes status|resume|retry|skip|reconcile",
    reason: "--reason needs the owner’s explanation",
    resolution: "--resolution takes no-effect|completed, after stopping the executor",
    reviewer: false,
    "no-review": true,
    triage: "--triage needs harness/model: atelier land ID --triage H/M",
    "no-triage": "--no-triage needs the reason it is bypassed: atelier land ID --no-triage \"REASON\"",
    "override-triage": "--override-triage needs the reason a stopped triage is overridden: atelier land ID --override-triage \"REASON\"",
    "dry-run": true,
    wait: true,
    "release-lease": true,
    workflow: true,
    "moved-ok": true,
    checks: "--checks needs a mode: atelier land ID --workflow --checks local|container",
  },
  help: {
    flags: {
      "--reason TEXT": "the owner’s explanation for retry, skip or reconciliation, recorded in history",
      "--resolution no-effect|completed": "with reconcile, record the observed external effect after stopping the executor; a deployment still requires independent version verification or a waiver",
      "--post-merge ACTION": "status shows the durable run and attempts; resume executes pending work; retry resumes a failed step; skip --reason records a waiver; reconcile --reason --resolution no-effect|completed settles uncertain effects after stopping the executor",
      "--reviewer H/M": "names the reviewer the request goes to, and the review is asked for even where the gate needs none; otherwise, when the gate needs a review, the server suggests a model of another company than every contributor from the pool and the models' records, and the landing prints which and why",
      "--no-review": "skips waiting: the task is left submitted for the owner to settle the review by hand",
      "--triage H/M": "names the model that triages the merged diff against the task's acceptance criteria before the review is asked for, in place of the project's triage setting; same-company models may triage, and the pool's access and cost rules apply",
      "--no-triage REASON": "skips the triage the project sets; the project owner's reason is recorded with the head and the criteria binding before the landing goes on",
      "--override-triage REASON": "goes on past a triage that stops; the project owner's reason is recorded with the head and the criteria binding first. Neither this nor --no-triage stands in for the independent review",
      "--wait": "queues for the landing lease while another task's landing holds it, saying whose landing it waits behind and which landings are queued ahead; the server hands the lease to the waiting landings in the order they queued, so it starts when its turn comes (three hours at most)",
      "--dry-run": "prints the steps and the refusals without changing anything",
      "--release-lease": "frees the project's landing lease, held by a landing that was killed, and says which task held it since when; the project owner alone may",
      "--moved-ok": "goes on past the edits in code main moved to another file that this landing's comparison detects before merging main (which otherwise stop it, naming source and destination), once your approval of exactly those findings at those revisions is recorded on the ledger; findings at other revisions need a fresh approval, and Git's own conflicts still stop the landing",
      "--workflow": "lands through a Cloudflare Workflow: the lease, the submission, the review wait and the acceptance are durable steps on the server with retries, while this command shows the stage and merges main, pushes and merges when the Workflow asks; a conflict pauses it until you resolve it and run the command again, and a rerun attaches to the live landing",
      "--checks local|container": "with --workflow, where the required checks run: local (the default) runs them on this machine in a clean clone of the pushed head before reporting it, and the Workflow goes on only once the server has recorded each passing, observed, at that head; container has the Workflow run them in a Cloudflare container",
    },
    example: "atelier land t3 --project demo",
  },
};

export default spec;
