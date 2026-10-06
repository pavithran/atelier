// The CLI's printed text, as data, in one place. cli/atelier.mjs prints it
// (`atelier help`, `atelier COMMAND --help`, `atelier guide`) and src/how.ts
// draws the same table on the public How it works page, so the two cannot
// differ. Every form carries a description for that page; the CLI prints only
// the forms, and test/fixtures/cli pins what it prints byte for byte.

import { FILING_RELAY } from "./sessions.ts";

export interface Command {
  // The synopsis, as `atelier help` prints it.
  form: string;
  // One or two sentences for the web reference. Not printed by the CLI.
  about: string;
  // Text printed in parentheses after the form in `atelier help`.
  aside?: string;
}

export interface HelpGroup {
  name: string;
  // `atelier help` leaves a blank line before this group.
  gap?: true;
  // Each inner array is one printed line; its forms are joined with " · ".
  lines: Command[][];
}

export const HELP_TITLE = "atelier — one owner per item, observed evidence, the project owner decides.";

export const HELP_GROUPS: HelpGroup[] = [
  { name: "Sessions", lines: [[
    { form: "unwrap [--project P]", about: "Reads where the project stands, the state of this checkout, where its branch stands against each of the checkout's remotes as last fetched or pushed, the newest session note, the state file (the first of `docs/STATE.md`, `STATE.md` and `PROJECT.md` that exists) and any dated handoffs. It fetches and writes nothing. The project owner's session starts here." },
    { form: 'wrap "summary" [--next TEXT] [--found TEXT]... [--push] [--no-check | --allow-failing] [--project P]', about: "Closes the owner's session in the registered checkout: runs the registered checks and, when every one passes, commits everything with the summary as its subject, updates the baseline and records a session note on the ledger. A failing check refuses the commit, naming each failed check with how it ended, and leaves the checkout, the ledger and every remote as they were; `--allow-failing` commits anyway, and the note records which checks it let through. Check results are Reported, because they ran on the owner's machine. `--push` also pushes the checkout's own remotes; `--found` files a task for each defect found; `--no-check` skips the checks." },
  ]] },
  { name: "Setup", lines: [[
    { form: "login --server URL", about: "Stores this server's address and the owner's token, asking for the token when none is stored for it. A token the server refuses is not stored." },
    { form: "login --store", about: "Names the token store in use and whether it holds a token. It never prints the token." },
    { form: "init [--title TEXT] [--check CMD]... [--declare-read-only TEXT] [--protect GLOB]... [--sandbox-only] [--approval TEXT] [--reset] [--history-since YYYY-MM-DD]", about: "Run by the project owner in the project checkout: creates the baseline repository in Artifacts, pushes the current branch to it, and records that branch as the project's branch, the required checks, the protected paths and an optional title. Run again, it changes only what it names. Every check must be read-only: a command that deploys, installs, publishes, pushes or spends money is refused, a known build or test command is read-only by its words, and `--declare-read-only` records the owner's reason for the others. `--reset` rebuilds the policy from the defaults; `--history-since` gives a project too large for Artifacts a baseline with its recent history only." },
    { form: "sync", about: "Refreshes the stored policy from the project's ControlPlane files. For a baseline built with `--history-since`, it also carries commits made in the checkout outside Atelier to the baseline." },
    { form: "publish", about: "Pushes the registered branch to the baseline with a write token. It is refused for a baseline that holds only part of the history; `sync` does that job." },
  ], [
    { form: "notes-remote [REMOTE | --off]", about: "Names a git remote that receives `refs/notes/atelier`, the merge provenance, and only that ref, on every merge. `--off` stops it; with no argument it says what is set. The setting is kept on this machine." },
  ]] },
  { name: "Items", lines: [[
    { form: 'new "title" [--scope GLOB]...', about: "The project owner creates an item with a title and, optionally, the globs it intends to touch." },
    { form: "ls [--all] [--json]", about: "Lists the project's items with state, owner and head. Merged and abandoned items need `--all`. `--json` prints them for scripts, each item with its created, updated and last-push times, as Observatory reads them." },
    { form: "show ID", about: "Prints an item's decision brief: what is decided, the recorded evidence, a recommendation and the item's address. `--json` prints it for scripts." },
    { form: "owners [--json]", about: "Prints one line per live item: its state, its owner and since when." },
    { form: "inbox", about: "Prints the decision brief of each item that needs the project owner, most urgent first." },
    { form: "status [--project P] [--json]", aside: "with a project: where it stands, as text", about: "Prints the owner's queue for every project: what waits for the owner, what is in progress and what waits for a runner. With `--project` it prints where one project stands instead, ending with whether this checkout is in step with the baseline. `--json` prints machine-readable records, each item with its created, updated and last-push times, as Observatory reads them." },
    { form: "open", about: "Opens the server in a browser, using the macOS `open` command." },
  ]] },
  { name: "Agents", lines: [[
    { form: "start ID [--as H/M]", about: "Claims the item, prepares its workspace as `claim` does, and prints its title, scope and any dispatch note." },
    { form: 'done "summary"', about: "Pushes, runs the required checks and submits, in that order, and stops at the first step that fails, naming it. Its last line says `Ready for the owner` or what still blocks the item." },
  ], [
    { form: "claim ID --as H/M [--runner home:NAME]", about: "Takes ownership of an item, forks the baseline into the item's workspace, mints a write token for the claimant alone, clones the workspace and records the project's branch as the one it pushes to. Claiming again refreshes the token and that branch, saying when the branch changed. `--runner` names the runner when a runner claims a dispatched task." },
    { form: "finish [--sandbox] [--summary T]", about: "Run in the claimed workspace: pushes, runs the required checks and submits, only if they pass and the workspace has not changed meanwhile. `--sandbox` runs the checks in a Cloudflare container. `done` is `finish` with a required summary." },
    { form: "push", about: "Pushes the workspace to the item's fork, then asks the Worker to read the head from Artifacts. The ledger records the head Atelier saw, not the one the agent named. It refuses, pushing nothing, when the workspace's branch is not the one the fork's HEAD names, since Atelier reads only that one. After `update`, `--force` pushes with a lease." },
    { form: "update", about: "Rebases the workspace onto whatever has merged to the baseline since the fork, then names the next step, `atelier push --force`, whose lease refuses to overwrite anything pushed since the workspace last fetched." },
    { form: "check [--sandbox | -- CMD]", about: "Runs each required check, or the command after `--`, in a clean clone of exactly the head Artifacts holds, measures which paths changed since the baseline, and records each result as Observed. `--sandbox` runs them in a Cloudflare container instead. A local check runs with the caller's file access, so it can read their files and Keychain and reach the network; it is given only the environment variables toolchains need, and Atelier's tokens are redacted from its output before upload. Run untrusted code with `--sandbox`." },
    { form: "report [ID] \"…\" [--item ID]", about: "Records a Reported claim at the current head: what the agent verified and how. It goes on the item named, else on the workspace's item; in a workspace, another item's id needs `--item ID`. It is shown and never counted as a check." },
    { form: "submit [--summary T]", about: "Marks the item ready for the owner and prints what still blocks it, if anything. `--summary` stores a summary of the change with the submission." },
  ], [
    { form: "handoff ID --to H/M", about: "Moves ownership to another agent, with `--note` saying why. The old write token is revoked; the workspace and its history carry over." },
    { form: "release ID", about: "Gives the item up: it returns to open and the write token is revoked." },
    { form: "diff ID", about: "For a reviewer: prints the item's commits and diff against the baseline, from a clean read-only clone." },
    { form: "review ID --approve|--reject", about: "Records a verdict on the item's current head, with `--note` giving the reason. The rules say whose approval counts." },
  ]] },
  { name: "Owner", lines: [[
    { form: "accept ID [--override-review REASON]", about: "The project owner accepts the item at its current head. It is refused unless the gate is clear. When the change still lacks its independent review because no reviewer qualifies, `--override-review` overrides that review and accepts: the reason is required, the override is recorded as an event of its own, never as a review, and the task page and the inbox show it with its reason." },
    { form: "merge ID [--head SHA [--approve] [--override-review REASON]] [--policy-changed-ok]", about: "The project owner lands the accepted head in the registered checkout and publishes the merge to the baseline. With `--head`, a submitted item is accepted at that exact revision first: `--approve` records the owner's review, which is not the independent review, and `--override-review` accepts with the owner's override, as `accept` does. Run again, it resumes an interrupted merge; `--cancel` ends one." },
    { form: "abandon ID", about: "Closes the item without merging it. The write token is revoked; the history and evidence stay." },
  ], [
    { form: "approve ACTION --head SHA [--note T] [--expires 24h]", about: "The project owner approves one protected action, such as `deploy`, `install`, `push`, `paid-run` or `photos-writeback`, at one exact revision of the main line: the full SHA of a commit the baseline holds. `atelier ship` uses the approval once, at that revision only, and a later revision needs its own. It stands for 24 hours unless `--expires` gives from `1m` to `30d`; `--note` records why. Any other kind must be one the project's ship files name." },
    { form: "approvals [--all]", about: "Lists the approvals that stand, each with its kind, revision and expiry. `--all` adds the used, withdrawn and expired ones." },
    { form: "approvals withdraw ID [--note T]", about: "The project owner withdraws an approval no ship has used, so none can use it." },
  ], [
    { form: "ship [--dry-run] [--push]", about: "Run by the project owner in the registered checkout, clean and at the baseline's head: composes the ship order from the project's ControlPlane ship policy and adapter, or from `docs/atelier/ship.json`, and refuses before running anything when a protected step has no approval at that revision, naming the command that approves it. It then runs the steps in order and stops at the first that fails, recording each step's command, exit status, duration and redacted output tail on the ledger. It pushes only with `--push` and an approval for `push`, and never forces a push. `--dry-run` prints the steps and which approvals are present or missing, and runs nothing." },
  ]] },
  { name: "Models", lines: [[
    { form: "models", about: "Lists the model pool: each model's harness, where it runs, its family and what a runner last found." },
    { form: "models add ID --harness H --where home|cloud [--provider P] [--endpoint URL] [--keychain NAME] [--alias A]...", about: "Adds or replaces a pool entry. Atelier never stores a key: `--keychain` names the Keychain entry that holds it, and a request that carries a key is refused." },
    { form: "models remove ID", about: "Removes a model from the pool." },
  ], [
    { form: "dispatch ID [--to home|cloud|any] [--agent A] [--model M] [--note T]", about: "Queues an open item for a kind of runner, and optionally an agent and model, instead of waiting for an agent to choose it. Project owner only." },
    { form: "undispatch ID", about: "Takes the item out of the queue." },
    { form: "queue", about: "Lists everything waiting for a runner, across projects, oldest first." },
  ]] },
  { name: "Projects", lines: [[
    { form: "projects rename OLD NEW", about: "The project owner gives a project a new name on the server, and this machine's config entry moves to it. The ledger, the baseline repository and every fork stay where they are. The old name keeps working: the API serves it, old page links redirect, and tokens and workspaces that use it need no change. A name another project has or had, or one a removed project's ledger is kept under, is refused." },
    { form: "projects remove NAME [--force]", about: "Removes a project from the index and from this machine's config. The Artifacts repository and the ledger are kept. It is refused while work is live unless `--force` is given." },
    { form: "init --name NAME --rename-local", about: "Changes only this machine's local name for the registered checkout. Nothing on the server changes." },
  ], [
    { form: "adopt --project NAME [--as H/M]", aside: "a ControlPlane project moves to Atelier", about: "Moves a ControlPlane project to Atelier as an ordinary task: claims it and, in its workspace, writes `bin/control-plane`, inserts the text `atelier guide` prints into AGENTS.md and commits without pushing. It then lists what the finishing agent must settle." },
  ]] },
  { name: "Local", lines: [[
    { form: "gc [--project NAME] [--dry-run | --apply]", about: "Previews the local workspace and check clones that are safe to remove; `--apply` removes them. It never touches Artifacts or the project checkout." },
    { form: "runner --name home:NAME [--once] [--config PATH]", about: "The home runner: polls the queue every 30 seconds, claims one eligible task and runs its configured harness in the claimed workspace. Each opencode run gets a data folder of its own beside the workspace, removed when the run ends, because opencode runs that share one deadlock on its database. When the harness commits, the runner runs `finish`. `--once` handles at most one task." },
  ], [
    { form: "runner --discover [--name home:NAME] [--probe] [--dry-run] [--config PATH]", aside: "what each home model's harness serves", about: "Reports which model each home harness actually served, from the records the harness keeps, and sends the result to the server as each model's status. `--probe` also sends one short prompt to each model that can be probed; `--dry-run` reports nothing." },
  ], [
    { form: "runner --usage [--name home:NAME] [--dry-run] [--config PATH]", aside: "each tool's windows, served models, costs and balances", about: "Reports how much of each tool's allowance this machine has used: Codex's 5-hour and weekly windows, the requests and tokens zcode and opencode recorded by served model over the last 5 hours, 24 hours and 7 days (with cost, for opencode), and the DeepSeek balance when the runner config names its Keychain entry. Each tool's summary goes to the server under the runner's name, for the Usage page and its alerts; `--dry-run` reports nothing. It runs once, not as part of the runner loop. Claude's plan limits and Gemini's spend have no record on the machine and are not reported." },
  ]] },
  { name: "Ops", lines: [[
    { form: "ops COMMAND [ARGS...]", aside: "portfolio operations, run by the private atelier-ops toolkit when installed", about: "Hands everything after `ops` to the private `atelier-ops` toolkit, named by `ATELIER_OPS` or found on `PATH`. Without one it says so and exits 2." },
  ]] },
  { name: "Docs", lines: [[
    { form: "guide", aside: "paste into a project's AGENTS.md", about: "Prints the instructions an agent needs, to paste into a project's AGENTS.md or CLAUDE.md. `atelier adopt` inserts the same text." },
  ]] },
  { name: "Tokens", gap: true, lines: [[
    { form: "token issue --as H/M [--project P]... [--days N] [--label TEXT]", about: "The project owner issues a token bound to one actor and shown once. It expires in 30 days unless `--days` (1 to 365) says otherwise, and covers the named projects or all of them." },
    { form: "token ls", about: "Lists token records without the tokens or their hashes." },
    { form: "token revoke ID", about: "Revokes a token; later API requests with it are refused. Git credentials already issued keep their own lifetime." },
  ]] },
];

