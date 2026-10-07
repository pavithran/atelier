# Setup in detail

The README's "Setup" section gives the steps that take a fresh clone to a
deployed Worker and a registered project. This document holds the rest: how
the CLI stores its token and talks to the server, what agent tokens may do,
the owner's settings, notifications, push events and local development.

## Signing in

`atelier login --server URL` asks for the token (typed
without echo at a terminal, or piped in on stdin), checks it against the
server, and only then stores it and records the server, saying where. The
stored token and the recorded server are a pair: the token is sent to that
server alone, and `ATELIER_SERVER` naming another server needs
`ATELIER_TOKEN` for it. `login --server` sends the named server only a token
already given for it, `ATELIER_TOKEN` when `ATELIER_SERVER` (or else the
recorded server) names it and the stored token when the recorded server is
the one named, and otherwise asks for one; it changes nothing until that
server accepts the token, and when the server changes, the token it accepted,
`ATELIER_TOKEN` included, replaces the stored one, so the pair is never half
rewritten. `atelier login --store` names the store in use and whether it
holds a token, without showing it. The server is an `https://` address:
the token goes with every request, so a plain `http://` server, named by
`login --server`, `ATELIER_SERVER` or `config.json`, is refused before any
request is made, except on this machine (`localhost`, `127.0.0.1` or
`[::1]`), which a request never leaves.

```bash
atelier login --server https://atelier.example.com
```

The token is kept in the first of these that applies:

| System | Store |
| --- | --- |
| macOS | The Keychain, item `atelier.API_TOKEN`, through `security`. |
| Linux | The Secret Service, through `secret-tool` (service `atelier`, account `API_TOKEN`), when it is installed and a session bus is available. |
| Windows, and Linux without those | A file, `secrets.json` in `XDG_CONFIG_HOME/atelier` or `~/.config/atelier` (`%APPDATA%\atelier` on Windows), created with mode 0600. Atelier refuses to read or write it if its mode lets other users read it. |

Windows has no Credential Manager backend: reaching it from PowerShell means
compiling a wrapper with `Add-Type`, which is not tested here, so Windows
uses the file. On Windows the file's mode is not checked, because the system
reports no meaningful mode; the file sits in your own profile. Setting
`ATELIER_SECRET_STORE` to `file`, `keychain` or `secret-service` picks a
store outright. The `ATELIER_TOKEN` environment variable overrides every
store. A value is handed to a store on its standard input and never as a
command line argument, and login prints no token.

## Agent tokens

Give each agent its own token from an owner session:

```sh
atelier token issue --as codex/gpt-6-astra --project my-project --days 30 --label "Task runner"
atelier token ls
atelier token revoke ID
```

Issuing prints the token once. Set `ATELIER_TOKEN` to that value in the
agent's session. The issue command never writes it to a file. The CLI
obtains the bound actor from the server, so `--as` is optional and must
match when supplied. Tokens expire after 30 days by default; `--days`
accepts 1 through 365. Repeat `--project` to grant several projects; omitting
it grants all projects. Revocation prevents later API requests. Existing
Artifacts Git credentials have their own lifetime and are not revoked by
revoking an API token.

Only the SHA-256 hash and token metadata are stored on the server. Lists
never contain the token or its hash. Agent tokens can read their projects,
claim, push, record checks and reports, submit, hand off, release, and review
as themselves. Handoff targets must be harness/model identities other than
the project owner. Every actor who held an item counts as a contributor for
review independence, even if a Git push was first observed after handoff or
release. Recorded push contributors also remain; a push first observed while
nobody holds the item adds no one, since it was made with an earlier holder's
token. Agent tokens cannot reopen accepted work by reviewing it.
What an agent writes has a stated limit, and text over it is refused whole,
never cut: a review, handoff or release note 2,000 characters, a submit
summary 600, a report or a check's command 500, a check's output 4,000. The
head a push reports must be a commit hash.
Creating tasks, owner decisions, project settings, model
registry access, dispatch configuration and token management require the
owner token. Agent tokens cannot sign in to the browser. Signing in to the
browser with the owner token starts a session: a random id, sent only in the
cookie, whose hash the Worker stores with a thirty day expiry it enforces.
Sign out, in the rail of every page, ends the session at once. The token
itself is never a cookie. Events from agent
requests show `token proved` beside the actor; this proves identity, not the
truth of a reported result.

## The owner's actor, name and time zone

The project owner acts as the actor `owner`, and the inbox asks "What needs
you now?". To use your own actor and name, set `OWNER_ACTOR` and
`OWNER_NAME`, either as `vars` in `wrangler.jsonc` or as secrets, which keeps
them out of the configuration:

```bash
printf jo | npx wrangler secret put OWNER_ACTOR
```

```bash
printf Jo | npx wrangler secret put OWNER_NAME
```

Pages show times in UTC until `TIMEZONE` names the owner's zone, as an IANA
name; an unknown name falls back to UTC:

```bash
printf America/New_York | npx wrangler secret put TIMEZONE
```

`atelier login` asks the server for the owner's actor, so the CLI follows
whatever the Worker is set to.

## Registering a project

