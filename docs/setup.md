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

## Cloudflare Access in front of the owner's pages

The owner's pages can also sit behind Cloudflare Access, so the person
reaching them has signed in with whatever the Zero Trust account asks (a
one-time code, a passkey, an identity provider) before the Worker is reached
at all. The domain's root is the public front door (`/` serves the showcase,
the owner's Home is at `/home`), and Access cannot exempt the root path alone,
so the arrangement is the other way round: the whole domain is public at the
edge, and the owner's paths are listed for Access. Access picks the
application whose path is most specific, and a policy applies to its whole
application, so this takes two self-hosted applications in the Zero Trust
dashboard, made before the secrets below so the owner is never locked out:

1. One for the server's domain with no path, covering everything, with a
   single Bypass policy that includes Everyone. The front door, `/how`,
   `/live.js`, the sign-out form and `/api/*` (the CLI and the runners send
   bearer tokens that never pass Access) reach the Worker without a prompt.
2. One for the owner's pages, with an Allow policy that includes the owner's
   email, whose destinations are these paths (with the server's own domain in
   place of atelier.zone):

   ```text
   atelier.zone/home
   atelier.zone/login
   atelier.zone/decisions
   atelier.zone/decisions/*
   atelier.zone/studio
   atelier.zone/studio/*
   atelier.zone/flow
   atelier.zone/flow/*
   atelier.zone/history
   atelier.zone/history/*
   atelier.zone/models
   atelier.zone/models/*
   atelier.zone/usage
   atelier.zone/usage/*
   atelier.zone/projects
   atelier.zone/projects/*
   atelier.zone/ui/*
   atelier.zone/p/*
   ```

   These are every path the Worker serves to the signed-in owner: Home, the
   sign-in page, Decisions, Studio, Flow, History, the
   Models and Usage pages and the Models form, the old `/projects` address and
   the showcase form under it, the task forms under `/ui`, and each project's
   area under `/p`. A new owner page needs its path added here.

Those paths then meet the sign-in at the edge. A path the list misses is
still refused by the Worker (below), with a 401 instead of Access's prompt.
Last, give the Worker the team's URL (`https://TEAM.cloudflareaccess.com`,
shown under Zero Trust's settings), the second application's audience tag (on
its overview) and the owner's email as the identity provider reports it, each
pasted at wrangler's prompt:

```bash
npx wrangler secret put CF_ACCESS_ISS
```

```bash
npx wrangler secret put CF_ACCESS_AUD
```

```bash
npx wrangler secret put CF_ACCESS_OWNER_EMAIL
```

With all three set, the Worker itself checks the `Cf-Access-Jwt-Assertion`
header Access adds to a request it let through. The token is verified with
jose against the keys the team publishes at
`https://TEAM.cloudflareaccess.com/cdn-cgi/access/certs`; its issuer and
audience must be the team and the application, and its email claim must name
`CF_ACCESS_OWNER_EMAIL`, so a token Access gave a teammate, or for another
application, does not vouch. Any route that needs a sign-in is refused without
that vouching, even a request carrying a session cookie, so the pages hold
even if the Access application stops covering the server. `/login` is behind
the check too, and takes no server token there, which closes the open token
form the 2026-10-06 audit noted.
The public pages (`/`, `/showcase`, `/how`, `/live.js`), the sign-out form and
the `/api` routes stay open in the Worker. Behind Access the owner's verified
assertion is the sign-in: `/login`, or any owner page opened without a session,
starts the thirty-day session at once, with no token form. A request from
another site starts none; the hop back from Access's own prompt gets a page
that reloads the address from the server's origin, where the session starts.
Sign out ends the session; the next owner page opened under the same Access
sign-in starts a new one. With any of the three unset the server stands as
it always has, without the second check; a value that is set but unusable,
such as an issuer without `https://`, logs a warning once rather than quietly
leaving the pages unguarded.

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
owner token. Agent tokens cannot sign in to the browser. On a server without
Cloudflare Access, signing in to the browser means pasting the owner token at
`/login`; behind Access the owner's Access sign-in starts the session itself
(above). Either way the session is a random id, sent only in the
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
paths are the defaults, `AGENTS.md`, `CLAUDE.md`, `wrangler.*` and
`.atelier/prompts/**` (`DEFAULT_PROTECTED` in `src/ledger.ts`), with the
files the checks execute.
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
that the change introduces, or fails to fix while claiming to; a behaviour
change without a test that covers it; docs or help that now contradict the
code; a breaking change to a command, route or API field without a migration;
or a visible regression on a user-facing page. A claim in a commit message
that the code does not support is a correctness defect; a blocking finding
names the file and line and what breaks, and is never style or naming;
decisions the project owner made are not defects; anything else is a
follow-up.

