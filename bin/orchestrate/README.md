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
| `land.sh TASK CONTEXT NOTE` | Pushes, checks, submits and reviews the head it read before the review; records the verdict with the reviewer's own summary and its findings either way, and on approval accepts at that head with NOTE on the acceptance and merges, then type-checks main. `REVIEW_MODEL` is `gemini-3.1-pro-high` (recorded as `antigravity/gemini-3.1-pro`) or `gpt-oss-120b-medium` (`antigravity/gpt-oss-120b`); any other is refused. |
| `verdict.mjs ANSWERFILE` | Reads a reviewer's answer with Atelier's own parser (`src/review/verdict.ts`) and prints the verdict and findings as JSON; `land.sh` records them. |
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

## The home runner

`atelier runner` is the process on your machine that does Atelier's model
work. It polls the server every 30 seconds, claims one job it is offered, runs
a harness (a command you configure) for it, and reports the result. The jobs
are a build (a task's part, committed in its workspace), a plan (a planner
writes a plan document) and, when the config lists it, a review. The runner
uses your Atelier login, so run `atelier login` on the machine first.

### The config file

The runner reads `runner.json` in the config folder (`ATELIER_CONFIG_DIR`,
default `~/.config/atelier`), or the file named by `--config PATH`. It is
parsed by `cli/runner-config.mjs`, which refuses the whole file on any error.

```json
{
  "jobs": ["review"],
  "agents": [
    {
      "agent": "opencode",
      "models": ["glm-5.3", "deepseek-v4-pro"],
      "command": ["/path/to/atelier-opencode", "{model}", "{brief_file}",
                  "{workspace}", "{plan_file}", "{diff_file}", "{verdict_file}"]
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `agents` | Required, nonempty. One entry per harness. |
| `agents[].agent` | The harness: `opencode`, `claude-code`, `codex`, `zcode`, `gemini-cli` or `antigravity`. Each appears once. |
| `agents[].models` | The distinct model ids this harness may serve, such as `glm-5.3`. The runner offers exactly these to the server. |
| `agents[].command` | The command as a list: an executable, then its arguments. No shell is involved. It must contain `{model}` and `{brief_file}`; the executable may not contain a placeholder. |
| `agents[].env` | Optional. Names of environment variables of the runner's own environment that this harness also receives. A name starting with `ATELIER_` is refused; a harness never gets Atelier's credentials. |
| `jobs` | Optional. Jobs offered besides building and planning, which every runner offers. List `"review"` to take reviews. |
| `keychain`, `balances` | Optional. Maps from a model id, or a provider, to the name of a Keychain entry. They name entries, never hold keys, and a key in either is refused. |
| `taskTimeoutMs`, `finishTimeoutMs` | Optional. Limits for a harness run (default 45 minutes) and for the final `finish` step (default 60 minutes). |

The placeholders a command may use, each replaced by the runner before it
starts the harness:

| Placeholder | Value |
| --- | --- |
| `{model}` | The model id from `models` that the job was given. |
| `{brief_file}` | A file holding the brief, the text the agent is to act on. |
| `{workspace}` | The task's workspace folder, a Git clone where the agent works. |
| `{plan_file}` | A plan job only: the file, inside the workspace, to write the plan document to. |
| `{diff_file}` | A review job only: a file holding the diff under review. |
| `{verdict_file}` | A review job only: the file, outside the workspace, to write the answer to. |

A placeholder the job does not use is passed as the text `undefined`, so a
wrapper must test for that word. A command with no `{plan_file}` can still
build, but the runner refuses to give it a plan job.

### The wrapper contract

A harness is any program that takes the six arguments in the order the
example config gives them:

```
WRAPPER MODEL BRIEF WORKSPACE PLAN DIFF VERDICT
```

It runs with the workspace as its current folder and no standard input, and
the job is judged by what it leaves behind:

- A build job: PLAN, DIFF and VERDICT are `undefined`. The agent edits files in
  the workspace and commits its work there, ending the message with a line
  `Agent: HARNESS/MODEL`. The harness pushes nothing; when it has committed the runner runs
  `atelier finish`. No new commit counts as a failure, and the part goes back.
  Exit with the agent's own status.
- A plan job: PLAN is a path inside the workspace. The agent writes the plan
  document, as JSON, to that file and commits nothing. The runner reads the file
  back and posts it.
- A review job: VERDICT is set. The workspace is a fresh clone of the part's
  head, DIFF holds the change, and the agent must not edit anything. The wrapper
  writes the agent's answer to the VERDICT file, which lies outside the
  workspace, in the reply format of `src/review/verdict.ts`: lines
  `VERDICT: APPROVE` or `VERDICT: REJECT`, `SUMMARY: ...` and one
  `FINDING: blocking|follow-up PATH:LINE text` line per finding, with prose
  allowed around them. A missing or unreadable answer releases the review so
  another reviewer can take it.

A harness that exits nonzero, or runs past `taskTimeoutMs`, fails the job.
The runner ends the harness's whole process group when it finishes.

Here is a generic wrapper for a harness whose command is `my-agent`, which
takes a model on its command line, reads its prompt on standard input and
prints its answer. A brief and a diff can be large, and the operating system
caps the total size of a command's arguments, so pass the prompt on standard
input where the harness accepts it, and on the command line only where it
does not:

```sh
#!/bin/sh
# my-agent-wrapper MODEL BRIEF WORKSPACE PLAN DIFF VERDICT
set -eu
model=$1 brief=$2 ws=$3 plan=${4:-undefined} diff=${5:-undefined} verdict=${6:-undefined}
cd "$ws"
if [ "$verdict" != undefined ]; then
  # Review: answer in Atelier's reply format, written outside the workspace.
  {
    cat "$brief"
    printf '\nThe change under review:\n'
    cat "$diff"
    printf '\nEdit nothing. End with VERDICT, SUMMARY and FINDING lines.\n'
  } | my-agent --model "$model" > "$verdict"
  exit $?
