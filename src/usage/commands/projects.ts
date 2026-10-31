import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "projects",
  forms: [
    {
      group: "Projects", line: 1, slot: 10,
      form: "projects rename OLD NEW [--release-name]",
      about: "Use ATELIER_ACTING=H/M on the developer token; --as changes the actor and is refused. The developer gives a project a new name on the server, and this machine's config entry moves to it. The ledger, the baseline repository and every branch stay where they are. The old name keeps working: the API serves it, old page links redirect, and tokens and workspaces that use it need no change. A name another project has or had, or one a removed project's ledger is kept under, is refused. With `--release-name` the project also gives up OLD: it stops answering to OLD, tokens limited to OLD are limited to NEW, and a project created later under OLD is stored apart, with a ledger and a baseline repository of their own.",
    },
    {
      group: "Projects", line: 1, slot: 30,
      form: "projects move-host NAME --from REMOTE [--token-env VAR] [--way-back] [--clear-secret REASON --quote WORDS]",
      about: "The developer moves a project's repository to this server (Atelier 2.0, the Studio). The server itself fetches the project's branch, its provenance notes and its tags from REMOTE (the Artifacts baseline, or any Git remote) into the project's repository, checks the branch equals the remote's, and names the repository as the builders' remote. Run again at the cut-over, it moves the branch on to what the remote holds now; a branch this server has moved past is left, and one that has diverged is refused. What the move adds meets the checks a push would: the secret scan and the private-file guard refuse it, and a key-shaped line the refusal named passes once the developer clears it with `--clear-secret REASON --quote WORDS`. It moves the branch only during the migration: after `--end-bake`, or once a landing has moved the branch here with no way back kept, only a landing does. With `--way-back`, the remote and its token are kept, and each landing pushes the branch back to it during the bake, so the way back finds it current. The token is read from the variable `--token-env` names.",
    },
    {
      group: "Projects", line: 1, slot: 31,
      form: "projects move-host NAME --push-back | --renew-way-back --token-env VAR | --end-bake",
      about: "During the bake, `--renew-way-back --token-env VAR` replaces only the stored credential for the kept remote. It requires the developer token, moves no refs and does not fetch. `--push-back` pushes the project's branch back to the old baseline now (as each landing does), and `--end-bake` forgets the old baseline and its token once the bake has passed.",
    },
    {
      group: "Projects", line: 1, slot: 20,
      form: "projects remove NAME [--force]",
      about: "Removes a project from the index and from this machine's config. The project's repository and the ledger are kept. It is refused while work is live unless `--force` is given.",
    },
  ],
  flags: { force: true, "release-name": true, from: "--from needs the old host's remote: --from https://…/relic.git", "token-env": "--token-env needs a variable name: --token-env ARTIFACTS_TOKEN", "way-back": true, "push-back": true, "renew-way-back": true, "end-bake": true, "clear-secret": "--clear-secret needs the reason the line is safe: --clear-secret \"a test fixture's dummy key\"", quote: "--quote needs the developer's words: --quote \"clear it\"" },
  subcommands: {
    "move-host": { capabilities: ["projects.move-host.v1", "projects.way-back-renew.v1"] },
  },
  help: {
    flags: {
      "--force": "removes the project although work on it is live",
      "--release-name": "rename only: the project gives up OLD so a new project can take it",
      "--from REMOTE": "move-host: the old host's repository, an https:// URL or an absolute path",
      "--token-env VAR": "move-host: the environment variable holding a token for the old host",
      "--way-back": "move-host: keep the old host, so each landing pushes the branch back to it during the bake",
      "--renew-way-back": "move-host: replace the kept remote's credential from --token-env VAR",
      "--push-back": "move-host: push the branch back to the old host now",
      "--end-bake": "move-host: forget the old host once the bake has passed",
      "--clear-secret REASON": "move-host: clear the key-shaped lines the last refused move found, with why they are safe",
      "--quote WORDS": "move-host with --clear-secret: the developer's words that clear them",
    },
    example: "ATELIER_ACTING=claude-code/opus-5.5 atelier projects rename demo demo-site",
  },
};

export default spec;
