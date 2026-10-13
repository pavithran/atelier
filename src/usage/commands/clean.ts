import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "clean",
  forms: [
    {
      group: "Local", line: 1, slot: 11,
      form: "clean [--project NAME] [--dry-run]",
      about: "Removes the workspaces of merged or abandoned tasks whose HEAD is the head Atelier recorded or in main, and stale check clones. Removal is permanent, not to the Trash. A workspace with changed files, ignored files other than rebuildable output (such as a harness's logs under .scratch/ or a .env), or commits neither Atelier nor main holds is kept, and its KEEP line says why. `--dry-run` previews.",
    },
  ],
  flags: { "dry-run": true },
  help: {
    flags: {
      "--project NAME": "the project whose clones are looked at; this folder's project unless given",
      "--dry-run": "lists what would be removed and removes nothing",
    },
    example: "atelier clean --project demo",
  },
};

export default spec;
