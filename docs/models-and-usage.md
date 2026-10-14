# Models, reliability and usage

The cross-company rules below describe the default policy. With
`atelier init --single-family COMPANY`, building and reviewing use only that
company's models: a reviewer must be a different model from every contributor,
never a contributor under another harness. This exception also applies to
criteria review, handoffs and conflict contributors. Only that company's tier
models qualify; if none qualifies, no separate tier review is requested.
`atelier init --cross-family` restores the default; both switches record who
made them and when. See [Single-family mode](gate.md#single-family-mode).

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
recognised. The family is also what the gate's review rule reads, and what
`atelier init --single-family COMPANY` names when a project is to run on one
company's models alone (see [Single-family mode](gate.md#single-family-mode)). A runner reports what it finds for each model through
`POST /api/models/ID/status`, naming itself in `X-Atelier-Runner`: a home
model is reported only by a home runner and a cloud model only by a cloud
runner, and the Models page shows each report with the runner that made it.
Changing how a model is reached (its harness, where it runs, provider,
endpoint or Keychain entry) clears its status until it is checked again.
An endpoint carrying a query string, or a Keychain entry name that looks
like a key, is refused.

## Vendor model cards

Atelier keeps what each vendor claims about a model beside its own record
of the model's work, so the two can be compared. `atelier models card`
records a card read from a JSON file or standard input: the source's https
URL, the day it was read, its publication date when it gives one, and its
claims, each a benchmark (with its version or subset), a score and its unit,
and the conditions it was measured under: the harness or scaffold, the
effort, and any other details. The card's limitations are kept apart from
its claims.

```text
atelier models card opus-5.5 --file card.json
atelier models card --file docs/model-cards/2026-10-13.json
atelier models card opus-5.5 --withdraw c12 --reason "The vendor withdrew the page."
atelier models show opus-5.5
```

A list of cards names each card's model in `"model"`. Every card in a list
is checked before any is sent, and a card sent again is answered with the
one already recorded, so a list can be sent again after a failure. Cards are
the developer's alone, are never changed once recorded, and carry an id and
the server's time. A card that corrects a misreading names the card it
corrects (`"corrects": "c12"`), and one that replaces it with a newer source
names the card it supersedes (`"supersedes": "c12"`); both keep the old card
in the history, as a withdrawal does.

A card is filed under the key its model's name gives, from the name alone:
the harness is cut off, letter case is ignored, and a name the registry
knows (such as `claude-opus-5-5`) is its registry model (`opus-5.5`). So
`claude-code/opus-5.5` and `antigravity/opus-5.5` share one set of cards.
Pool aliases are not read: adding, moving or removing an alias, or taking a
model out of the pool and adding it back, never moves a card. A name neither
the registry nor the pool knows is kept as it is, and `atelier models card`
says so. Only cards of the same model can correct, supersede or withdraw a
card. `atelier models show` prints the cards oldest first, then the active
claims that give one benchmark different scores under the same conditions
(a conflict, with both sources) and those that differ only under different
conditions, which are not conflicts. The registry's static priors are
printed after them as priors. A card is the vendor's word, not a
measurement Atelier made: nothing that routes or suggests a model reads it.
`docs/model-cards/2026-10-13.json` holds the cards read on 2026-10-13.

## Which model does what: role assignments

The developer's judgement of which model is best at a job is kept as a role
assignment, a dated record on the index beside the pool (t622). Each names a
role (build, review, security-review, claims-review or plan), its scope
(every project, or one with `--scope`), the models in order as harness/model,
the reason, the developer's own words and the evidence it rests on, each a
task or one of its events as `PROJECT/tN` or `PROJECT/tN#SEQ`. A bare `tN` is
refused, since task ids repeat across projects, and each reference is checked
to exist. Only the developer's token records or withdraws one, and `--as`
names the harness/model that did it for them.

```text
atelier models assign security-review codex/gpt-6-astra --reason "Every blocking finding judged was real" --quote "astra does security reviews" --evidence atelier/t592 --evidence atelier/t593 --as claude-code/opus-5.5
atelier models roles
atelier models roles withdraw a1 --note "why"
```

Records are never changed. A new assignment for the same role and scope
supersedes the standing one and must name it with `--replaces aN`, so two
sessions that both saw it cannot both replace it; the same request sent again
is answered with its own record. Withdrawing the standing one returns the role
to its fallback, never to an assignment it had superseded. `atelier models
roles` lists what stands, the history with its evidence and authors, and each
role's fallback.

Who decides, strongest first:

1. The rules. A model paused, reserved or without the pool role, refused,
   not offered by a live runner, paid when paid models are not allowed, outside
   the project's policy or single-family mode, not admitted as a reviewer, of a
   contributor's family, or too small for the part is never chosen. An
   assignment orders only what passes.
2. An explicit choice for the one job: `atelier dispatch --model` or `--to`,
   a reviewer the developer names, a plan part's `prefer`, and the previous
   round's reviewer on a re-review.
3. The project's review tier (`atelier init --review-tier`). Its models
   review a protected change before the rest of the pool; an assignment orders
   the tier's models among themselves and adds none to it. A tier model
   outside the pool is still asked in the tier's order, but no assignment
   moves it ahead.
4. Assignments, most specific first: a role's own (security-review for
   security, concurrency or gate work, claims-review for docs) before review,
   and this project's before every project's. The first with an eligible
   choice is applied; one with none is skipped and the reasons say why.
