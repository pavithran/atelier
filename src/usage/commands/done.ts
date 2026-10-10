import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "done",
  forms: [
    {
      group: "Agents", line: 1, slot: 20,
      form: 'done "summary" [--sandbox]',
      about: "Pushes, runs the required checks and submits, in that order, and stops at the first step that fails, naming it. `--sandbox` runs the checks in a Cloudflare container. Its last line says `Ready for the owner` or what still blocks the task.",
      cli: {
        form: 'done "summary" [--sandbox] [--json]',
        about: "Pushes, runs the required checks and submits, in that order, and stops at the first step that fails, naming it. `--sandbox` runs the checks in a Cloudflare container. Its last line states the one outcome: `Outcome: submitted, ready for the owner`, `Outcome: checked but blocked by`, naming each blocker, or `Outcome: failed checks`, naming each failed check and any file a failed check left changed in the workspace. Above it are the head, the checks, the unresolved gates, whether it was submitted, acceptance, merge and deploy, and the owner's next action. `--json` prints the same as one object, its `outcome` field the outcome's name. Exit codes: 0 submitted and ready for the owner; 2 failed checks, nothing submitted; 3 checked but blocked, submitted with a gate still open; 1 a usage or other error; 4 a server or Artifacts step failed, with no outcome printed.",
      },
    },
  ],
  flags: { sandbox: true, summary: false, json: true },
  help: {
    flags: {
      "--sandbox": "runs the checks in a Cloudflare container instead of on this machine",
      "--json": "prints the outcome as one object; the progress goes to stderr",
    },
    example: 'atelier done "The parser takes the new form"',
  },
  localCheck: true,
};

export default spec;
