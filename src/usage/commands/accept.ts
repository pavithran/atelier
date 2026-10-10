import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "accept",
  forms: [
    {
      group: "Owner", line: 1, slot: 10,
      form: "accept ID [--head SHA] [--override-review REASON] [--note TEXT]",
      about: "The project owner accepts the task at its current head; `--head` names that head, and any other is refused. `--note` keeps the owner's word on the acceptance with it in the ledger. It is refused unless the gate is clear. When the change still lacks its independent review because no reviewer qualifies, `--override-review` overrides that review and accepts: the reason is required, the override is recorded as an event of its own, never as a review, and the task page and the inbox show it with its reason. The owner token alone does not override, nor does the browser session it signs in: the owner first presses Allow an override from the command line on the task's page, confirming with a factor no agent holds, the Cloudflare Access sign-in where the pages are behind Access, else the server's confirmation secret (OVERRIDE_SECRET), which allows one override of that revision for 15 minutes; without it the command is refused, naming the page and the factor. A server with neither Access nor a secret can confirm no override. A project set up with `atelier init --no-override` refuses every override.",
    },
  ],
  flags: {
    head: false,
    note: false,
    "override-review": '--override-review needs a reason: atelier accept ID --override-review "why no independent review is possible"',
  },
  help: {
    flags: {
      "--head SHA": "the revision accepted; the task's current head unless given, and any other is refused",
      "--override-review REASON": "accepts without the independent review, when no reviewer qualifies; the reason is recorded, and the owner must first allow it on the task's page, confirming with the Access sign-in or the server's confirmation secret",
      "--note TEXT": "the owner's word on the acceptance, kept with it in the ledger",
    },
    example: "atelier accept t3 --project demo",
  },
};

export default spec;
