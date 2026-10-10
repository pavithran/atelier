// CLI additions stay here until the web command reference adopts them.
import * as shared from "../src/usage.ts";
export * from "../src/usage.ts";

const about = "Creates a new task that undoes a recorded merge with git revert -m1, under the normal checks and independent review. Both tasks keep a link in the ledger. Conflicts remain in the new workspace for resolution.";
export const HELP_GROUPS = [...shared.HELP_GROUPS, { name: "Undo", lines: [[{ form: "revert ID", about }]] }];
export const REVERT_USAGE = `usage: atelier revert ID\n\n${about}\n\nEvery command also takes --project NAME and --as harness/model (or ATELIER_ACTOR); --help prints this.\n\nExample: atelier revert t7`;

// src/usage.ts is the shared help; done's outcome, exit codes and --json are added here.
const DONE_FORM = 'done "summary" [--sandbox]', DONE_FORM_JSON = 'done "summary" [--sandbox] [--json]';
const DONE_LAST_LINE = "Its last line says `Ready for the owner` or what still blocks the task.";
const DONE_JSON = "prints the outcome as one object; the progress goes to stderr";
const DONE_OUTCOME = "Its last line states the one outcome: `Outcome: submitted, ready for the owner`, `Outcome: checked but blocked by`, naming each blocker, or `Outcome: failed checks`, naming each failed check and any file a failed check left changed in the workspace. Above it are the head, the checks, the unresolved gates, whether it was submitted, acceptance, merge and deploy, and the owner's next action. `--json` prints the same as one object, its `outcome` field the outcome's name. Exit codes: 0 submitted and ready for the owner; 2 failed checks, nothing submitted; 3 checked but blocked, submitted with a gate still open; 1 a usage or other error; 4 a server or Artifacts step failed, with no outcome printed.";
const DONE_USAGE = shared.commandUsage("done")
  .replace(DONE_LAST_LINE, DONE_OUTCOME)
  .replace(`${DONE_FORM}\n`, `${DONE_FORM_JSON}\n`)
  .replace(/^(  --sandbox .*)$/m, `$1\n  --json     ${DONE_JSON}`);
const DONE_HELP = { ...shared.COMMAND_HELP.done, flags: { ...shared.COMMAND_HELP.done.flags, "--json": DONE_JSON } };

export const HELP_FORMS = [...shared.HELP_FORMS.map((form) => form === DONE_FORM ? DONE_FORM_JSON : form), "revert ID"];
export const COMMAND_HELP = { ...shared.COMMAND_HELP, done: DONE_HELP, revert: { about, example: "atelier revert t7" } };
export const COMMAND_USAGE = { ...shared.COMMAND_USAGE, done: DONE_USAGE, revert: REVERT_USAGE };
export const commandUsage = (cmd) => cmd === "revert" ? REVERT_USAGE : cmd === "done" ? DONE_USAGE : shared.commandUsage(cmd);
export const helpText = () => `${shared.helpText()}\nUndo: revert ID`;
