import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "identity",
  capabilities: ["projects.commit-identity.v1"],
  forms: [
    {
      group: "Developer", line: 7, slot: 40,
      form: "identity [--json] [--project P]",
      about: "Prints the name and address the project's commits carry and the addresses agents may commit under beside it, as its policy records them. It writes nothing, and it fails when the policy names no identity. A script that makes a Git worktree for a task reads it here (bin/orchestrate/worktree.sh).",
    },
  ],
  flags: { json: true },
  help: {
    flags: { "--json": "prints {name, email, agentEmails} as JSON" },
    example: "atelier identity --project demo",
  },
};

export default spec;
