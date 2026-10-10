# Models, reliability and usage

The model pool Atelier dispatches to, the record it keeps of each model's
work, the usage and balance reports from home runners, and the AI Gateway
figures that count pay-per-use calls. The README's "Costs and usage" section
gives the outline and the AI Gateway setup.

## The model pool

The Models page (`/models`) and `atelier models` hold the models Atelier
can dispatch to. Each entry names the model as its harness does, the
harness (OpenCode, Claude Code, Codex, ZCode, the Gemini CLI or
Antigravity), where it runs, its provider and, for an API, the name of the
Keychain entry on the runner's machine that holds its key. Atelier stores
that name and never a key; a form or request that carries one is refused.
A harness model (Antigravity, Codex, Claude Code) needs no key.

```text
atelier models add GLM-5.3-Flash-4_8bit --harness opencode --where home --endpoint http://studio.local:8000/v1
atelier models add claude-3-7-sonnet-20250219 --harness opencode --where cloud --provider anthropic --keychain anthropic.API_KEY
atelier models add gemini-3.1-pro --harness antigravity --where cloud
atelier models
```

A model's family (Claude, GPT, GLM, Gemini, DeepSeek, Qwen and others) is
recognised from its name, so a new release is coloured correctly on the
graph the day it appears; a name no family claims is shown as not
recognised. A runner reports what it finds for each model through
`POST /api/models/ID/status`, naming itself in `X-Atelier-Runner`: a home
model is reported only by a home runner and a cloud model only by a cloud
runner, and the Models page shows each report with the runner that made it.
Changing how a model is reached (its harness, where it runs, provider,
endpoint or Keychain entry) clears its status until it is checked again.
An endpoint carrying a query string, or a Keychain entry name that looks
like a key, is refused.

## Each model's reliability

The Models page and the Usage page show each model's record across every
project, and `GET /api/reliability` returns it. A model is named as review
independence names it, so the same model under two harnesses or a
registered alias is one record. Its work is what it held: how much was
approved at its first review by another model, how many review rounds a
merged item went through, every rejection with the note that gave its
cause, and every defect the owner traced to its accepted work. Its verdicts
are its own reviews: an approval of a revision a defect was later traced to
is contradicted, and so is a review run that never reached a verdict. Its
runs are those that failed, as the runners and the owner reported them. The
owner's approvals of its work are counted apart and are never a model's
verdict: those made on the task page, which only the signed-in owner
reaches, apart from those recorded through the API with the owner token, as
the orchestrator records them. An approval recorded before Atelier kept the
two apart is counted as unrecorded.

The record also holds the measures a comparison of models needs. The owner
adjudicates each finding of a review and records a verdict on it, which
counts the reviewer's precision: a finding confirmed or marked fixed is
kept, a refuted one was wrong, and the record shows how many of each a
reviewer has. Each task's wall-clock time is read from its events: claim to
first push, to submission, to the first verdict, to the merge, and the
rework turnaround from a rejection to the next submission, shown per model
as medians. Builder honesty counts a reported check an observed check
contradicted at the same head, and a submission whose changed paths ran
outside the task's scope. Integration cost counts the pushes that folded a
moved main into the task's fork. The Models page and the JSON route show
these measures by model and by the kind of work each item asked for, from
its plan part when there is one, else unknown.

Review precision is shown in a section of its own on the Models page, over
the last 30 days with the dates stated: for each reviewer model, the
blocking findings the owner judged (n), those confirmed or fixed, those
refuted, and the share confirmed or fixed. Each finding counts once, by its
newest verdict (`src/models/precision.ts`). Under 5 judged findings the row
shows n and says it is too few to rank. Routing reads the same figure, from
the project's own ledger, to order reviewers that already qualify: another
family than every contributor, available, allowed and offered. The
landing's reviewer and the plan tick's fallback (`pickReviewer`, which asks
the tier and then the pool in precision order), the separate tier review
(`pickTierReviewer`) and a plan's routed reviewer (`routeParts`) all ask the
more precise reviewer first, at (held + 1) / (judged + 2); a reviewer with
fewer than 5 judged orders as neutral, one half. A re-review still goes
first to the previous round's reviewer. Precision never makes a reviewer
qualify, so a same-family or paused reviewer is passed over however
precise.

```text
atelier defect t12 --note "pagination drops the last page" --found-in t19
atelier finding t12 --head SHA --index 1 --verdict confirmed --note "fixed in t19"
atelier run-report --actor opencode/glm-5.3 --role build --outcome early_stop --item t12 --project atelier
```

