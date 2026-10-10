import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "projects",
  forms: [
    {
      group: "Projects", line: 1, slot: 10,
      form: "projects rename OLD NEW",
      about: "The project owner gives a project a new name on the server, and this machine's config entry moves to it. The ledger, the baseline repository and every fork stay where they are. The old name keeps working: the API serves it, old page links redirect, and tokens and workspaces that use it need no change. A name another project has or had, or one a removed project's ledger is kept under, is refused.",
    },
    {
      group: "Projects", line: 1, slot: 20,
      form: "projects remove NAME [--force]",
      about: "Removes a project from the index and from this machine's config. The Artifacts repository and the ledger are kept. It is refused while work is live unless `--force` is given.",
    },
  ],
  flags: { force: true },
  help: {
    flags: {
      "--force": "removes the project although work on it is live",
    },
    example: "atelier projects rename demo demo-site",
  },
};

export default spec;
