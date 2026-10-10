import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "plan",
  forms: [
    {
      group: "Plans", line: 1, slot: 10,
      form: 'plan "goal" [--scope GLOB]... [--planner H/M]',
      about: "The project owner states a goal. Atelier creates the plan task and queues it as a plan job for the planner named, or else for the first model in the pool for research work that is not refused, not paid per token and may plan. A project has one active plan at a time. A runner that offers plan jobs takes it: the planner claims the plan task, reads its brief from the job-brief route and posts the plan document the harness wrote; by hand, a planner claims with `--runner` and runs `plan post`.",
    },
    {
      group: "Plans", line: 1, slot: 20,
      form: "plan show ID [--json]",
      about: "Prints a plan: its phase, the newest proposal with its hash, or once approved each part with its state, dependencies, scope, routing and attempts, the live item outside the plan a queued part waits on while the project's core files hold it, any live review request naming the reviewer asked and whether a runner claimed it, and saying, when no live runner offers that reviewer for the review job, that the request can never be claimed until one does, with the reroute that names another, then the part dispatches used, why it is blocked, the main head the branch last took against main's head now with any refresh in flight or failed, and the command for each decision waiting on the owner. Before approval it shows the routing an approval would fix now, its reviewers judged against the live runner offers the same way. It accepts a part's id too.",
    },
    {
      group: "Plans", line: 2, slot: 10,
      form: "plan approve ID --hash HASH [--allow-paid]",
      about: "Approves the split, once, by the hash of its newest proposal; an older hash is refused. The routing of each part is fixed then, with the limits: 2 parts live at once, 3 attempts a part, 4 dispatches a part, 24 hours. A part that no model can build, or that no model of another family can review, refuses the approval; a reviewer counts only when a live runner offers it for the review job, and when no runner is live the pool stands, with the routing saying so. `--allow-paid` lets models paid per token build and review.",
    },
    {
      group: "Plans", line: 2, slot: 20,
      form: "plan revise ID --note TEXT",
      about: "Before approval, sends the plan back to its planner with a note; its next proposal replaces the one before.",
    },
    {
      group: "Plans", line: 3, slot: 10,
      form: "plan reroute ID --to H/M",
      about: "Names who builds an open part from now on, its attempts counted afresh; for a submitted part, or one blocked for want of an eligible reviewer, names its reviewer, in the pool or not, which must be of another family than every contributor; before approval, names another planner for the plan.",
    },
    {
      group: "Plans", line: 3, slot: 20,
      form: "plan retry ID",
      about: "Counts an open part's attempts afresh, so its builder is asked again; before approval, asks the planner again.",
    },
    {
      group: "Plans", line: 3, slot: 30,
      form: "plan refresh ID [--resolve [--to H/M]]",
      about: "Queues the plan's refresh job for the integrator, which merges main's head into the plan's branch, so later parts fork from it; parts wait for it before they are dispatched. The tick does this itself before it dispatches a part when main has moved, once per main head; this runs it again, as after a failed refresh. On a plan submitted or accepted, it first withdraws the submission and any acceptance and puts the plan back to building, and says so; the integrator submits it again once every part is integrated on a branch that holds main. It is refused before approval, once the plan is closed, while the plan's integrate or refresh job is queued or held, while a merge of the plan holds its landing lease, and when the branch already holds main's head. A refresh that conflicts adds a merge-main part to the plan, which a model builds: the runner merges main into the part's workspace and leaves the conflicts for it to resolve, and its integration puts main on the branch; no other part is dispatched until it is integrated. `--resolve` adds that part for main's head now without trying a refresh first, built by `--to` when named; it is refused while a refresh is queued, when the part for that head exists, while another merge-main part is not integrated, and when the branch already holds main's head.",
    },
    {
      group: "Plans", line: 3, slot: 40,
      form: "plan stop ID [--note TEXT]",
      about: "Closes the plan and every part not yet merged, revoking their write tokens. The history and evidence stay.",
    },
    {
      group: "Plans", line: 4, slot: 10,
      form: "plan post ID FILE",
      about: "The holder of the plan task's claim, its planner, posts the plan document in FILE. An invalid one is refused with every error, and the planner gets one more attempt before the plan blocks.",
    },
  ],
  flags: {
    scope: '--scope needs text: atelier plan "goal" --scope "GLOB", once per entry',
    planner: false,
    json: true,
    hash: false,
    "allow-paid": true,
    note: false,
    to: false,
    resolve: true,
  },
  help: {
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
  subcommands: {
    "": { takes: ["scope", "planner"] },
    show: { takes: ["json"] },
    approve: { takes: ["hash", "allow-paid"] },
    revise: { takes: ["note"] },
    reroute: { takes: ["to"] },
    retry: { takes: [] },
    refresh: { takes: ["resolve", "to"] },
    stop: { takes: ["note"] },
    post: { takes: [] },
  },
};

export default spec;