export const HELP_FOOTER = "Common flags: --project NAME, --as harness/model (or ATELIER_ACTOR). A switch such as --approve, --json or --sandbox-only is on when named alone. It takes the word true or false after it and never any other word: --sandbox-only false or --sandbox-only=false turns it off.";

// What `atelier help` prints, without the final newline.
export function helpText(): string {
  const out: string[] = [HELP_TITLE, ""];
  for (const group of HELP_GROUPS) {
    if (group.gap) out.push("");
    group.lines.forEach((line, i) => {
      const lead = i === 0 ? group.name.padEnd(11) : " ".repeat(11);
      out.push(lead + line.map((c, j) => (c.aside ? `${c.form}${j === line.length - 1 ? "   " : " "}(${c.aside})` : c.form)).join(" · "));
    });
  }
  out.push(HELP_FOOTER);
  return out.join("\n");
}

// Every form the help prints, in order.
export const HELP_FORMS: string[] = HELP_GROUPS.flatMap((g) => g.lines.flat().map((c) => c.form));

// What the usage of every command that runs checks locally says about them.
const LOCAL_CHECK = "A local check runs on this machine with your file access: it can read your files and your Keychain and reach the network. It is given only PATH, HOME and the few other environment variables toolchains need, and Atelier's tokens are redacted from its output before it is uploaded. Run untrusted code in the sandbox: atelier check --sandbox, atelier finish --sandbox, or a project set up with atelier init --sandbox-only.";

