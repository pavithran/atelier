# Orchestration scripts

The scripts a session uses to run Atelier's partner agents and to land their
work, kept here so that any session on any machine with the Atelier CLI can
use them. `docs/orchestrating.md` says when and why; this file says how to
set them up and what each does.

They find a project's registered checkout in the CLI's `config.json`
(`ATELIER_CONFIG_DIR`, default `~/.config/atelier`) and a task's workspace
under the CLI's cache (`ATELIER_CACHE`). `ATELIER_PROJECT` names the project
for `land.sh` and `queue.sh` (default `atelier`).

| Script | What it does |
| --- | --- |
| `run-agent.sh WHICH WORKSPACE OUTFILE PROMPT` | Runs an opencode agent (`glm`, `deepseek` or `openrouter:VENDOR/MODEL`) in a task's workspace, with its own data folder and empty standard input. |
| `review.sh WORKSPACE OUTBASE CONTEXT [MODEL]` | Has an Antigravity model review the task's commits in a throwaway clone where it may run commands, and writes its answer to `OUTBASE.md`. |
| `queue.sh TASK CONTEXT NOTE` | Takes this machine's landing lock for the project, merges main into the task, and hands it to `land.sh` when the merge is clean and type-checks. |
| `land.sh TASK CONTEXT NOTE` | Pushes, checks, submits, reviews, and on approval records the review, accepts and merges, then type-checks main. |
| `regen-fixtures.sh` | Rewrites the CLI's help fixtures from the CLI in the current directory. |

`atelier land` (task t187) does what `queue.sh` and `land.sh` do inside
Atelier, under a lease on the server; use it where the server's version
check allows (task t190).

## Setting up the agents

Each opencode agent runs through a small wrapper in `~/.local/bin` that reads
its key from `~/.config/api-keys/NAME.key` into its own process and points
opencode at a config that names the key's variable, never the key:

```sh
#!/bin/sh
DEEPSEEK_API_KEY="$(tr -d '\n' < "$HOME/.config/api-keys/deepseek.key")" \
OPENCODE_CONFIG="$HOME/.config/opencode/deepseek-api.json" \
exec opencode "$@"
```

| Wrapper | Config's provider | Key file | Model ids |
| --- | --- | --- | --- |
| `opencode-glm` | `zai-coding`, base URL `https://api.z.ai/api/coding/paas/v4` | `z.ai.key` | `glm-5.3` |
| `opencode-deepseek` | `deepseek-api`, base URL `https://api.deepseek.com` | `deepseek.key` | `deepseek-v4-pro` |
| `opencode-openrouter` | `openrouter-api`, base URL `https://openrouter.ai/api/v1` | `openrouter.key` | any OpenRouter id listed in the config |

Each config uses `"npm": "@ai-sdk/openai-compatible"` with
`"apiKey": "{env:VARIABLE}"`, and disables every MCP server so an agent sees
only its workspace.

Reviews run through Antigravity's CLI, `agy`, signed in to a Google account
with Gemini access; its models include `gemini-3.1-pro-high` and
`gpt-oss-120b-medium`. A runner serves the same reviews through
`cli/agy-review.mjs`; `review.sh` remains for a session without a runner.

## What the agents may and may not do

opencode refuses any read or write outside the workspace, and a refused
access can end the run silently: every brief says so, and puts what the
agent needs inside the workspace under `.scratch/`. The reviewer in
`review.sh` may run commands only inside its throwaway clone, with its
terminal sandboxed. No script pushes a project's own remotes or deploys.
