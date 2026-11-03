import type { CommandSpec } from '../command.ts';

const spec: CommandSpec = {
  name: "catch-up",
  capabilities: ["items.brief-criteria.v1"],
  forms: [{
    group: 'Developer', line: 2, slot: 40,
    form: 'catch-up --project P --builder H/M --reviewer H/M --accept TEXT… [--title TEXT] [--brief TEXT]',
    about: 'Carry a clean registered checkout’s direct fast-forward commits through a new task, checks, independent review and landing without resetting the checkout. Give the developer’s acceptance criteria and different builder and reviewer models. Full history is required. Waits for review; a refusal or failed check preserves the task and checkout and prints the task number for recovery.',
  }],
  flags: {
    builder: '--builder needs harness/model', reviewer: '--reviewer needs harness/model',
    accept: '--accept needs a developer acceptance criterion, once per criterion',
    title: '--title needs a task title', brief: '--brief needs the task brief',
  },
  help: {
    flags: {
      '--builder H/M': 'the model that claims the task and submits the direct commits',
      '--reviewer H/M': 'an independent model that reviews the submitted head before landing',
      '--accept TEXT': 'a developer acceptance criterion; repeat for each criterion',
      '--title TEXT': 'the title of the new task',
      '--brief TEXT': 'the brief of the new task',
    },
    example: 'atelier catch-up --project demo --builder codex/gpt-6.1-sol --reviewer claude-code/opus-5.5 --accept "The direct commits pass the project checks"',
  },
};
export default spec;
