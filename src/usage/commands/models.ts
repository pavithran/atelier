import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "models",
  forms: [
    {
      group: "Models", line: 1, slot: 10,
      form: "models",
      about: "Lists the model pool: each model's harness, where it runs, its family and what a runner last found.",
    },
    {
      group: "Models", line: 1, slot: 20,
      form: "models add ID --harness H --where home|cloud [--provider P] [--endpoint URL] [--keychain NAME] [--alias A]... [--note TEXT]",
      about: "Adds or replaces a pool entry. Atelier never stores a key: `--keychain` names the Keychain entry that holds it, and a request that carries a key is refused. `--note` keeps a note with the entry.",
    },
    {
      group: "Models", line: 1, slot: 30,
      form: "models show ID",
      about: "Shows a pool entry with its notes, oldest first.",
    },
    {
      group: "Models", line: 1, slot: 40,
      form: "models note ID 'text' [--item tN]",
      about: "Keeps a dated note under a pool model, by its author. `--item` names the task it concerns; a note with none bears on every task the model is suggested for.",
    },
    {
      group: "Models", line: 1, slot: 50,
      form: "models remove ID",
      about: "Removes a model from the pool.",
    },
  ],
  flags: { harness: false, where: false, provider: false, endpoint: false, keychain: false, alias: false, note: false, item: false, key: false, "api-key": false, token: false },
  help: {
    flags: {
      "--harness H": "the harness that runs the model: opencode, claude-code, codex, zcode, gemini-cli or antigravity",
      "--where home|cloud": "home, a harness on a home runner; cloud, a hosted service",
      "--provider P": "the provider the harness reaches the model through; a cloud opencode model must name one",
      "--endpoint URL": "the endpoint the harness is pointed at, for a home server",
      "--keychain NAME": "the Keychain entry that holds the key; the key itself is never sent",
      "--alias A": "another name the harness reports the model under; once per alias",
      "--note TEXT": "a note kept with the entry",
      "--item tN": "the task a dated note concerns; without it the note bears on every task the model is suggested for",
    },
    example: "atelier models add gpt-6-astra --harness codex --where cloud",
  },
};

export default spec;