When the checkout is already registered locally, `init` reuses its registered
name, even if the folder has a different name. A different `--name NAME` is
refused. `atelier init --name NAME --rename-local` changes only that local
config entry and then returns. It does not rename a server project (see
[Renaming a project](owner.md#renaming-a-project)), update its title or policy, or
push a baseline. The server refuses a new project when its baseline
repository belongs to another registered project.

## Commit identity

A project's policy names the identity its commits carry (t451,
`src/commit-identity.ts`):

```sh
atelier init --commit-name "Project Owner" --commit-email 123+owner@users.noreply.github.com \
  --agent-email agents@example.com --private-email owner@personal.example
```

- `--commit-name` and `--commit-email` are the project's own name and address.
  The server refuses a missing name, an address that is not one, and an
  address Git guesses from a machine (`user@host.local`, `user@host.(none)`,
  a bare host name).
- `--agent-email`, once per address, lists the addresses agents may commit
  under beside the project's own. Nothing else is allowed by default.
- `--private-email`, once per address, declares addresses no commit may carry,
  such as the owner's personal one. Neither the project's address nor an
  agent's may be one of them.
- `--public-mirror`, once per remote, names the checkout's remotes that are
  public mirrors, such as `--public-mirror github`. A project that declares
  one must have a GitHub no-reply `--commit-email`.

Each flag replaces what is recorded; `--agent-email ""`, `--private-email ""`
or `--public-mirror ""` alone clears the list, and `--reset` drops the
identity with the rest of the policy. The fields travel in
`PUT /api/projects/NAME` as `commitName`, `commitEmail`, `agentEmails`,
`privateEmails` and `publicMirrors`, and are stored as
`policy.commitIdentity`. They raise the route level to 24
(`src/route-level.ts`): `atelier land` and the runner refuse a server below
it, since one would not record or return the identity.

Where the identity is enforced:

- **Every claim**, of a new clone or a reused one, on any machine, with or
  without a registered checkout, writes the name and address into the
  workspace's `.git/config` and keeps the policy in
  `.git/atelier-identity.json`. A write that does not read back fails the
  claim. An agent claiming for itself is refused when its environment would
  commit under another identity (`GIT_AUTHOR_EMAIL`, say).
- **A runner**, before it starts a builder, resolves the author and committer
  Git would use in the builder's own environment: `GIT_AUTHOR_*` and
  `GIT_COMMITTER_*`, then `author.*` and `committer.*`, then `user.*`, then
  `EMAIL`. A field nothing sets (Git's guess), a guessed address, a declared
  private one, or one the policy does not allow, refuses the build, naming
  the setting to fix. The task is released, not counted against the model.
- **A landing** (`atelier merge`, and `atelier land` through it) checks every
  commit it would add to the baseline: the task's own, the merge-main and
  regeneration commits made in the workspace, and the landing's merge commit,
  which it makes under the project's identity whatever the checkout or its
  environment says. Commits the baseline already holds are not read. A
  refusal names the commit and the field.
- **A public mirror** asks more: `atelier wrap --push` pushes a remote the
  policy declares in `publicMirrors` only when every commit it lacks carries
  the project's own no-reply address (`commitEmail`) as author and committer.
  An agent address allowed for landing is not thereby public, nor is another
  no-reply address. Remotes not declared are the owner's own and are pushed
  as before.

### Migrating a project from before t451

A project registered before t451 has no `policy.commitIdentity`. Until the
owner sets one, a claim warns and copies the registered checkout's identity
as before, a runner refuses to start a builder, and `atelier merge` refuses to
land, each naming the command below. To migrate:

1. Read the identity the checkout commits under: `git config user.name` and
   `git config user.email` in the project checkout.
2. Run `atelier init --commit-name NAME --commit-email EMAIL` there, adding
   `--agent-email` for each address the project's agents commit under, and
   `--private-email` for addresses that must never appear, and
   `--public-mirror` for each remote that is a public mirror. Until a remote
   is declared, `atelier wrap --push` checks it as no public mirror.
3. Claim again (`atelier claim ID`) in any open workspace, so it takes the
   identity; a runner's next claim does this itself.

History already on the baseline is grandfathered: no check reads it. A task
whose accepted revision holds commits outside the policy is refused at
landing; its builder rewrites them under an allowed identity and submits again,
or the owner allows the address with `--agent-email`.

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

## The check container's git

`atelier check --sandbox` and the landing Workflow run the checks in a
container started from the Cloudflare-managed `cloudflare/debian-trixie`
image (Node 24 on Debian Trixie slim). That image has no git, and on
2026-10-08 every test that made a repository failed with
`spawnSync git ENOENT`.

The Containers documentation offers no managed image with git, and an image
of one's own needs Docker on the deploying machine or Workers Builds: with
the `durable_object` scheduling policy CheckRunner uses, an image is either a
Dockerfile that `wrangler deploy` builds, or a digest-pinned image already
pushed to the Cloudflare registry; Docker Hub images, the Sandbox SDK's
`docker.io/cloudflare/sandbox` among them, cannot be started directly
([Image management](https://developers.cloudflare.com/containers/guides/image-management/)).

So the runner supplies git itself (`src/sandbox/tools.ts`). Before the
checked tree goes in, the Worker fetches Debian trixie's own `git` package
for amd64, pinned in the source by version, size and sha256, refuses any
bytes that do not match, and streams it into the container, which unpacks it
with `dpkg-deb -x` and runs `git --version`. The container's egress stays the
npm registry alone and it holds no credential; the Worker, not the
container, reaches Debian. The package is fetched from deb.debian.org, or
from snapshot.debian.org once the pool drops that version, and kept in the
`atelier-large` R2 bucket under its sha256 when the bucket exists, so later
runs reach neither. When no verified copy can be had, the checks still run
and each check's output begins `[atelier] this container has no git:` and
the reason; the run's state (`git`) holds git's version line or that reason.

Deploying needs nothing beyond `npm run deploy`: no image is built or pushed
and no Docker is needed. Only a production check run proves it: run
`atelier check ID --sandbox` on a task of the atelier project and see
`npm test` pass, with no `spawnSync git ENOENT` and no
`this container has no git` line.

To move to a newer git, take the size and sha256 from
`https://packages.debian.org/trixie/amd64/git/download` and the sha1 for the
snapshot URL from `https://snapshot.debian.org/mr/binary/git/VERSION/binfiles`,
and change `GIT_DEB` in `src/sandbox/tools.ts` as one.

If the owner later prefers an image with git built in, the documented way is
a named image: a Dockerfile of `FROM node:24-trixie-slim` plus
`apt-get install --no-install-recommends git`, declared under `images` in the
`containers` entry and started with `this.ctx.container.images.NAME`. Then
every `wrangler deploy` needs Docker running, or the deploy must move to
Workers Builds, which builds Dockerfiles itself.

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