5. The fallback: outcomes, review precision, reliability, speed and the
   spread across a plan, as before.

The pool's roles (build, review, plan) are eligibility; an assignment's roles
are judgement. The pool's tier (frontier, execution, budget) is informational
and no selector reads it. A plan keeps the routing it was approved with; an
assignment applies when a plan is previewed, approved or rerouted, and when
its tick picks a reviewer the routing no longer gives. Each project's ledger
holds a copy of the assignments that bear on it, sent when one changes and
with the pool. `src/models/assignments.ts` holds the rules.

## Vendor claims beside Atelier's record

The Models page and `atelier models show ID` (GET /api/models/ID/compare,
capability `models.compare.v1`) show one projection per model
(`src/models/compare.ts`): the claims of its cards in force, with their
sources and conditions, and then each role (build, review, security review,
claims review, plan, and acting for the developer) with the developer's
standing assignments of the model to it and Atelier's figures. Each figure
names its reader, its window, its numerator and denominator or its samples,
and the threshold under which no share or median is given: the readers' own
(five judged findings for precision, three samples for a median) and five
for the shares that had none. A vendor's score is never placed in a figure.
Claims are not sorted into roles, since a card names the kind of task a
claim is about and not a role; security review, claims review and planning
have no figure of their own yet, and say why.

Pairwise catches (`src/models/pairwise.ts`) count, over review precision's
window, the revisions one model approved in which another model, reviewing
the same task, head, criteria and scope, raised a blocking finding whose
latest verdict is confirmed or fixed. A pair with an unjudged finding is
pending, and one resting on a verdict from before t486 that cannot be placed
on one review is ambiguous; neither is in the denominator. The comparison,
the cards and the evidence it shows are the developer's alone, as the cards
and the role assignments are.

## Each model's reliability

The Models page and the Usage page show each model's record across every
project, and `GET /api/reliability` returns it. A model is named as review
independence names it, so the same model under two harnesses or a
registered alias is one record. Its work is what it held: how much was
approved at its first review by another model, how many review rounds a
merged item went through, every rejection with the note that gave its
cause, and every defect the developer traced to its accepted work. Its verdicts
are its own reviews: an approval of a revision a defect was later traced to
is contradicted, and so is a review run that never reached a verdict. Its
runs are those that failed, as the runners and the developer reported them. The
developer's approvals of its work are counted apart and are never a model's
verdict: those made on the task page, which only the signed-in developer
reaches, apart from those recorded through the API with the developer token, as
the orchestrator records them. An approval recorded before Atelier kept the
two apart is counted as unrecorded.