`atelier defect` traces a defect to the revision an item was accepted at;
the item itself does not change. `atelier finding` records a verdict on one
finding of a review, at the head the review was made at and the finding's
position in its findings, one based. A later review of the task shows the
reviewer each earlier finding, numbered as `--index` counts it, with the
owner's verdict and note, and says that a refuted finding is repeated only
with new evidence that the owner's answer is wrong, quoting the code. A run ends without a result the ledger
saw when it stalls, times out or is refused, or when the harness stops
early, stops at a permission, designs something a task already had, or
leaves a merge incomplete. The runner reports a run through `POST /api/runs`
with the owner token and its name in `X-Atelier-Runner`, as it reports
usage: the agent it ran, the role (`build` or `review`), the outcome, the
project and task when there is one, and a detail. `atelier run-report` lets
the owner record a run by hand for a run outside the runner. `bin/seed-2026-10-06`
prints the `atelier finding` and `atelier run-report` commands that record
the 2026-10-06 adjudications in `docs/data/adjudications-2026-10-06.json`;
it records the run reports only with `--apply`, since a finding's head and
position are read from its review, not from the file.

Routing reads the record only to order candidates of equal score: the share
of outcomes in a model's favour (work approved at first review, merges)
against those that are not (rejections, defects, contradicted approvals,
and every run that failed), with one of each added so a model with no
record sits at one half. The project's own track record and the registry's
evidence still decide the score.

A harness can serve another model than the one its events name: zcode
follows its app's provider settings, and served deepseek-flash while its
events said glm-5.3. The owner records what served them:

```text
atelier served deepseek-flash --recorded zcode/glm-5.3 --from 2026-10-04T16:00Z --to 2026-10-05T20:17Z --item t2 --project atelier
```

It lists the events recorded under `--recorded` from `--from` up to `--to`
on the tasks `--item` names, or on every task, and records nothing; with
`--apply` it adds an annotation of its own, an `event.served` event, for
each one not already annotated as served by that model. The annotated
event never changes, and the latest annotation of an event is the one that
counts, so a mistaken one is corrected by another. The track record, the
reliability record, the Models page and the graph count an annotated event
under the served model in the recorded harness, here `zcode/deepseek-flash`.
`bin/annotate-t95` holds the commands that correct the record for task t95;
the owner runs it, first without `--apply`.

## Usage, limits and balances

The Usage page (`/usage`) shows where each tool stands, as the home runners
last reported it with `atelier runner --usage`: one table per tool, with
its rate-limit windows (percent used, when each resets), the models it
served with requests, tokens and cost over the last 5 hours, 24 hours and
7 days, and any pay-per-use balance. Each row says which runner reported it
and when; a report older than three hours is marked stale, and a figure
past a threshold is tagged. `GET /api/usage` returns the same reports with
the thresholds and the alerts in force. A report is a status like a
model's: `POST /api/usage/TOOL` takes the owner token and the runner's
name in `X-Atelier-Runner`, and keeps one report per tool and runner.

Alerts go through the `NTFY_TOPIC` notification already used for decisions,
once per crossing: when a report first shows a figure past its threshold
the Worker sends one message and records the crossing; later reports
showing the same figure still past it send nothing, and a report showing it
back under clears the crossing, so the next time it is passed alerts
again. The thresholds are settings with defaults, each a number or `off`:

```sh
printf 80 | npx wrangler secret put USAGE_WEEKLY_PERCENT    # a weekly window past this percent
printf 90 | npx wrangler secret put USAGE_WINDOW_PERCENT    # a 5-hour window past this percent
printf 10 | npx wrangler secret put USAGE_DAILY_SPEND       # a tool's spend over 24 hours above this, in dollars
printf 10 | npx wrangler secret put USAGE_BALANCE_FLOOR     # a balance below this, in its own currency
```

A window that has already reset does not alert, whatever its last reading
was. Spend is summed over a tool's models from the cost its record carries,
so zcode, which records none, has no spend alert. Each alert and each
clearing is recorded as an event on the index Ledger.

## AI Gateway costs

Calls that runners send through Cloudflare AI Gateway are counted by
Cloudflare, not by a tool's record on a machine. Each time the Models page
or `GET /api/usage` is asked for, the Worker sends one query to the GraphQL
Analytics API (`POST https://api.cloudflare.com/client/v4/graphql`, with
`ANALYTICS_TOKEN` as a Bearer token), over the dataset
`aiGatewayRequestsAdaptiveGroups` for the gateway `AI_GATEWAY_ID` in the
account `CF_ACCOUNT_ID`, from 7 days ago, grouped by model and provider:

