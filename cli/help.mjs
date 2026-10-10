// The help as the CLI prints it. src/usage.ts assembles every command's
// declaration (src/usage/commands/NAME.ts); the CLI lists the forms the web
// reference leaves out (`only: "cli"`, such as revert) and prints a form's
// `cli` text in its usage (done's outcome and --json).
import * as shared from "../src/usage.ts";
export * from "../src/usage.ts";

export const HELP_GROUPS = shared.helpGroups("cli");
export const HELP_FORMS = shared.helpForms("cli");
export const helpText = () => shared.helpText("cli");
export const REVERT_USAGE = shared.commandUsage("revert");

// Runner credentials extend specific token subcommands, each with help of its
// own, declared in src/usage/commands/token.ts.
export const TOKEN_SUBCOMMANDS = shared.COMMANDS.token.subcommands;
