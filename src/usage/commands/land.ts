import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "land",
  forms: [
    {
      group: "Owner", line: 1, slot: 40,
      form: "land ID [--reviewer H/M] [--no-review] [--wait] [--dry-run] [--release-lease] [--workflow [--checks local|container]]",
      about: "The project owner lands one task whole; a plan is refused before the lease, since it lands with `atelier merge ID --head H` at the integration head `plan show` prints and takes main through `plan refresh`. It takes the project's landing lease on the server, so two sessions never race main, then merges main into the task's workspace, stopping on conflicts and leaving them for the owner, naming the files. It regenerates the project's fixtures when the policy declares how (`init --regenerate`), pushes, runs the required checks and submits. It requests the independent review the gate needs through the review-request routes and waits for the verdict (up to 60 minutes, or ATELIER_LAND_REVIEW_TIMEOUT milliseconds), saying what the runners are busy with while the request is unclaimed, and, when no live runner offers the reviewer for the review job, that the request can never be claimed until one does, with the review by hand and the `--reviewer` that asks a model a runner offers, then accepts and merges. A named `--reviewer` is always asked, even where the gate needs no review, and a rejection stops the landing. Each step, its duration and the commits that came from main are recorded as land.* events, for the integration record. It refuses to start when the server's route level is lower than this CLI's, saying to deploy, and while another task's landing holds the lease, naming who holds it and since when, unless `--wait` queues behind it: the server keeps the landings waiting for the lease in the order they queued and hands it to the first of them when it frees, so one landing cannot take it ahead of another that waited longer, however their polls land. While it waits the landing asks the server again on every poll, says whose landing it waits behind and which landings are queued ahead, and starts when its turn comes (three hours at most, or ATELIER_LAND_WAIT_TIMEOUT milliseconds), so several landings started at once run in turn; a landing that stops asking drops out of the queue once 15 minutes pass without an ask. The lease is renewed while the landing runs, released on SIGINT or SIGTERM, and treated as free by the server once 15 minutes pass without a renewal, which the next landing reports when it takes the lease over. `--reviewer` names the reviewer; `--no-review` leaves the task submitted; `--wait` queues for the lease, in the order the landings queued; `--dry-run` prints the steps and the refusals without changing anything; `--release-lease` frees the project's lease, saying which task held it since when. `--workflow` lands through a Cloudflare Workflow instead: the lease, the submission, the review wait and the acceptance run on the server as durable steps, each retried through transient failures (an Artifacts 503, a lost connection) and needing no token, while this command shows the Workflow's stage and does the steps that need Git with a working tree when the Workflow asks: merging main and pushing (only once the Workflow holds the lease), and `atelier merge` once it has accepted. `--checks` says where the required checks run: `local` (the default) runs them on this machine in a clean clone of the pushed head before the head is reported, as the plain landing does, and the Workflow goes on only once the server has recorded every one passing, observed, at that head (failing ends the landing; no result within 30 minutes does too); `container` has the Workflow run them in a Cloudflare container, for a project whose suite finishes there. A conflict pauses the Workflow with the lease released and the files named; resolve and commit them, then run the same command again to resume. If the command stops (a closed laptop), the Workflow keeps its place: run it again to attach. `--dry-run` and `--workflow` together are refused.",
    },
  ],
  flags: {
    reviewer: false,
    "no-review": true,
    "dry-run": true,
    wait: true,
    "release-lease": true,
    workflow: true,
    checks: "--checks needs a mode: atelier land ID --workflow --checks local|container",
  },
  help: {
    flags: {
      "--reviewer H/M": "names the reviewer the request goes to, and the review is asked for even where the gate needs none; otherwise, when the gate needs a review, the server suggests a model of another company than every contributor from the pool and the models' records, and the landing prints which and why",
      "--no-review": "skips waiting: the task is left submitted for the owner to settle the review by hand",
      "--wait": "queues for the landing lease while another task's landing holds it, saying whose landing it waits behind and which landings are queued ahead; the server hands the lease to the waiting landings in the order they queued, so it starts when its turn comes (three hours at most)",
      "--dry-run": "prints the steps and the refusals without changing anything",
      "--release-lease": "frees the project's landing lease, held by a landing that was killed, and says which task held it since when; the project owner alone may",
      "--workflow": "lands through a Cloudflare Workflow: the lease, the submission, the review wait and the acceptance are durable steps on the server with retries, while this command shows the stage and merges main, pushes and merges when the Workflow asks; a conflict pauses it until you resolve it and run the command again, and a rerun attaches to the live landing",
      "--checks local|container": "with --workflow, where the required checks run: local (the default) runs them on this machine in a clean clone of the pushed head before reporting it, and the Workflow goes on only once the server has recorded each passing, observed, at that head; container has the Workflow run them in a Cloudflare container",
    },
    example: "atelier land t3 --project demo",
  },
};

export default spec;
