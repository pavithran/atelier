import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "check",
  forms: [
    {
      group: "Agents", line: 2, slot: 50,
      form: "check [--merged] [-- CMD]",
      about: "Runs each required check, or the command after `--`, in a clean clone of exactly the head Artifacts holds, measures which paths changed since the baseline, and records each result as Observed. `--merged` runs them on the would-be merge, the head merged with main as main is now, in a temporary merge commit that is never pushed; the result is recorded against both revisions, shown beside the merge preview, and goes stale when either moves. A local check runs with the caller's file access, so it can read their files and Keychain and reach the network; it is given only the environment variables toolchains need, and Atelier's tokens are redacted from its output before upload. Atelier has no sandbox for checks, so do not check code you do not trust.",
    },
  ],
  flags: { merged: true },
  help: {
    flags: {
      "--merged": "runs the checks on the head merged with main as it is now, in a temporary merge commit that is never pushed; the result is recorded against both revisions",
    },
    example: "atelier check --merged",
  },
  rest: true,
  localCheck: true,
};

export default spec;