```graphql
{ viewer { accounts(filter: { accountTag: "ACCOUNT" }) {
  aiGatewayRequestsAdaptiveGroups(limit: 1000, filter: { datetime_geq: "SINCE", gateway: "atelier" }) {
    count dimensions { model provider }
    sum { cost uncachedTokensIn uncachedTokensOut cachedTokensIn cachedTokensOut erroredRequests }
    quantiles { durationMsP50 durationMsP90 }
} } } }
```

The Models page shows each model's calls and failed calls, tokens in and out
(uncached and cached together), cost, and the median and 90th percentile
duration with the number of calls they are taken over. A model whose calls
all cost $0 shows "not priced": the gateway records a call it could not
price as $0, so the two cannot be told apart. `GET /api/usage` returns the
same under `gateway`, and `atelier runner --usage` prints it after the
tools' own figures. Each says so when the figures are off (no
`ANALYTICS_TOKEN` or `CF_ACCOUNT_ID`), when the API refuses the query (with
its message; it answers a refusal with HTTP 200 and an `errors` list), and
when the gateway had no calls in the window.

The same query's second selection reads calls per task: it groups the
dataset by the value of each call's `task` metadata entry, asked for as
`metadataValue(key: "task")` in the selection's dimensions, because the
`metadataValue` dimension takes the entry's key as its argument and the
API refuses the query whole without it. Runners tag every pay-per-use
call with the `cf-aig-metadata` header naming the task, the role (build,
review or plan) and the runner, and a call carries at most one task
entry, so each call counts once whatever else its metadata names; a call
with no metadata, or none naming a task, has no task value and counts
under no task, and the Models page says so while there are none. A task's
value is its id alone, so the same id in two projects is one task in
these figures. The Models page shows each task's calls and failed calls,
tokens and cost under "Calls per task", and `atelier runner --usage`
prints the same lines.

The two settings that turn the figures on (`CF_ACCOUNT_ID` and
`ANALYTICS_TOKEN`) are in the README, under "AI Gateway costs".

Runners point opencode's pay-per-use providers at the gateway, each keeping
its own key: the provider's base URL becomes
`https://gateway.ai.cloudflare.com/v1/{ACCOUNT}/atelier/{provider}`, with
`deepseek` or `openrouter` (or another provider the gateway knows) as the
last segment. The gateway is authenticated, so each call also carries a
`cf-aig-authorization` header with a gateway token (a Cloudflare API token
with AI Gateway · Run on the account), which opencode reads from the
runner's environment. A `cf-aig-metadata` header, a JSON object of at most
five entries, says whose call it is; the runner sets it per run as
`CF_AIG_METADATA`, so the config reads it from the environment and every
call of one run carries the same task, role and runner
(`bin/orchestrate/run-agent.sh` sets the same variable for a hand
dispatch):

```json
{
  "provider": {
    "deepseek": {
      "options": {
        "baseURL": "https://gateway.ai.cloudflare.com/v1/ACCOUNT/atelier/deepseek",
        "headers": {
          "cf-aig-authorization": "Bearer {env:CF_AIG_TOKEN}",
          "cf-aig-metadata": "{env:CF_AIG_METADATA}"
        }
      }
    }
  }
}
```

The provider's key still goes in the provider's own header as before; the
gateway passes it through and logs the call. Subscription harnesses (Claude
Code, Codex, the Gemini CLI, ZCode on its plan) stay direct: they bill by
plan, not by call, and their limits are the windows `atelier runner --usage`
already reports.

## Speed by model

The Models page's "Speed by model" section and `atelier runner --usage`
show how fast each model worked over the last 14 days, from the ledger's
own timestamps (`src/models/speed.ts`; no new storage): a build from the
model's claim to its submission, a review from its review claim to its
verdict, and a task from its first claim to the merge, counted under the
model that claimed it first. Each is a median over the n runs that ended in
the window, with the window's dates and n beside it; a model with fewer
than 3 samples shows n and no median. The stalled share is the runs the
runners reported as stalled or timed out, of every run that ended with a
result or was reported. `GET /api/reliability` returns the record under
`speed`; a CLI talking to an older server says the server sends none.

Routing takes the record as an optional input (`speed` in
`src/plans/route.ts`), off unless a caller passes it. It orders only models
tied on score and reliability, the faster median first. Medians are put in
buckets a factor of two wide (log2 of the seconds, rounded) and compared by
bucket, so close medians count as the same pace and a few runs' noise does
not reorder models. No caller passes it yet: the plan routing in the Ledger reads one
project's events, and the speed record needs every project's, as the
reliability tie-breaker does.
