import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "gc",
  forms: [
    {
      group: "Local", line: 1, slot: 10,
      form: "gc [--project NAME] [--dry-run | --apply]",
      about: "Previews the local workspace and check clones that are safe to remove; `--apply` removes them. It never touches Artifacts or the project checkout.",
    },
  ],
  flags: { "dry-run": true, apply: true },
  help: {
    flags: {
      "--project NAME": "the project whose clones are looked at; this folder's project unless given",
      "--dry-run": "lists what would be removed and removes nothing",
      "--apply": "removes the workspace and check clones that are safe to remove",
    },
    example: "atelier gc --project demo --apply",
  },
};

export default spec;
