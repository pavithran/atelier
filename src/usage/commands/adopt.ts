import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "adopt",
  forms: [
    {
      group: "Projects", line: 3, slot: 10, apart: true,
      form: "adopt --project NAME [--as H/M]",
      aside: "a ControlPlane project moves to Atelier",
      about: "Moves a ControlPlane project to Atelier as an ordinary task: claims it and, in its workspace, writes `bin/control-plane`, inserts the text `atelier guide` prints into AGENTS.md and commits without pushing. It then lists what the finishing agent must settle.",
    },
  ],
  flags: {},
  help: {
    example: "atelier adopt --project demo --as claude-code/opus-5.5",
  },
};

export default spec;
