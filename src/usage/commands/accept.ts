import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "accept",
  // --quote sends the developer's direction with an override (t629), which a
  // server needs projects.developer-direction.v1 for (requiredForCommand).
  capabilities: ["projects.developer-direction.v1"],
  forms: [
    {
      group: "Developer", line: 1, slot: 10,
      form: "accept ID [--head SHA] [--override-review REASON [--quote WORDS]] [--note TEXT]",
      about: "The developer accepts the task at its current head; `--head` names that head, and any other is refused. `--note` keeps the developer's word on the acceptance with it in the ledger. It is refused unless the gate is clear. When the change still lacks its independent review because no reviewer qualifies, `--override-review` overrides that review and accepts: the reason is required, the override is recorded as an event of its own, never as a review, and the task page and the inbox show it with its reason. The developer's direction confirms it: `--quote` with the developer's own words and `--as H/M` (or ATELIER_ACTOR) naming the model acting on them, both recorded with the override and shown on the task page, in the status and in the receipt. Without them the developer token alone does not override, nor does the browser session it signs in: the developer first presses Allow an override from the command line on the task's page, confirming with a factor no agent holds, the Cloudflare Access sign-in where the pages are behind Access, else the server's confirmation secret (OVERRIDE_SECRET), which allows one override of that revision for 15 minutes; without either the command is refused, naming the page and the factor. A project set up with `atelier init --no-override` refuses every override.",
    },
  ],
  flags: {
    head: false,
    note: false,
    "override-review": '--override-review needs a reason: atelier accept ID --override-review "why no independent review is possible"',
    quote: '--quote needs the developer\'s words: atelier accept ID --override-review REASON --quote "what the developer said"',
  },
  help: {
    flags: {
      "--head SHA": "the revision accepted; the task's current head unless given, and any other is refused",
      "--override-review REASON": "accepts without the independent review, when no reviewer qualifies; the reason is recorded, and it is confirmed by the developer's direction (--quote) or allowed first on the task's page with the Access sign-in or the server's confirmation secret",
      "--quote WORDS": "with --override-review, the developer's own words directing the override; with --as H/M, the model acting on them, they confirm it with the developer token alone, and both are recorded with it",
      "--note TEXT": "the developer's word on the acceptance, kept with it in the ledger",
      "--as H/M": "with --override-review, the harness/model overriding for the developer, kept beside them as its acting model; required with --quote",
    },
    example: "atelier accept t3 --project demo",
  },
};

export default spec;
