import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "integrated",
  forms: [
    {
      group: "Agents", line: 4, slot: 30,
      form: "integrated ID --part KEY --merge-commit SHA",
      about: "The integrator reports a verified merge of one part onto the plan's branch; the server checks the commit against the branch before recording it.",
    },
  ],
  flags: { part: false, "merge-commit": false },
  help: {
    flags: {
      "--part KEY": "the part that was merged; required",
      "--merge-commit SHA": "the full hash of the merge commit on the plan's branch; required",
    },
    example: "atelier integrated t3 --part t4 --merge-commit 0123456789abcdef0123456789abcdef01234567 --project demo",
  },
};

export default spec;
