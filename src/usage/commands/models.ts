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
      about: "Shows a pool entry with its notes, oldest first, then the vendor cards recorded for the model under any of its names or harnesses, the claims that conflict and the registry's priors. A model the pool does not have is shown by its cards.",
    },
    {
      group: "Models", line: 1, slot: 45,
      form: "models card [ID] [--file FILE]",
      about: "Developer only: records a vendor's model card, read as JSON from FILE or standard input: the source URL, the day it was read, the publication date if given, and claims, each a benchmark with a score, unit and the conditions it was measured under, with the card's limitations. A list records each card under its \"model\". A card sent again is not added twice. A card that corrects or supersedes one names its id in \"corrects\" or \"supersedes\". Cards are the vendor's word, never Atelier's measurement, and nothing routes by them.",
    },
    {
      group: "Models", line: 1, slot: 47,
      form: "models card ID --withdraw cN --reason TEXT",
      about: "Developer only: withdraws a vendor card, kept in the model's history with the reason.",
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
  ],
  flags: { reason: false, harness: false, where: false, provider: false, endpoint: false, keychain: false, alias: false, note: false, item: false, key: false, "api-key": false, token: false, json: true, state: false, roles: false, tier: false, file: false, withdraw: false },
  // The pool itself is listed, added to and pruned on any server; the dated
  // notes, which `note` posts and `show` prints, need models.note.v1, and the
  // standing (t389), which `set` posts, needs models.standing.v1, as does
  // `add` when it gives --state, --roles or --tier (requiredForCommand).
  // Vendor cards (t625), which `card` posts, need models.card.v1; `show`
  // prints them when the server has it and says so when it does not.
  subcommands: {
    admit: { capabilities: ["reviews.admission.v1"] },
    withdraw: { capabilities: ["reviews.admission.v1"] },
    reviewers: { capabilities: ["reviews.admission.v1"] },
    note: { capabilities: ["models.note.v1"] },
    show: { capabilities: ["models.note.v1"] },
    card: { capabilities: ["models.card.v1"] },
    set: { capabilities: ["models.standing.v1"] },
    add: { capabilities: ["models.standing.v1"] },
  },
  help: {
    flags: {
      "--reason TEXT": "why the developer admits or withdraws a reviewer, or withdraws a vendor card",
      "--harness H": "the harness that runs the model: opencode, claude-code, codex, zcode, gemini-cli or antigravity",
      "--where home|cloud": "home, a harness on a home runner; cloud, a hosted service",
      "--provider P": "the provider the harness reaches the model through; a cloud opencode model must name one",
      "--endpoint URL": "the endpoint the harness is pointed at, for a home server",
      "--keychain NAME": "the Keychain entry that holds the key; the key itself is never sent",
      "--alias A": "another name the harness reports the model under; once per alias",
      "--note TEXT": "a note kept with the entry",
      "--state paused|reserved|available": "with set, the developer's standing; paused and reserved keep the model out of routing, dispatch suggestions and review requests",
      "--roles build,review,plan": "with set or add, the jobs the model may take; a review-only model is never a builder",
      "--tier frontier|execution|budget": "with set or add, the model's tier, stored and returned in JSON",
      "--json": "prints the pool as JSON, carrying each entry's state, roles, tier and notes",
      "--item tN": "the task a dated note concerns; without it the note bears on every task the model is suggested for",
      "--file FILE": "with card, the JSON file holding the card or a list of cards; without it the card is read from standard input",
      "--withdraw cN": "with card, the card to withdraw; give --reason",
    },
    example: "atelier models add gpt-6-astra --harness codex --where cloud",
  },
};

export default spec;
