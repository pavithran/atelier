// CLI additions stay here until the web command reference adopts them.
import * as shared from "../src/usage.ts";
export * from "../src/usage.ts";

const about = "Creates a new task that undoes a recorded merge with git revert -m1, under the normal checks and independent review. Both tasks keep a link in the ledger. Conflicts remain in the new workspace for resolution.";
export const HELP_GROUPS = [...shared.HELP_GROUPS, { name: "Undo", lines: [[{ form: "revert ID", about }]] }];
export const HELP_FORMS = [...shared.HELP_FORMS, "revert ID"];
export const COMMAND_HELP = { ...shared.COMMAND_HELP, revert: { about, example: "atelier revert t7" } };
export const REVERT_USAGE = `usage: atelier revert ID\n\n${about}\n\nEvery command also takes --project NAME and --as harness/model (or ATELIER_ACTOR); --help prints this.\n\nExample: atelier revert t7`;
export const COMMAND_USAGE = { ...shared.COMMAND_USAGE, revert: REVERT_USAGE };
export const commandUsage = (cmd) => cmd === "revert" ? REVERT_USAGE : shared.commandUsage(cmd);
export const helpText = () => `${shared.helpText()}\nUndo: revert ID`;
