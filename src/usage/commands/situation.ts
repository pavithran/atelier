import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "situation",
  forms: [
    { group: "Developer", line: 2, slot: 6, form: "situation [--project P] [--json]", about: "One read of where the project stands, every field a recorded fact: each live task (state, holder, runner, head, scope, stage and how long at it, the last check), core-file holds, open review requests with reviewer and age, runners (last poll, current job, served projects, offered models, the commit they run; flagged when silent 5 minutes, on a commit other than the server's, or never polled), landings, blocks and whose words lift them, the check limits and mode, standing decisions, free disk where the server runs (a warning under 10 percent) and recorded spend. Text for a person, `--json` for a model." },
  ],
  flags: { json: true },
  help: {
    flags: {
      "--json": "the same read as one JSON object, for a model; every refusal is {code, detail, next}",
    },
    example: "atelier situation --project demo --json",
  },
};

export default spec;
