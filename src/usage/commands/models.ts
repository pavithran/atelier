import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "models",
  forms: [
    {
      group: "Models", line: 1, slot: 60,
      form: "models admit ID --project NAME --reason TEXT",
      about: "Developer only: admits a registered model as a reviewer in this project, including its aliases. A known independent family is still required.",
    },
    {
      group: "Models", line: 1, slot: 70,
      form: "models withdraw ID --project NAME --reason TEXT",
      about: "Developer only: withdraws reviewer admission and outstanding requests. Past approvals keep their bindings.",
    },
    {
      group: "Models", line: 1, slot: 80,
      form: "models reviewers --project NAME",
      about: "Lists the project's reviewer admissions and withdrawals with actor, reason and time.",
    },
    {
      group: "Models", line: 1, slot: 10,
      form: "models [--json]",
      about: "Lists the model pool: each model's harness, where it runs, its family, what a runner last found and its dated notes, and, with `--json`, the whole pool as JSON carrying each entry's state, roles, tier and notes.",
    },
    {
      group: "Models", line: 1, slot: 20,
      form: "models add ID --harness H --where home|cloud [--provider P] [--endpoint URL] [--keychain NAME] [--alias A]... [--note TEXT] [--state paused|reserved|available] [--roles build,review,plan] [--tier frontier|execution|budget]",
      about: "Adds or replaces a pool entry. Atelier never stores a key: `--keychain` names the Keychain entry that holds it, and a request that carries a key is refused. `--note` keeps a note with the entry.",
    },
    {
      group: "Models", line: 1, slot: 25,
      form: "models set ID --state paused|reserved|available [--note TEXT] [--roles build,review,plan] [--tier frontier|execution|budget]",
      about: "Changes an entry's standing, note, roles and tier.",
    },
    {
      group: "Models", line: 1, slot: 30,
      form: "models show ID",
      about: "Shows a pool entry with its notes, oldest first.",
    },
    {
      group: "Models", line: 1, slot: 40,
      form: "models note ID 'text' [--item tN]",
      about: "Keeps a dated note under a pool model, by its author. `--item` names the task it concerns; a note with none bears on every task the model is suggested for.",
    },
    {
      group: "Models", line: 1, slot: 50,
      form: "models remove ID",
      about: "Removes a model from the pool.",
    },
    {
      group: "Models", line: 1, slot: 90,
      form: "models assign ROLE H/M [H/M]... --reason TEXT --quote TEXT --evidence PROJECT/tN [--evidence REF]... [--scope PROJECT] [--replaces aN] [--as H/M]",
      about: "Developer only: records which models take a role (build, review, security-review, claims-review or plan), in order, for every project or one, dated, with the reason, the developer's words and evidence as PROJECT/tN or PROJECT/tN#SEQ, each checked to exist. Routing, review requests, the planner and dispatch suggestions put its eligible choices first; an assignment never makes a model eligible. Superseding a standing one names it with `--replaces`.",
    },
    {
      group: "Models", line: 1, slot: 95,
      form: "models roles [--json] | models roles withdraw aN --note TEXT [--as H/M]",
      about: "Lists the standing role assignments, their history with evidence and author, and the fallback each role without one goes by. `withdraw` ends the standing one with a note: the role returns to its fallback, never to an assignment it superseded.",
    },
  ],
  flags: { reason: false, harness: false, where: false, provider: false, endpoint: false, keychain: false, alias: false, note: false, item: false, key: false, "api-key": false, token: false, json: true, state: false, roles: false, tier: false, quote: false, evidence: false, scope: false, replaces: false },
  // The pool itself is listed, added to and pruned on any server; the dated
  // notes, which `note` posts and `show` prints, need models.note.v1, and the
  // standing (t389), which `set` posts, needs models.standing.v1, as does
  // `add` when it gives --state, --roles or --tier (requiredForCommand).
  subcommands: {
    admit: { capabilities: ["reviews.admission.v1"] },
    withdraw: { capabilities: ["reviews.admission.v1"] },
    reviewers: { capabilities: ["reviews.admission.v1"] },
    note: { capabilities: ["models.note.v1"] },
    show: { capabilities: ["models.note.v1"] },
    set: { capabilities: ["models.standing.v1"] },
    add: { capabilities: ["models.standing.v1"] },
    // Role assignments (t622): recorded, listed and withdrawn on a server
    // with models.roles.v1.
    assign: { capabilities: ["models.roles.v1"] },
    roles: { capabilities: ["models.roles.v1"] },
  },
  help: {
    flags: {
      "--reason TEXT": "why the developer admits or withdraws a reviewer; with assign, why these models take the role",
      "--harness H": "the harness that runs the model: opencode, claude-code, codex, zcode, gemini-cli or antigravity",
      "--where home|cloud": "home, a harness on a home runner; cloud, a hosted service",
      "--provider P": "the provider the harness reaches the model through; a cloud opencode model must name one",
      "--endpoint URL": "the endpoint the harness is pointed at, for a home server",
      "--keychain NAME": "the Keychain entry that holds the key; the key itself is never sent",
      "--alias A": "another name the harness reports the model under; once per alias",
      "--note TEXT": "a note kept with the entry; with roles withdraw, why the assignment is withdrawn",
      "--state paused|reserved|available": "with set, the developer's standing; paused and reserved keep the model out of routing, dispatch suggestions and review requests",
      "--roles build,review,plan": "with set or add, the jobs the model may take; a review-only model is never a builder",
      "--tier frontier|execution|budget": "with set or add, the model's tier, stored and returned in JSON",
      "--json": "prints the pool as JSON, carrying each entry's state, roles, tier and notes",
      "--item tN": "the task a dated note concerns; without it the note bears on every task the model is suggested for",
      "--quote TEXT": "with assign, the developer's own words the assignment rests on",
      "--evidence REF": "with assign, a task or event the assignment rests on, as PROJECT/tN or PROJECT/tN#SEQ; once per reference, a bare tN is refused",
      "--scope PROJECT": "with assign, the one project the assignment is for; every project when not given",
      "--replaces aN": "with assign, the standing assignment it supersedes, so two sessions cannot both replace it",
    },
    example: "atelier models add gpt-6-astra --harness codex --where cloud",
  },
};

export default spec;