The record also holds the measures a comparison of models needs. The developer
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
blocking findings the developer judged (n), those confirmed or fixed, those
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
qualify, so a reviewer disallowed by the family policy or paused is passed over
however precise. In single-family mode, a different model of the selected
company qualifies; another company never does.

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
developer's verdict and note, and says that a refuted finding is repeated only
with new evidence that the developer's answer is wrong, quoting the code. A run ends without a result the ledger
saw when it stalls, times out or is refused, or when the harness stops
early, stops at a permission, designs something a task already had, or
leaves a merge incomplete. The runner reports a run through `POST /api/runs`
with the developer token and its name in `X-Atelier-Runner`, as it reports
usage: the agent it ran, the role (`build` or `review`), the outcome, the
project and task when there is one, and a detail. `atelier run-report` lets
the developer record a run by hand for a run outside the runner. `bin/seed-2026-10-06`
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
events said glm-5.3. The developer records what served them:

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
the developer runs it, first without `--apply`.

## Usage, limits and balances

The Usage page (`/usage`) shows where each tool stands, as the home runners
last reported it with `atelier runner --usage`: one table per tool, with
its rate-limit windows (percent used, when each resets), the models it
served with requests, tokens and cost over the last 5 hours, 24 hours and
7 days, and any pay-per-use balance. Each row says which runner reported it
and when; a report older than three hours is marked stale, and a figure
past a threshold is tagged. `GET /api/usage` returns the same reports with
the thresholds and the alerts in force. A report is a status like a
model's: `POST /api/usage/TOOL` takes the developer token and the runner's
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
`CF_AIG_METADATA`, and every call of one run carries the same task, role
and runner (`bin/orchestrate/run-agent.sh` sets the same variable for a hand
dispatch). opencode substitutes `{env:VAR}` into the config's raw text before
parsing it, so the JSON cannot go into a JSON string as it is: the opencode
adapter sets `CF_AIG_METADATA_ESCAPED`, the same object escaped for a JSON
string, and the configs `atelier runner setup` writes read that
(docs/runners.md, "What setup writes"):

```json
{
  "provider": {
    "deepseek": {
      "options": {
        "baseURL": "https://gateway.ai.cloudflare.com/v1/ACCOUNT/atelier/deepseek",
        "headers": {
          "cf-aig-authorization": "Bearer {env:CF_AIG_TOKEN}",
          "cf-aig-metadata": "{env:CF_AIG_METADATA_ESCAPED}"
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

## Admitting an outside reviewer

The developer can admit a registered model as a reviewer in one project:

```text
atelier models add Qwen3-Coder-Next --harness opencode --where home --endpoint http://ai-server:8000/v1 --alias studio-review
atelier models admit Qwen3-Coder-Next --project weblog --reason "Qualified against the full diff"
atelier models reviewers --project weblog
atelier land t21 --project weblog --reviewer opencode/studio-review
atelier models withdraw Qwen3-Coder-Next --project weblog --reason "Retiring this reviewer"
```

Admissions use the registered canonical id and its aliases, irrespective of
harness. They grant the assessor role only in that project; they grant no
builder role. Admit and withdraw both record the developer, reason and server time
in the project event history. Repeat `models admit` to readmit a model.
An unknown family or an alias that disguises another family is refused.

Each new admitted review must be from another family than **every** contributor
by default. In single-family mode it must instead come from a different model
of the selected company from every contributor; no other company qualifies.
Every admitted review must name the current head and acceptance-criteria binding. Admission does
not turn a developer-token assertion into a proved review: the model must use its
own actor token or answer a review request it claimed, as before. A recorded
review retains its admission snapshot. Withdrawal cancels outstanding requests
and refuses new verdicts; it preserves past approvals at their original head
and criteria. Readmission never revives a withdrawn claim.

Named reviewers must be registered or admitted, and eligible under project
policy. An admitted review dispatch uses the registered harness, canonical id
and home/cloud location. A live runner must offer that model and the `review`
job. For a home endpoint, configure the runner on a machine that can reach
ai-server (`atelier runner setup` reads the registered endpoint and checks its
model list). With no matching offer, landing names the unavailable model and
fails before creating a request.

Local tests mock dispatch and endpoint access. Network reachability from the
actual runner to ai-server cannot be established by those tests. Before and
after deploying this change, run a remote smoke check on a disposable project:
register the endpoint, set up a home runner that can reach it, admit the model,
request and claim a review of a passing cross-family task, and verify the
approval's head, criteria and admission snapshot. Withdraw during a second
claimed review and verify that its late verdict is refused while the first
approval remains valid. A failed smoke check blocks promotion.
