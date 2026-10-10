import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "runner",
  forms: [
    {
      group: "Local", line: 1, slot: 20,
      form: "runner --name home:NAME [--once] [--config PATH] [--integrate]",
      about: "The home runner: polls the queue every 30 seconds, claims one eligible task and runs its configured harness in the claimed workspace. Each opencode run gets a data folder of its own beside the workspace, removed when the run ends, because opencode runs that share one deadlock on its database. When the harness commits, the runner runs `finish`. `--integrate` runs no harness: it offers only the integrate and refresh jobs and merges each part onto its plan's branch as atelier/integrator. `--once` handles at most one task.",
    },
    {
      group: "Local", line: 2, slot: 10,
      form: "runner --discover [--name home:NAME] [--probe] [--dry-run] [--config PATH]",
      aside: "what each home model's harness serves",
      about: "Reports which model each home harness actually served, from the records the harness keeps, and sends the result to the server as each model's status. `--probe` also sends one short prompt to each model that can be probed; `--dry-run` reports nothing.",
    },
    {
      group: "Local", line: 3, slot: 10,
      form: "runner --usage [--name home:NAME] [--dry-run] [--config PATH]",
      aside: "each tool's windows, served models, costs and balances",
      about: "Reports how much of each tool's allowance this machine has used: Codex's 5-hour and weekly windows, the requests and tokens zcode and opencode recorded by served model over the last 5 hours, 24 hours and 7 days (with cost, for opencode), and the DeepSeek balance when the runner config names its Keychain entry. After the tools' own figures it prints what the server read of the AI Gateway: each model's calls, tokens, cost and durations, and the calls per task the runners' cf-aig-metadata tags name; then each model's speed over the last 14 days (median build, review and claim-to-merge times with n, and the share of runs that stalled). Each tool's summary goes to the server under the runner's name, for the Usage page and its alerts; `--dry-run` reports nothing. It runs once, not as part of the runner loop. Claude's plan limits and Gemini's spend have no record on the machine and are not reported.",
    },
  ],
  flags: { name: false, once: true, config: false, discover: true, probe: true, "dry-run": true, usage: true, integrate: true },
  help: {
    flags: {
      "--name home:NAME": "this runner's name; home: and this machine's host name unless given",
      "--once": "handles at most one task, then exits",
      "--config PATH": "the runner config file; runner.json in the config folder unless given",
      "--integrate": "runs no harness; offers only the integrate and refresh jobs and merges each part onto its plan's branch",
      "--discover": "reports which model each home harness served, as each model's status",
      "--probe": "with --discover, also sends one short prompt to each model that can be probed",
      "--dry-run": "prints what would be reported and reports nothing",
      "--usage": "reports each tool's windows, served models, costs and balances",
    },
    example: "atelier runner --name home:studio --once",
  },
};

export default spec;