// Per-command usage lines, shown by --help/-h and by a bad subcommand. The
// forms the synopsis shows are the ones the help table prints, so the two
// cannot drift; a line may add what a failure needs to name (a subcommand,
// the flags the help's form leaves to its description).
export const COMMAND_USAGE: Record<string, string> = {
  unwrap: "usage: atelier unwrap [--project P]",
  wrap: 'usage: atelier wrap "summary" [--next TEXT] [--found TEXT]... [--push] [--no-check | --allow-failing] [--project P]',
  login: "usage: atelier login --server URL · atelier login --store",
  new: 'usage: atelier new "title" [--scope GLOB]...',
  ls: "usage: atelier ls [--all] [--json] [--project P]",
  status: "usage: atelier status [--project P] [--json]",
  start: "usage: atelier start ID [--as harness/model]",
  done: `usage: atelier done "summary"\n${LOCAL_CHECK}`,
  finish: `usage: atelier finish [--sandbox] [--summary T]\n${LOCAL_CHECK}`,
  check: `usage: atelier check [--sandbox | -- CMD]\n${LOCAL_CHECK}`,
  gc: "usage: atelier gc [--project NAME] [--dry-run | --apply]",
  review: "usage: atelier review ID --approve|--reject [--note TEXT] [--as harness/model]",
  handoff: "usage: atelier handoff ID --to H/M [--note TEXT]",
  merge: "usage: atelier merge ID [--head SHA [--approve] [--override-review REASON]] [--policy-changed-ok] · merge ID --cancel [--discard-local]",
  token: "usage: atelier token issue --as H/M [--project P]... [--days N] [--label TEXT] · token ls · token revoke ID",
  adopt: "usage: atelier adopt --project NAME [--as harness/model]",
  models: "usage: atelier models · models add ID --harness H --where home|cloud [--provider P] [--endpoint URL] [--keychain NAME] [--alias A]... · models remove ID",
  runner: "usage: atelier runner --name home:NAME [--once] [--config PATH] · runner --discover [--name home:NAME] [--probe] [--dry-run] [--config PATH] · runner --usage [--name home:NAME] [--dry-run] [--config PATH]",
  projects: "usage: atelier projects remove NAME [--force] · projects rename OLD NEW",
  report: 'usage: atelier report [ID] "what you verified and how" [--item ID] [--project P]   (in a workspace, ID is its item unless --item or --project says otherwise)',
  approve: "usage: atelier approve ACTION --head SHA [--note T] [--expires 24h] [--project P]   (ACTION: deploy, install, push, paid-run, photos-writeback, or a kind the project's ship files name; --expires from 1m to 30d)",
  approvals: "usage: atelier approvals [--all] [--project P] · approvals withdraw ID [--note T] [--project P]",
  ship: "usage: atelier ship [--dry-run] [--push] [--project P]   (in the registered checkout, clean and at the baseline's head)",
};

