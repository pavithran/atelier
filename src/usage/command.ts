// What one command declares about itself, and the registry built from every
// command's declaration. Each command has a module of its own,
// src/usage/commands/NAME.ts, holding its help forms, flags, aliases and
// subcommands as data; src/usage/commands/index.ts, which `node
// cli/regenerate.mjs` writes, lists them all, so the CLI and the Worker read
// the same declarations and adding a command edits no shared list. The CLI's
// handler for the command lives in cli/commands/NAME.mjs, which the Worker
// never imports.
//
// Discovery reads src/usage/commands/*.ts and nothing else: the usage
// reporting modules beside it (src/usage/gateway.ts, page.ts, report.ts and
// cli/usage.mjs) are not commands and are never read as such.
//
// Subcommands belong to their command: `plan show ID` is a form of `plan`,
// declared in plan.ts with the flags it takes, and no other module may declare
// a form, subcommand or alias under another command's name.

// One form of a command, as `atelier help` prints it and the web reference
// describes it.
export interface Form {
  // The help group the form is listed under: one of HELP_GROUP_ORDER.
  group: string;
  // The printed line within the group, from 1: forms with the same number
  // share a line, and lines print in number order, with none left between.
  line: number;
  // The line is printed after an empty one.
  apart?: true;
  // The form's place within its line; forms are ordered by slot, then by
  // command name, then by their order in the module.
  slot: number;
  // The synopsis, as `atelier help` prints it.
  form: string;
  // One or two sentences for the web reference and `atelier COMMAND --help`.
  about: string;
  // Text printed in parentheses after the form in `atelier help`.
  aside?: string;
  // The CLI's usage and form list print these instead of form and about; the
  // help table and the web reference keep the plain ones.
  cli?: { form?: string; about?: string };
  // "cli": the CLI lists the form and the web reference does not.
  only?: "cli";
}

// What the parser takes for one flag: `true` marks a switch, `false` a flag
// that needs a value, and a string a flag that needs a value, with the message
// a bare one is refused with.
export type FlagSpec = boolean | string;

// What `atelier COMMAND --help` adds to the command's forms and descriptions.
export interface CommandHelp {
  // Each flag the command takes, as "--flag VALUE", and what it does. The
  // flags every command takes, --project and --as, are listed only where
  // the command gives them a meaning of their own.
  flags?: Record<string, string>;
  // One command line to copy, printed after "Example: ".
  example: string;
}

// A subcommand, the word after the command, owned by that command.
export interface Subcommand {
  // Flags this subcommand takes beyond the command's own.
  flags?: Record<string, FlagSpec>;
  // The only flags, beyond --project and --as, the subcommand accepts; its
  // handler refuses the rest of the command's flags.
  takes?: string[];
  // What `atelier COMMAND SUB --help` prints instead of the command's usage.
  usage?: string;
}

export interface CommandSpec {
  // The command's name, the word after `atelier`; the module's file name.
  name: string;
  // Other words that run the command.
  aliases?: string[];
  forms: Form[];
  // Every flag the command takes beyond --project and --as.
  flags: Record<string, FlagSpec>;
  // The command's --help; a command without one prints the general help.
  help?: CommandHelp;
  // The whole of `atelier COMMAND --help`, when it is not drawn from the forms.
  usage?: string;
  subcommands?: Record<string, Subcommand>;
  // The command takes `--` and the words after it.
  rest?: true;
  // The command runs checks locally, and its usage says what that means.
  localCheck?: true;
}

export interface CommandModule {
  // The module's path from the repository root.
  path: string;
  spec: CommandSpec;
}

export interface HelpGroupSpec {
  name: string;
  // `atelier help` leaves a blank line before this group.
  gap?: true;
  // Printed after the footer as "NAME: FORM · FORM".
  trailer?: true;
}

// The help groups, in the order `atelier help` prints them. A form names its
// group; a new group is the one change here.
export const HELP_GROUP_ORDER: HelpGroupSpec[] = [
  { name: "Sessions" },
  { name: "Setup" },
  { name: "Items" },
  { name: "Agents" },
  { name: "Owner" },
  { name: "Plans" },
  { name: "Models" },
  { name: "Projects" },
  { name: "Local" },
  { name: "Ops" },
  { name: "Docs" },
  { name: "Tokens", gap: true },
  { name: "Undo", trailer: true },
];

export interface Registry {
  // Every command, by name.
  commands: Map<string, CommandSpec>;
  // Every word that runs a command, its name or an alias, to the name.
  words: Map<string, string>;
  // The module each command was declared in.
  paths: Map<string, string>;
}

const NAME = /^[a-z][a-z-]*$/;
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1).replace(/\.[^.]*$/, "");

// The registry of the modules given, in any order. A module whose file name
// is not its command, a word two modules claim, a form or subcommand of another
// command and a group no one declared are refused, naming the source paths.
export function registerCommands(modules: CommandModule[]): Registry {
  const groups = new Set(HELP_GROUP_ORDER.map((g) => g.name));
  const words = new Map<string, string>(), owner = new Map<string, string>();
  const commands = new Map<string, CommandSpec>(), paths = new Map<string, string>();
  const sorted = [...modules].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const { path, spec } of sorted) {
    if (!spec || typeof spec.name !== "string") throw new Error(`${path}: declares no command; export default a CommandSpec`);
    const { name } = spec;
    if (!NAME.test(name)) throw new Error(`${path}: "${name}" is not a command name: lower-case words joined by hyphens`);
    if (baseName(path) !== name) throw new Error(`${path}: declares atelier ${name}; a command lives in a module named after it, ${name}`);
    for (const word of [name, ...(spec.aliases ?? [])]) {
      if (!NAME.test(word)) throw new Error(`${path}: alias "${word}" is not a command word`);
      const earlier = owner.get(word);
      if (earlier) throw new Error(`atelier ${word} is declared twice: by ${earlier} and by ${path}`);
      owner.set(word, path);
      words.set(word, name);
    }
    for (const form of spec.forms) {
      if (form.form.split(" ")[0] !== name) throw new Error(`${path}: the form "${form.form}" belongs to atelier ${form.form.split(" ")[0]}, not atelier ${name}; a form or subcommand lives in its command's module`);
      if (!groups.has(form.group)) throw new Error(`${path}: the form "${form.form}" names the help group "${form.group}", which is not one of ${[...groups].join(", ")}`);
      if (!Number.isInteger(form.line) || form.line < 1 || !Number.isFinite(form.slot)) throw new Error(`${path}: the form "${form.form}" needs a line from 1 and a slot`);
    }
    for (const sub of Object.keys(spec.subcommands ?? {})) {
      if (sub !== "" && !NAME.test(sub)) throw new Error(`${path}: "${sub}" is not a subcommand word`);
    }
    commands.set(name, spec);
    paths.set(name, path);
  }
  return { commands, words, paths };
}

export interface PlacedForm extends Form {
  command: string;
  index: number;
}

// Every form of every command, in the order `atelier help` prints them: by
// group, then line, then slot, then command name, then the module's order.
export function orderedForms(registry: Registry): PlacedForm[] {
  const rank = new Map(HELP_GROUP_ORDER.map((g, i) => [g.name, i]));
  const forms = [...registry.commands.values()].flatMap((spec) => spec.forms.map((f, index) => ({ ...f, command: spec.name, index })));
  return forms.sort((a, b) => rank.get(a.group)! - rank.get(b.group)! || a.line - b.line || a.slot - b.slot
    || (a.command < b.command ? -1 : a.command > b.command ? 1 : 0) || a.index - b.index);
}
