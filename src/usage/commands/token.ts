import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "token",
  forms: [
    {
      group: "Tokens", line: 1, slot: 10,
      form: "token issue --as H/M [--project P]... [--days N] [--label TEXT]",
      about: "The project owner issues a token bound to one actor and shown once. It expires in 30 days unless `--days` (1 to 365) says otherwise, and covers the named projects or all of them.",
    },
    {
      group: "Tokens", line: 1, slot: 20,
      form: "token ls",
      about: "Lists token records without the tokens or their hashes.",
    },
    {
      group: "Tokens", line: 1, slot: 30,
      form: "token revoke ID",
      about: "Revokes a token; later API requests with it are refused. Git credentials already issued keep their own lifetime.",
    },
  ],
  flags: { days: false, label: false },
  help: {
    flags: {
      "--as H/M": "the actor the token is bound to; every request with it must name that actor",
      "--project P": "limits the token to the named projects, once per project; without it, every project",
      "--days N": "how many days the token lasts, 1 to 365; 30 unless given",
      "--label TEXT": "a label kept with the token's record, to tell tokens apart in token ls",
    },
    example: "atelier token issue --as codex/gpt-6-astra --project demo --days 7",
  },
  subcommands: {
    issue: {
      flags: { runner: false },
      usage: `usage: atelier token issue --as H/M [--project P]... [--days N] [--label TEXT]
       atelier token issue --runner NAME --project P [--days N] [--label TEXT]

Only the owner issues tokens. A runner token binds one normalized runner and
one existing project. NAME defaults to home:NAME. --as and --runner cannot
be combined. Expiry defaults to 30 days; --days accepts 1 through 365.
The token is shown once. See docs/runners.md for owner-free build and plan runners.`,
    },
    store: {
      flags: { runner: false },
      usage: `usage: atelier token store --runner NAME

Reads a runner token from stdin or a hidden prompt, verifies its runner name
with ATELIER_SERVER (or the configured server), and stores the token and
server together as runner.home:NAME. ATELIER_RUNNER_TOKEN overrides the store.
An invalid explicit credential never falls back to owner credentials.`,
    },
  },
};

export default spec;
