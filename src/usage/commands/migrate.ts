import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "migrate",
  capabilities: ["projects.move-host.v1"],
  forms: [
    {
      group: "Projects", line: 1, slot: 40,
      form: "migrate ID --from REMOTE [--ref BRANCH] [--token-env VAR] [--project P]",
      aside: "carry an open task from its Artifacts fork",
      about: "The developer carries an open task from its fork on Artifacts, or any Git remote, to its branch t/N in the project's repository on this server. The server fetches `--ref` (the project's branch unless given) and makes t/N at the head the Ledger records, which the fetched history must hold; the task keeps its holder, claim, head and acceptance. The holder's next `atelier claim` mints its Git credential. The fork's token is read from the variable `--token-env` names, never from the command line. Run `atelier projects move-host` first.",
    },
  ],
  flags: { from: "--from needs the fork's remote: --from https://…/relic-t2.git", ref: "--ref needs a branch: --ref main", "token-env": "--token-env needs a variable name: --token-env ARTIFACTS_TOKEN" },
  help: {
    flags: {
      "--from REMOTE": "the fork's repository: an https:// URL or an absolute path",
      "--ref BRANCH": "the fork's branch that holds the task's work; the project's branch unless given",
      "--token-env VAR": "the environment variable holding a token that reads the fork",
    },
    example: "ATELIER_ACTING=claude-code/opus-5.5 atelier migrate t2 --from https://artifacts.example/relic-t2.git --token-env ARTIFACTS_TOKEN --project relic",
  },
};

export default spec;
