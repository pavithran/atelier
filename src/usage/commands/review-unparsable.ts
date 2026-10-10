import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "review-unparsable",
  forms: [
    {
      group: "Agents", line: 3, slot: 90,
      form: "review-unparsable ID --head SHA --note TEXT --reply-file PATH",
      about: "Keeps a reviewer's reply that no verdict could be read from on the task, its last 100 KB with the reviewer and the head, and lets the review request go as review-release does. The runner calls it when the reply states no verdict; the reliability record counts the reply against the reviewer, and atelier show ID --reviews prints it.",
    },
  ],
  flags: { head: false, note: false, "reply-file": false },
  help: {
    flags: {
      "--head SHA": "the full revision the review read; required",
      "--note TEXT": "why no verdict could be read, as the parser said it; kept with the reply",
      "--reply-file PATH": "the file the harness wrote the reply to; its last 100 KB is kept; required",
    },
    example: 'atelier review-unparsable t3 --head 0123456789abcdef0123456789abcdef01234567 --note "No VERDICT line" --reply-file verdict.txt --project demo',
  },
};

export default spec;
