import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "edit",
  forms: [
    {
      group: "Items", line: 1, slot: 20,
      form: "edit ID [--title TEXT] [--brief TEXT] [--scope GLOB]... [--accept TEXT]... [--non-goal TEXT]... [--stop-when TEXT]... [--next-gate TEXT]",
      about: "The project owner changes a task's title, brief, scope, acceptance criteria, non-goals, stop conditions or next gate. A flag given replaces that field, one left out keeps it, and an empty value clears it; the title cannot be cleared. A new scope is recorded in the task's history and counts at once for a project that refuses overlapping claims, which refuses a claim whose scope overlaps a claimed, submitted or accepted task's alike (a cancelled merge leaves a task accepted); an unscoped task overlaps every one. Changing the acceptance criteria (their text, order or entries) withdraws every review and open or claimed review request of the old ones, an acceptance (the task goes back to claimed) and an override of the review, and says so: a fresh review of the new criteria is needed. The same list again changes nothing. The criteria of an integrated part, or of a task being landed, cannot change.",
    },
  ],
  flags: {
    scope: '--scope needs text: atelier edit ID --scope "GLOB", once per entry, or --scope "" alone to clear',
    title: '--title needs text: atelier edit ID --title "TEXT", at most 80 characters',
    brief: '--brief needs text: atelier edit ID --brief "TEXT", or --brief "" to clear it',
    accept: '--accept needs text: atelier edit ID --accept "TEXT", once per criterion, or --accept "" alone to clear',
    "non-goal": '--non-goal needs text: atelier edit ID --non-goal "TEXT", once per entry, or --non-goal "" alone to clear',
    "stop-when": '--stop-when needs text: atelier edit ID --stop-when "TEXT", once per entry, or --stop-when "" alone to clear',
    "next-gate": '--next-gate needs text: atelier edit ID --next-gate "TEXT", or --next-gate "" to clear',
  },
  help: {
    flags: {
      "--title TEXT": "replaces the task's short title, at most 80 characters",
      "--brief TEXT": "replaces the task's brief; --brief \"\" clears it",
      "--scope GLOB": "replaces the task's scope; once per glob, or --scope \"\" alone to clear it (an unscoped task overlaps every other)",
      "--accept TEXT": "replaces the task's acceptance criteria; once per criterion, or --accept \"\" alone to clear them",
      "--non-goal TEXT": "replaces the task's non-goals; once per entry, or --non-goal \"\" alone to clear them",
      "--stop-when TEXT": 'replaces what tells the holder to stop and ask; once per entry, or --stop-when "" alone to clear it',
      "--next-gate TEXT": 'replaces the gate the task goes to next; --next-gate "" clears it',
    },
    example: 'atelier edit t3 --stop-when "The schema needs to change" --project demo',
  },
};

export default spec;