// The text `atelier guide` prints, and, without its heading, the section
// `atelier adopt` inserts into a project's AGENTS.md. Kept in one place so the
// two cannot drift apart.
export function guideText(): string {
  return `## Working through Atelier

Several agents may work on this project at once. Each piece of work is an
item with exactly one owner. Never edit the project checkout directly.

1. \`atelier start ID --project NAME --as HARNESS/MODEL\` claims the task
   and prints its workspace, title, scope and note. Work only there.
2. Commit your changes, then run \`atelier done "summary"\` in that workspace.
   It pushes, runs required checks and submits only after they pass. Relay
   its final line to the owner. The project owner accepts and merges.
3. \`atelier inbox\` and \`atelier show ID\` print briefs you can relay to the owner.
4. \`atelier ls --project NAME\` lists tasks. Ask the owner to create one if needed.
5. Individual steps remain available: \`atelier claim\`, \`atelier push\`,
   \`atelier check\` and \`atelier submit --summary "summary"\`.
   \`atelier report "…"\` records a Reported claim, never an Observed pass.
6. If you can't finish, \`atelier handoff ID --to HARNESS/MODEL --note "…"\`
   or \`atelier release ID\`. Your write token is revoked either way.
7. Reviewing someone else's item: \`atelier diff ID\`, then
   \`atelier review ID --approve|--reject --note "…"\`. Changes to protected
   paths need approval from a model of another family than every agent
   that worked on the item.
8. \`atelier update\` rebases your workspace onto whatever has merged since.

For each session the project owner runs in the registered checkout:

1. Start a session with \`atelier unwrap --project NAME\`; relay its short paragraph.
2. End with \`atelier wrap "summary" --next "what is next"\` in the registered checkout. It runs the registered checks, commits, and always updates Atelier's own copy of the project, the baseline. A failing check stops it before anything is committed: fix the check, or add \`--allow-failing\` to commit anyway and record in the note which checks failed. It never pushes the project's own remotes unless \`--push\` is given; add \`--push\` only with the owner's approval for that session. It never deploys or publishes a release.
3. ${FILING_RELAY} Use repeatable \`--found TEXT\` on wrap to file tasks in this project.

A protected action (a deploy, a device install, a push to the project's own
remotes, a paid model run or a Photos writeback) runs only with the project
owner's approval for one exact revision of the main line, given with
\`atelier approve KIND --head SHA\` and used once. \`atelier ship\`, run in
the registered checkout when the owner asks, runs the project's ship order,
uses those approvals and records every step. Never approve an action for the
owner, and never run one without the owner's approval at that revision.

Session notes keep metadata only, never prompts, transcripts or file contents.
Material for the owner to copy is one complete fenced block with a language
tag: bash for a command the owner runs, text for prose, a brief or an envelope.
Never leave prose the owner must select by hand. Save a copy under
~/Documents/ai-project-data/<project>/, never the portfolio root.
`;
}
