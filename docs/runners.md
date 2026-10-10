# Runners and dispatch

A runner is a program that asks Atelier for work and runs a coding agent's
harness on it. This document holds the dispatch protocol and the home
runner's full reference. The README's "Runners" section gives the outline
and a configuration to start from.

## Dispatch

The project owner can send an open task to a kind of runner instead of
waiting for an agent to choose it: `atelier dispatch t11 --to home --agent
opencode --model glm-5.3-flash`, or "Send to an agent" on the task's page.
`--to` is `home` (a runner on one of your machines), `cloud` (a Cloudflare
container) or `any`; the agent and model are optional. Model names may carry a
`:profile` suffix, as the AI Studio's do. `atelier runner` is the home runner
(see Home runner, below). No cloud runner ships: a task sent to `cloud` waits for a
runner named `cloud:NAME`, which can be any program that speaks the two
requests below.

Runners are not sent work. A runner asks for it, describing what it can run,
with `POST /api/queue` and a body such as
`{"runner": "home:studio", "agents": [{"agent": "opencode", "models": ["glm-5.3-flash"]}]}`.
Atelier answers with the waiting tasks it may take, across every project,
oldest first, each with the name to claim under; the answer leads with
the dispatched claims that runner already holds, so a restarted runner takes
back the jobs a dead run left behind and finishes them. The runner then claims
through the ordinary atomic claim with the header `X-Atelier-Runner`; a
dispatched task refuses any claim from a different kind of runner, agent or
model, and refuses a claim with no runner at all until the owner withdraws
the dispatch. A runner that gives up releases the task, and it waits in the
queue again. `atelier queue` lists everything waiting. If a project cannot be read, the
response names it in the `X-Atelier-Incomplete` header and `atelier queue` says so.
`atelier undispatch` withdraws a dispatch while the task is open; a claimed
or submitted task keeps its dispatch, which applies again if it is released.

A runner's name is declared independently of its actor token; what a dispatch guarantees
is that the task goes to the first matching runner that asks, and to no one
else, while it waits. Names are matched and stored in lower case, so
`home:Studio` and `home:studio` are one runner. A claim belongs to the runner
that made it; after a handoff, the first runner to claim as the new owner
takes it, and the task's history records which runner that was.