fi
rules="Work only in $ws. Commit your work here, ending the message with: Agent: my-agent/$model. Do not push. Run no atelier command."
if [ "$plan" != undefined ]; then
  rules="$rules This is a plan job: write the plan as JSON to ${plan#"$ws"/} and commit nothing."
fi
{ printf '%s\n\n' "$rules"; cat "$brief"; } | my-agent --model "$model"
```

Keys stay out of the config and out of the wrapper above. A harness that
needs a provider key gets it from a second, per-provider wrapper, as in
"Setting up the agents": that wrapper reads the key file into its own
process's environment and then runs the harness, so the key reaches no other
process. The main wrapper calls the per-provider wrapper instead of the
harness. Never write a key into `runner.json`, a wrapper or a plist.

### One job at a time, and the integrator

One runner process works one job at a time, and the queue gives it the oldest
eligible one, so a review can wait behind a long build. Start a second runner
under another name and the two work side by side, for example builds on one
and reviews on the other:

```sh
atelier runner --name home:mac
atelier runner --name home:mac-2
```

The name must be `home:` followed by letters, digits, dots, underscores or
hyphens. Both read the same config unless you give one a `--config PATH` of
its own. A runner always offers builds and plans; `jobs` only adds to them (it
is how a runner takes reviews). To keep a runner for reviews in practice, give
its agents only the reviewer models in a config file of its own, and start it
with that `--config PATH`.

A plan's approved parts merge onto the plan's branch only through a separate
process, the integrator, which no other runner does:

```sh
atelier runner --integrate --name home:mac-integrator
```

It runs no model and reads no config. It offers only the integrate and refresh
jobs and acts as `atelier/integrator`. Without it, a plan's parts build and
pass review and then stop. Run exactly one.

The integrator does not claim under the owner's token that `atelier login`
stored. It acts as the reserved actor `atelier/integrator`, whose claim the
server takes only through an agent token bound to that actor; a claim with
any other token is refused (`integrator_token`). Issue the token from an
owner session and start the integrator with it in `ATELIER_TOKEN`:

```sh
atelier token issue --as atelier/integrator --label integrator   # prints the token once
ATELIER_TOKEN=atl_… atelier runner --integrate --name home:mac-integrator
```

Started with the owner's token instead, the integrator is offered the jobs
all the same, every claim is refused, and it logs `runner: claim refused:
integrator_token: atelier/integrator claims only through a token bound to
it`, skips the job and integrates nothing. The token expires (30 days unless
`--days` says otherwise); an expired or revoked one fails every call, so
issue a fresh one before it lapses.

### Keeping them running

A runner started in a terminal ends with it. To keep the runner and the
integrator going across logins and crashes, give each a LaunchAgent. Save
this as `~/Library/LaunchAgents/zone.atelier.runner.plist`, replacing the
paths with your own (`launchd` does not read your shell profile, so give the
folder holding `node` in `PATH`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>zone.atelier.runner</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/atelier/cli/atelier.mjs</string>
    <string>runner</string>
    <string>--name</string>
    <string>home:mac</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/usr/bin:/bin:/Users/YOU/.local/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/YOU/Library/Logs/atelier/runner.log</string>
  <key>StandardErrorPath</key><string>/Users/YOU/Library/Logs/atelier/runner.log</string>
</dict>
</plist>
```

