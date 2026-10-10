import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "notes-remote",
  forms: [
    {
      group: "Setup", line: 2, slot: 10,
      form: "notes-remote [REMOTE | --off]",
      about: "Names a git remote that receives `refs/notes/atelier`, the merge provenance, and only that ref, on every merge. `--off` stops it; with no argument it says what is set. The setting is kept on this machine.",
    },
  ],
  flags: { off: true },
  help: {
    flags: {
      "--off": "stops pushing refs/notes/atelier to a remote",
    },
    example: "atelier notes-remote origin --project demo",
  },
};

export default spec;