A held task (claimed, or submitted and perhaps rejected) is sent back to a
runner the same way: its holder is released and the task queued in one step,
keeping its workspace and commits for the next builder. One job may be
dispatched by hand, `--job merge-main`: it sends a task whose landing
conflicted with main back to its builder, as a conflicted plan's refresh
adds a merge-main part to the plan. The dispatch names the main head the job merges
— `--head H`, or main's head as the baseline holds it — and a runner that
offers the merge-main job claims the task, merges main at that head into its
workspace (clearing the conflicted merge the landing left, which the
workspace's reset removes) and leaves the conflicts for the harness, whose
brief says to resolve each keeping both sides' behaviour and claims and
commit the merge as it stands. Then `atelier land ID` again: main is already
merged, and the landing picks up from the push. Without this a conflicted
task dead-ended outside a plan (t234): a plain rework dispatch resets the
workspace to the task's head, where the builder cannot reach main.

## Setting up a runner

Everything a runner needs to start agents ships in this repository: the four
harness adapters in `bin/harness/`, the agent rules they give every agent,
the provider catalogue in `cli/harness/providers.mjs` and `atelier runner
setup`, which writes the configs. The only things a machine adds are the
harnesses themselves and the credentials, which live in the credential store
(the macOS Keychain, the Linux Secret Service or the file `atelier login
--store` names) and never in a file this repository or setup writes.

### On a fresh machine

1. Install Node 22 or newer and clone this repository; `npm ci` in it. Put
   `cli/atelier.mjs` on the PATH as `atelier` (`npm link`, or an alias).
2. Install the harnesses this machine will run, any of: Claude Code
   (`claude`, signed in to its plan), Codex (`codex`, signed in), opencode
   (`opencode`) and Antigravity (`agy`, signed in to a Google account with
   Gemini). Setup finds each by its command on the PATH.
3. `atelier login --server https://YOUR-WORKER-ADDRESS` as the owner, the
   address of the Atelier server the runner takes work from (Setup in
   [setup.md](setup.md)); it asks for the owner's token without echo.
4. Store the keys opencode's providers need, each by the name setup prints
   (the pool entry's `--keychain` name when it gives one): `zai.API_KEY`,
   `deepseek.API_KEY` and `openrouter.API_KEY`, and `CF_AIG_TOKEN` (a
   Cloudflare API token with AI Gateway · Run) when an AI Gateway is named.
   On Linux the adapter runs without the session bus the Secret Service
   needs, so store them in the file store (`ATELIER_SECRET_STORE=file`).
   The runner gives a harness no `ATELIER_` variable, so it names its own
   `ATELIER_SECRET_STORE` and `ATELIER_CONFIG_DIR` to the opencode adapter
   as `--secret-store` and `--secrets-dir`, which reach the store alone.
   On macOS each is an item `atelier.NAME`, typed without echo:

   ```sh
   security add-generic-password -U -T /usr/bin/security -s atelier.deepseek.API_KEY -a "$USER" -w
   ```

5. For each model this machine reviews as, issue its agent token and store
   it as `agent.MODEL` (Reviewers post under their own agent token, below):

   ```sh
   atelier token issue --as codex/gpt-6-astra --project atelier --days 90 --label "home:NAME reviews"
   security add-generic-password -U -T /usr/bin/security -s atelier.agent.gpt-6-astra -a "$USER" -w
   ```

6. Name the AI Gateway the pay-per-use providers go through, if any, as
   `ATELIER_GATEWAY=ACCOUNT/GATEWAY` (or `CF_ACCOUNT_ID`, with the gateway
   `atelier`), then run setup and start the runner:

   ```sh
   ATELIER_GATEWAY=0123abcd/atelier atelier runner setup --dry-run   # what it would write
   ATELIER_GATEWAY=0123abcd/atelier atelier runner setup
   atelier runner --name home:NAME
   ```

The runner then builds tasks dispatched to any of its models and serves
reviews as any of them, so a build by one company's model and its review by
another's can both run on this machine. `atelier runner setup --config PATH`
writes the config to PATH instead; a second runner with a config of its own,
`"jobs": ["review"]`, keeps reviews from waiting behind a build (One job at a
time, below). Each config's opencode provider configs have a folder of their
own, so setting up the second runner leaves the first one's as they were.

### What setup writes

`atelier runner setup [--config PATH] [--dry-run]` reads the pool from
Atelier and looks for `claude`, `codex`, `opencode` and `agy` on the PATH.
It writes, beside the runner config (`runner.json` in the config folder
unless `--config` names another file):

- the runner config: one entry per harness found, listing the pool's home
  models for that harness, with every job including `review` and, for each
  model, `tokens` naming the Keychain entry `agent.MODEL`. No entry names a
  command, so the runner runs Atelier's adapter for each harness (The
  adapters, below). Setup refuses to overwrite a runner config that exists.
- `opencode/NAME/PROVIDER.json`, NAME the runner config's whole file name
  (`opencode/runner.json/` for `runner.json`): one opencode provider
  config per provider the opencode models use (`zai-coding`, `deepseek-api`,
  `openrouter-api`, and `ai-studio` for a local OpenAI-compatible server at
  the pool entry's endpoint), and `opencode/NAME/models.json`, the index the
  opencode adapter reads to find each model's provider, config and key name.
  The runner's default opencode command names this folder
  (`--providers`), so two runner configs never share an index.

A pool model for a harness this machine lacks is named and left out. An
opencode model is refused, and left out with the reason printed, when:

- its configured context or output limit exceeds what its provider serves.
  What is served is read from the provider where it publishes it
  (OpenRouter's model list; a local server's `/models`, through LM Studio's
  `loaded_context_length` or `max_context_length`, vLLM's `max_model_len` or
  a `context_length`), and otherwise from the dated figures in
  `cli/harness/providers.mjs` (`SERVED`). A model whose served limits cannot
  be read is refused, not guessed.
- its provider states no output limit for it (OpenRouter listing a model
  with no `max_completion_tokens`, say): the context is no bound on what a
  provider returns, so the output Atelier would configure cannot be checked.
  A local server has no output cap of its own; it generates until the
  context it serves is full, so its served output is that context.
- its context is below what the harness itself starts with
  (`HARNESS_START`: opencode's system prompt and tool definitions with room
  for the brief, 24,000 tokens), which would leave the model no room to work.

The configured limits are `CONFIGURED` in the same file for the models
Atelier knows, and what the provider serves (with output capped at 32,000
tokens and a quarter of the context) for the rest. A limit is corrected in
that file, in a change reviewed like any other.

Each generated provider config:

- names the variable its key is read from (`{env:DEEPSEEK_API_KEY}`), never
  the key;
- sends the AI Gateway metadata header, `cf-aig-metadata`, naming the run's
  task, role and runner, and, through a gateway, `cf-aig-authorization`;
- allows `git add` and `git commit` explicitly, denies `git push` and every
  `atelier` command, denies paths outside the workspace and web fetches, and
  configures no MCP server.

The metadata header needs care. opencode replaces each `{env:VAR}` in a
config's raw text before it parses the text, so a variable holding the
runner's JSON object (`{"task":"t1",...}`) inside a JSON string ends the
string at its first quote, and every config fails to parse: this broke every
opencode run on 2026-10-09. The configs therefore read
`{env:CF_AIG_METADATA_ESCAPED}`, which the opencode adapter sets to the
runner's `CF_AIG_METADATA` escaped for a JSON string; after substitution and
parsing, the header's value is the JSON object itself
(`test/harness-adapters.test.mjs` holds this).

### The adapters

`bin/harness/atelier-claude.mjs`, `atelier-codex.mjs`, `atelier-opencode.mjs`
and `atelier-agy.mjs` take the wrapper contract's six arguments (The wrapper
contract in `bin/orchestrate/README.md`); the shared code is
`cli/harness/adapter.mjs`. An entry with no `command` runs its harness's
adapter with this Node and every placeholder, so one command builds, plans
and reviews. An entry for `zcode` or `gemini-cli` still names its own
command, since no adapter ships for them; a `command` given for any harness
replaces the default.

Each adapter puts the agent rules in front of the brief (only the workspace
may be read or written; commit with plain `git add` and `git commit -m`
commands ending `Agent: HARNESS/MODEL`; never push or run `atelier`; for a
plan, write the plan file and commit nothing) and gives the whole prompt to
the harness on standard input, never as an argument. A review's prompt is the
brief and the diff, and the answer goes to the verdict file. Per harness:

| Adapter | Runs | Permissions |
| --- | --- | --- |
| `atelier-claude` | `claude -p --model claude-MODEL` (`opus-5.5` is `claude-opus-5-5`) | `--strict-mcp-config` with no server; edits accepted; Bash only for `git add`, `git commit` and other named Git, npm and Node commands; `git push`, `atelier` and the web denied; a review gets no edit tools |
| `atelier-codex` | `codex exec --model MODEL -` | no MCP server; `workspace-write` sandbox with `.git` writable for a build, `read-only` for a review, whose last message is the verdict |
| `atelier-opencode` | `opencode run --model PROVIDER/MODEL` | the provider config setup wrote (`OPENCODE_CONFIG`) and no other: an empty folder of the run's own, outside the workspace and removed as the run ends, as `HOME` and every XDG folder (`XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME`), so neither `~/.opencode` nor `~/.config/opencode` is read, with git given the owner's global git config as `GIT_CONFIG_GLOBAL` so commits keep their identity; `OPENCODE_DISABLE_PROJECT_CONFIG` and `OPENCODE_DISABLE_CLAUDE_CODE` set, `OPENCODE_CONFIG_DIR`, `OPENCODE_CONFIG_CONTENT` and `OPENCODE_PERMISSION` dropped; its key and the gateway token read from the credential store at run time and given to opencode alone |
| `atelier-agy` | `agy --model MODEL` (`gemini-3.1-pro` is `gemini-3.1-pro-high`) | `--sandbox`, the workspace its working folder; a review's answer is `agy`'s JSON `response` |

A harness that needs no key (Claude Code, Codex and Antigravity on their
plans) uses its own login. A key the opencode adapter cannot find stops the
run before opencode starts, naming the entry to store and never a value.

opencode merges the config `OPENCODE_CONFIG` names with the global one
(`~/.config/opencode`), the workspace's own (`opencode.json`, `.opencode/`)
and Claude Code's files, so without the isolation above a global MCP server
or a project's permissions would reach an Atelier run. With it, the
generated config's permissions and empty `mcp` are the run's. The run's
config folder is made under the system's temporary folder, outside the
workspace, and removed as opencode ends; its data folder is the runner's
(below).

## Home runner

`atelier runner --name home:NAME [--once] [--config PATH] [--integrate]` polls the queue every 30 seconds, claims one eligible job, and runs its configured harness. A runner offers `build`, `plan`, `merge-main`, `merge-main-task` and `merge-plan` jobs for every harness in its config, and `review` when its config lists it. A build or plan job runs the harness in the claimed workspace; a review job clones the head into a folder of its own, reads the diff and writes a verdict. The task brief is kept outside the workspace. A runner with `--integrate` runs no harness and takes no config: it offers only the `integrate` and `refresh` jobs, merging each part onto its plan's branch as `atelier/integrator`. Each opencode run also gets a data folder of its own
(`XDG_DATA_HOME`) beside the workspace, removed as the harness ends, however
it ends: opencode processes sharing `~/.local/share/opencode/opencode.db`
deadlock on it. Such a run finds its provider keys in the variables its
config entry names and in opencode's config; a key saved with
`opencode auth login` lives in the shared data folder and is not seen.
A harness does not inherit the runner's environment. It gets what a local
check gets (the toolchain's variables, such as `PATH`, `HOME`, `LANG` and
`TMPDIR`; nothing named `ATELIER_*` and nothing whose name says it holds a
token, key or secret) and the variables its config entry names in `env`. A
named variable that holds the owner's Atelier token is withheld, and the
runner says so. After a successful harness exit with a new commit,
the runner calls `finish` to push, run required checks, and submit. Failure
releases a claim only when no new commit was made. Otherwise the claim stays
in place for inspection. Two counters are kept for each project and task id,
across revision changes. The task counter never resets. Two task failures,
including harness failures and finish failures other than exit 4, skip the
task for the rest of the process. A separate counter skips it after three consecutive infrastructure failures,
including claim errors other than refusals, workspace preparation errors,
HEAD read errors after successful harness exits, and finish exit 4. This
counter resets on a task failure, success, claim refusal or validation skip. Claim refusals and validation skips do not
increase either counter. Interruptions stop the runner without updating either
counter. An infrastructure failure moves on to the next offered task in the
same poll; `--once` still handles at most one task.
Reaching either cap logs that the task needs the owner's attention; the
infrastructure message includes the reason. Project names rejected by runner
validation are skipped and remembered so other tasks
can run.
The harness, and every command the runner starts, leads a process group of
its own, and the group ends with it: when the harness exits, whether it
succeeded or failed, when its deadline passes and when the runner is
interrupted, every process left in the group gets SIGTERM, then SIGKILL after
five seconds, before the runner goes on. A process that starts a session of
its own (`setsid`) leaves the group and is not ended. SIGINT stops polling and
interrupts the active child process. A second interrupt kills every group at
once and exits.

Save a config at `~/.config/atelier/runner.json`, or select one with `--config PATH`:

```json
{
  "agents": [
    {
      "agent": "opencode",
      "models": ["GLM-5.3-Flash-4_8bit"],
      "command": ["opencode", "run", "--model", "{model}", "--file", "{brief_file}", "Read the attached task brief and complete it in {workspace}."],
      "env": ["ZAI_API_KEY"]
    },
    {
      "agent": "antigravity",
      "models": ["gemini-3.1-pro", "gpt-oss-120b"],
      "command": ["node", "/ABSOLUTE/PATH/TO/atelier/cli/agy-review.mjs", "--model", "{model}", "--brief", "{brief_file}", "--diff", "{diff_file}", "--verdict", "{verdict_file}", "--workspace", "{workspace}"]
    }
  ],
  "jobs": ["review"]
}
```

The antigravity entry names `cli/agy-review.mjs`, an adapter that runs
Antigravity's `agy` for a review: it builds one prompt from the brief and the
diff, maps Atelier's model ids to Antigravity's, writes the reply to the
verdict file, and runs `agy` sandboxed in the runner's review clone (the
owner's decision of 2026-10-06). Name the adapter by its absolute path: the
runner starts the command inside the review clone, which need not hold it.

Agent ids are `opencode`, `claude-code`, `codex`, `zcode`, `gemini-cli` or `antigravity`. Set model ids
and command arguments to match the installed harness. Commands are argv
arrays with `{model}` and `{brief_file}` placeholders. For a build job, `{workspace}` is the claimed workspace. For a plan job, `{plan_file}` is where the harness writes the plan document. For a review job, `{diff_file}` is the diff to review and `{verdict_file}` is where the harness writes its verdict. The runner invokes them directly without a shell. The example requires that
model to be configured in opencode. `env` is optional: the names of the
runner's variables this harness also gets, such as a provider key it reads or
`XDG_CONFIG_HOME`; a name starting with `ATELIER_` is refused. A runner started
from a LaunchAgent has only the variables the LaunchAgent sets, so a key named
here must be set there too. Atelier login and credentials are shared
with the ordinary CLI. Set `taskTimeoutMs` in the config to change the harness
deadline from 45 minutes, and `finishTimeoutMs` to change the whole finish
deadline from 60 minutes. Expiry ends the process group as above. A finish
timeout leaves the claim held.

A runner takes a new job only while the machine's load average is under a
limit, so a saturated machine is not handed another harness to run on top of
the rest (t403). The limit is the core count by default; set `loadLimit` to a
number to change it, and the runner holds off while the load is at or above
it, saying so on each poll it skips. The reading is the one-minute load
average, and it is checked again before each job in a poll, so finishing a
heavy job lets the load fall before another begins.

```sh
atelier runner --name home:studio
```

Add `--once` to handle at most one task and exit, including when the queue
is empty.

### Reviewers post under their own agent token

A runner's builds run under the owner token the machine holds (`atelier
login`). Its reviews do not: each review job claims the request, reads the
fork and records its verdict with the reviewing model's own agent token, so
the ledger, the task page and `atelier receipt` show the reviewer itself as
the recorder ("recorded by codex/gpt-6-astra with its own token") and the
gate counts the review as proved. A verdict the owner token recorded in a
model's name says so on the page ("recorded by the project owner with the
owner token"), which undercuts the claim that another company's model
reviewed the change independently; since 2026-10-08 (t346) a runner never
records one.

A reply the verdict parser refuses is kept, not discarded (t407): the runner
posts `review-unparsable`, which keeps the reply on the task, its last
100 KB with the reviewer and the head, and lets the request go for another
reviewer. `atelier show ID --reviews` prints the kept replies, and the
Models page counts each against the reviewer as a review that never reached
a verdict.

`tokens` in the runner config says, per model, where that model's token is
stored, never the token itself: the name of a Keychain entry (read as
`atelier.NAME`, the way `keychain` reads a model's key, through the store
`atelier login --store` names on other systems), or the path of a file under
`~/.config/atelier/` (a value with a `/`, written relative to that directory
or as `~/.config/atelier/...`), which must be readable by the user alone
(mode 0600):

```json
"tokens": {
  "gpt-6-astra": "agent.gpt-6-astra",
  "gemini-3.1-pro": "tokens/gemini-3.1-pro"
}
```

The lead developer issues and stores each reviewer's token once, as the
owner, on the machine that runs the reviews:

```sh
# Issue: bound to one actor and, here, one project; shown once.
atelier token issue --as codex/gpt-6-astra --project atelier --days 90 --label "home:studio reviews"

# Store the value it printed, by the name the config gives. In the macOS
# Keychain, typed without echo (the value never goes on a command line):
security add-generic-password -U -T /usr/bin/security -s atelier.agent.gpt-6-astra -a "$USER" -w
# Or as a file the user alone can read:
mkdir -p -m 700 ~/.config/atelier/tokens && (umask 077; cat > ~/.config/atelier/tokens/gemini-3.1-pro)
```

`atelier token ls` shows what is issued and when each expires; `atelier
token revoke ID` ends one, and the runner's next review as that model is
refused until a new token is stored. A config that carries something shaped
like a token in `tokens` is refused, and so is one that names the owner's
own credential there (`API_TOKEN`, the entry `atelier login --server URL` stores to, or
any name the store reads from `ATELIER_TOKEN`); an entry or file of another
name that turns out to hold the owner's token is refused when the job
starts, before anything is claimed, with a message naming the entry and
never the value.

The runner reads a token only when it starts a review job for that model,
by that exact name, and hands it to the CLI calls of that job alone, through
the child's environment (`ATELIER_TOKEN`), never as an argument; the harness
does not get it, and nothing the runner prints or reports carries it. An
agent token keeps its limits: it reviews only as the actor it was issued to,
so a token stored under the wrong model is refused by the server.

A model `tokens` leaves out has its review jobs refused: the runner logs
which token is missing (`no agent token for codex/gpt-6-astra: the runner
config names none under tokens["gpt-6-astra"]`, or the entry or file that
holds none) and takes no other review of that model in this process. Builds
are not affected. There is no owner-recorded fallback: a review is recorded
only by the reviewer's own token, never the owner token the runner builds
with, so a config that still carries the former `ownerRecordsReviews` option
is refused with a message saying so; take the option out and store the
missing tokens.

`atelier runner --discover` reports what each home model's harness actually
serves, which can differ from the model the pool registers. It reads the pool
from Atelier and, for each home model, the record its harness keeps (Codex's
session logs, zcode's `model_usage` table, opencode's `message` table), which
it only reads and which needs no request. It prints a table and reports each
model through the status route under the runner's name (`--name home:NAME`,
which defaults to this machine's). `--probe` also sends one short prompt per
model that can be probed (a Claude Code, zcode or Gemini API model; never a
Codex or an AI Studio model). `--dry-run` prints the table and reports
nothing. A harness that answers with a different model from the one
registered is reported as refused, with the model it served, and listed under
Mismatch. For zcode and Codex, whose records name the model the harness
chose, any other model answering after the registered one last did counts,
whether or not the pool registers it too; opencode's record names the model
each call asked for, so it is not judged this way. The runner's own opencode
runs keep their record in their own data folders, which are removed, so the
opencode record shows only opencode used outside the runner. A model with no recent
record is shown as "no recent record" and nothing is reported for it, so its
earlier status stands.

A probe of a model that needs an API key finds it by a `keychain` map in the
runner config, from the model's id to the name of its Keychain entry:

```json
"keychain": { "gemini-3.1-pro": "gemini.API_KEY" }
```

A name is looked up as `atelier.NAME` in the macOS Keychain, so this one is
the item `atelier.gemini.API_KEY` (other systems use the store `atelier login
--store` names). The map holds a name, never a key: a config that carries
something shaped like a key is refused. A key is read only by that exact name,
only for a model that is probed, and goes only into the environment of the
process that needs it. It is never printed, reported or put in a URL, and no
other Keychain entry is listed or read.

`atelier runner --usage` reports how much of each tool's allowance this
machine has used: Codex's 5-hour and weekly windows from its session logs
(percent used and when each resets), the requests and tokens zcode's
`model_usage` table records by served model, the requests, tokens and cost
opencode's `message` table records by served model, each over the last 5
hours, 24 hours and 7 days, and the DeepSeek account's balance. Each tool
goes to `POST /api/usage/TOOL` under the runner's name, the Usage page
shows them, and the Worker alerts at the owner's thresholds (see [Usage, limits and balances](models-and-usage.md#usage-limits-and-balances)). It is a one-shot command, not a step in the runner
loop: the loop polls every 30 seconds and must stay cheap, while this reads
logs that can be gigabytes and asks DeepSeek for a balance, and it is just
as useful on a machine that runs the tools but no runner. Schedule it
hourly, for example from a LaunchAgent, with `--dry-run` to see what it
would report first. Claude's plan limits and Gemini's spend have no record
on the machine, so neither is reported, and the command says so.

The DeepSeek balance needs its API key. The runner config names the
Keychain entry that holds it, as `keychain` names a model's:

```json
"balances": { "deepseek": "deepseek.API_KEY" }
```

Without the entry no balance is asked for. The key is read by that name
only and goes only into the environment of the child process that makes
the one balance call; the child prints currencies and amounts, and any key
a tool echoes back is removed from what the command prints. The report
carries counts, windows, model names, costs and balances, never a prompt,
a file name, a session id, a key or a header. Each window, model and
provider name a tool's record gives is cleaned before it is printed or
reported, as the server cleans it: that key, control characters and
anything shaped like a key are removed, and it is cut to the server's
length.

The CLI's exit codes let the runner tell a task's own failure from the
server's: 0 success, 1 a refusal or failure of the command, 2 a required
check that failed, 3 a claim the server refused, 4 the server unavailable or
a request that failed in transit (retry later). `atelier ops` has exit codes
of its own (see [Operations](owner.md#operations)).
