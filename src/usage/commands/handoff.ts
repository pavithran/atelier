import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "handoff",
  forms: [
    {
      group: "Agents", line: 3, slot: 10,
      form: "handoff ID --to H/M [--note TEXT]",
      about: "Moves ownership to another agent, with `--note` saying why. The old write token is revoked; the workspace and its history carry over. The project owner can hand an accepted task back to building: it becomes claimed, with its earlier reviews and acceptance kept in the history, and must be submitted and accepted again. A merge holding its landing lease must finish or be cancelled first.",
    },
  ],
  flags: { to: false, note: false },
  help: {
    flags: {
      "--to H/M": "the agent that takes the task",
      "--note TEXT": "why; kept with the handoff and shown to the next holder",
    },
    example: 'atelier handoff t3 --to codex/gpt-6-astra --note "Out of time; the tests are in test/parser"',
  },
};

export default spec;
