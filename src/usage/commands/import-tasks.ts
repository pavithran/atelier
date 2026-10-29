import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "import-tasks",
  capabilities: ["projects.import-tasks.v1"],
  forms: [
    {
      group: "Projects", line: 1, slot: 50,
      form: "import-tasks FILE... [--project P]",
      aside: "file a project's own task and decision files",
      about: "Use ATELIER_ACTING=H/M on the developer token; --as changes the actor and is refused. The developer files the open tasks and records the standing decisions of a project's own files, such as the docs/TASKS.md and docs/DECISIONS.md a project kept off Atelier writes. One entry a line: `- [ ] TITLE` is an open task, filed with that title; `- [x] TITLE` a finished one, not filed; `- TEXT` a standing decision; text indented two spaces or more under an entry is a task's brief or more of a decision; headings, blank lines and `<!-- comments -->` are skipped. Any other line is refused, naming it, and nothing is sent. Each file goes in one transaction, and each entry is remembered by its text, so importing the same file again changes nothing.",
    },
  ],
  flags: {},
  help: {
    flags: {},
    example: "ATELIER_ACTING=claude-code/opus-5.5 atelier import-tasks docs/TASKS.md docs/DECISIONS.md --project miqra",
  },
};

export default spec;