Run `init` inside the project checkout. Without `--protect`, the protected
paths are the defaults, `AGENTS.md`, `CLAUDE.md` and `wrangler.*`
(`DEFAULT_PROTECTED` in `src/ledger.ts`), with the files the checks execute.
`atelier guide` prints the
instructions an agent needs; paste them into the project's `AGENTS.md` or
`CLAUDE.md`.

Running `atelier init` again changes only what it names: `--title` changes the
title, `--check` replaces the required checks, `--protect` replaces the
protected paths (with the defaults), and everything not named keeps its value.
`atelier init --reset` rebuilds the policy from the options given and the
defaults, as a first init does; the project's title and creation date are kept.

`atelier init --review-bar TEXT` records what may block a review, at most
1,000 characters, with line breaks and control characters read as spaces.
Every review brief a runner serves, for a task or a plan's part, states it
before the reply format. Unset, or after `--review-bar ""`, the brief states
the default bar: block only for a correctness, security or data-loss defect
that the change introduces, or fails to fix while claiming to; a claim in a
commit message that the code does not support is a correctness defect;
decisions the project owner made are not defects; everything else is a
follow-up.

When the checkout is already registered locally, `init` reuses its registered
name, even if the folder has a different name. A different `--name NAME` is
refused. `atelier init --name NAME --rename-local` changes only that local
config entry and then returns. It does not rename a server project (see
[Renaming a project](owner.md#renaming-a-project)), update its title or policy, or
push a baseline. The server refuses a new project when its baseline
repository belongs to another registered project.

## Notifications

Set `NTFY_TOPIC` to receive an ntfy notification when submission, review or
check results put a submitted task in the owner's inbox:

```sh
printf 'TOPIC' | npx wrangler secret put NTFY_TOPIC
```

Topics on ntfy.sh are readable by anyone who knows the name. Use a long,
random topic. The notification carries the task title and the task page's
one-line decision brief, capped at 500 characters, with a link to that page.
See [ntfy publishing](https://docs.ntfy.sh/publish/) for topic and header details.

Without the setting, nothing is sent. The Ledger records at most one attempt
per task and head, including failed attempts, across restarts. Delivery runs
in the background; failures do not fail the action and are logged without
the topic. A push that withdraws acceptance does not send a notification.

## Push event setup

The Worker has a Queues consumer for `cf.artifacts.repo.pushed` notices in
the `atelier` namespace. It acts on pushes to the project's branch, the one
init registered, ignores other branches and duplicate events, and retries
failed reads.
A new push invalidates acceptance and evidence for the previous revision.
The CLI's push observation remains available when event delivery is delayed.

`bin/setup-push-events` prints what provisioning needs and nothing else. With
`--apply` it creates two queues, `atelier-push-events` and its dead-letter
queue `atelier-push-events-dead-letter`, and runs nothing more: it never
deploys the Worker and never edits `wrangler.jsonc`.

The consumer belongs in the release configuration. Add this to
`wrangler.jsonc`, alongside the other top-level keys, then deploy:

```json
"queues": { "consumers": [{ "queue": "atelier-push-events", "max_batch_size": 10, "max_retries": 5, "dead_letter_queue": "atelier-push-events-dead-letter" }] }
```

Events reach the queue only through a subscription, and a repository-level
subscription selects one repository. Every item's workspace is a separate fork
repository, so each fork needs its own subscription under the `atelier`
namespace; a fork without one has no event delivery, and only the CLI's push
observation covers it. The installed wrangler (4.147.0) has no flag for a
subscription's namespace or repository, so create those subscriptions in the
Cloudflare dashboard or through the API. `bin/setup-push-events` prints this
as a TODO rather than guessing at a command.

Queue provisioning, subscription creation, and deployment are release actions;
adding the consumer handler alone does not activate event delivery. See
[Artifacts event subscriptions](https://developers.cloudflare.com/artifacts/guides/event-subscriptions/).

## Local development

`npm run dev` serves the Worker on localhost. The Artifacts binding always
reaches the real account, even locally, so local runs create real
repositories. Pass a throwaway token with
`npx wrangler dev --var ATELIER_TOKEN:localtest`; do not write `.dev.vars`
into an iCloud project.

`npm test` runs two pools. The pure functions in `src/rules.ts` and
`src/diff.ts` are tested by `node --test` (`test/*.test.ts`). The
`test/*.spec.ts` files run inside the Workers runtime through the Workers
test pool, against the Ledger Durable Object with its real SQLite storage
and no network access; `tsc -p test` typechecks them against the types
`wrangler types` generates. Workerd logs each refusal those tests assert as
an uncaught promise rejection (`uncaught exception … 409|owned|…`); those
lines are the refusals under test, not failures.

## Local visual review

Run `node test/preview.mjs` for a local, read-only preview with illustrative
content. It prints its URL. The preview cannot approve, merge, or create live
tasks. Use `?state=empty`, `/p/atelier/t1?state=failed`, `state=ready`,
`state=accepted`, `state=merged`, `state=unavailable`, or `state=long` to inspect
important states. The pages follow the device's light or dark setting;
change that setting to inspect the other palette.

The prompt for the visual composition is
`.impeccable/mocks/decisions.prompt.txt`; the image it produced,
`.impeccable/mocks/decisions.png`, is kept out of the repository by
`.gitignore`. Product intent lives in `PRODUCT.md`; the implemented visual system
is recorded in `DESIGN.md`.