For the integrator, copy the file as `zone.atelier.integrator.plist` with the
label `zone.atelier.integrator`, the arguments `runner`, `--integrate`,
`--name`, `home:mac-integrator`, and its own log file. It also needs the
integrator's token (above) in `ATELIER_TOKEN`, and a plist holds no token: a
plist that names one in `EnvironmentVariables` has it on disk in the clear.
Point the plist's `ProgramArguments` at a wrapper that reads the token file
into its own process's environment and execs the runner, as the agent
wrappers in "Setting up the agents" read their keys. Make the log folder
first (`mkdir -p ~/Library/Logs/atelier`), then start and stop each one:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/zone.atelier.runner.plist
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/zone.atelier.runner.plist
```

`bootstrap` starts it now and at every login; `bootout` stops it and keeps it
stopped. After editing a plist, `bootout` and then `bootstrap` again.

To check that one is running:

```sh
pgrep -f "atelier.mjs runner"
```

It prints one process id per runner and integrator, and nothing when none
runs; `pgrep -fl` adds each command line, which shows the `--name`. Both write
to the log named in the plist (`tail -f` follows it), one line each, every
line starting `runner: `. An idle runner, with nothing offered, prints
nothing. A build job logs these lines in this order: `runner: nothing claimed`
(the first line of every build job, written before the claim is made),
`runner: claimed`, `runner: workspace reset to HEAD and untracked files
removed`, `runner: working`, `runner: committed` and `runner: submitted`, or
`runner: failed: REASON` where it stops. A build the runner takes back after
a restart (see the next paragraph) logs `runner: resumed: …` between the
reset line and `working`. A plan job logs `runner: claimed` and
the workspace reset line, then `runner: plan posted: HASH`. A failure line is
followed by the line that settles the claim: `runner: released: REASON`, or
`runner: claim preserved: REASON` (work was committed, or the state is
unknown, so the claim stays), or `runner: claim not released: REASON`. A review
job ends with `runner: reviewed: approve` or `reject`. A job that never got
its claim logs `runner: skipped: REASON` or `runner: claim refused: REASON`.
The integrator logs `runner: every part is integrated; the plan item
is submitted for the owner` when a plan's last part merges.

The log does not name the task a job is on: the lines above carry no task id.
Only the line after a job ends, `runner: reported PROJECT/ID as OUTCOME`, and
the notice `runner: PROJECT/ID needs the owner's attention after 2 failures;
skipped for this process` (3 consecutive infrastructure failures for the
other form) do. To see which task a runner holds now, run `atelier status
--project PROJECT`. `launchctl print gui/$(id -u)/zone.atelier.runner`
shows whether launchd considers the job loaded and its last exit status.
Stops and restarts. `bootout` sends the runner a termination signal, and it
ends its harness's processes before exiting; a second signal ends it at once.
A stop that kills a build whose agent had committed leaves the claim held:
the commits sit in the workspace, submitted by no one, and a build that had
committed nothing is released back to the queue (task t213 made a stopped
review release its claim the same way). The queue then offers a runner the
claims its own dead runs left behind, before any new work, so the process a
restart begins re-claims what the stopped one held: where the workspace holds
commits the server never recorded — the dead run's agent committed, and
nothing pushed or submitted them — the new run finishes them (`runner:
resumed: …`, then the push, checks and submit of `atelier finish`) without
running the model again, and where it holds none, the model builds as for any
claim. A restart therefore loses no committed work and leaves no runner
reported busy with a claim no live run holds; a resumed finish that keeps
failing leaves the claim for the owner, as any failed finish does. This needs
a server at route level 13 (the task's own raise to 6 plus the raises main
had already merged), which the runner asks for at start.

## What the agents may and may not do

opencode refuses any read or write outside the workspace, and a refused
access can end the run silently: every brief says so, and puts what the
agent needs inside the workspace under `.scratch/`. The reviewer in
`review.sh` may run commands only inside its throwaway clone, with its
terminal sandboxed. No script pushes a project's own remotes or deploys.
