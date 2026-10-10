#!/usr/bin/env node
// atelier — the command agents and the project owner run. No dependencies: Node and git.
//
// Agents work in a workspace clone under ~/Library/Caches, never in the iCloud
// checkout. Checks run in a second, clean clone of exactly the head Atelier
// sees in Artifacts. Session checks run in the registered checkout and are
// Reported; one that fails stops wrap before it stages anything, unless
// --allow-failing is given. Wrap commits and updates the baseline; checkout
// remote pushes are opt-in.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { constants as osConstants, homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import { cleanSession, stateFile, handoffNotes, staleState, fileExcerpt, sessionNoteText, UNWRAP_RELAY, FILING_RELAY, sessionText, sessionCommitMessage, wrapRelay, WRAP_MARKERS, unmergedPaths, wrapRefusal, failingChecksRefusal, failingChecksOverridden } from "../src/sessions.ts";

import { contextBudget, evaluateCeilings, policyNotice, CONTEXT_BUDGET_PATH } from "../src/context-budget.ts";

import { redactGitArgs } from "./runner.mjs";
import { acceptancePolicy, controlPlaneChanges, mergeContext, mergePolicyDecision, shipChanges } from "../src/control-plane.ts";
import { cleanSummary } from "../src/brief.ts";
import { VERDICT_LIMITS } from "../src/review/verdict.ts";
import { assertEligible, checkApplies, checkFiles, pathCollisions, recordedText } from "../src/rules.ts";
import { ROUTE_LEVEL } from "../src/route-level.ts";
import { holdText } from "../src/dispatch/rules.ts";
import { adapterCheckPaths, adapterClasses, appliesText, checkClasses, classText, knownReadOnly, refusalOf, refusalText } from "../src/checks.ts";
export { controlPlaneChanges, mergePolicyDecision } from "../src/control-plane.ts";

import { adoption, SCOPE, writeMove } from "./adopt.mjs";
import { runLand } from "./land.mjs";
import { runRevert } from "./revert.mjs";
import { adoptOldLanding, executablePaths, hooksOff, landingDir, landingJournal, landingJournalFile, landingLeft, landingLock, landingSymlinks, oldLandingJournalFile, RECEIPT_TEMPLATE, RECEIPTS_DIR, touchedExecutables, treeEntries } from "./landing.mjs";
import { buildHistory, carryTask, loadPairs, rebuild, savePairs, syncHistory } from "./fresh.mjs";
import { pushHistory } from "./push-steps.mjs";
import { applyIdentity } from "./identity.mjs";
import { collectCache, markerPath } from "./gc.mjs";
import { formatLocal, formatStatus, formatStatusBrief, itemJson, statusJson, taskLink } from "./status.mjs";
import { formatTokenExpiryWarnings, parseExpiryDay, readTokenExpiries, recordTokenExpiryDay, TOKEN_EXPIRY_WARN_DAYS } from "./token-expiry.mjs";
import { receiptJson, receiptText } from "./receipt.mjs";
import { describeStore, promptSecret, readSecret, writeSecret } from "./credentials.mjs";
import { checkEnv } from "./check-env.mjs";
import { coreCount, envLoad, formatLoad, loadLimitOf, waitForLoad } from "./load.mjs";
import { provenanceNote } from "./provenance.mjs";
export { checkEnv } from "./check-env.mjs";
import { COMMAND_USAGE, guideText, helpText, ROLES, rolePrompt } from "./help.mjs";
import { planText } from "../src/plans/show.ts";
import { ACTION_KINDS, DEFAULT_EXPIRY, KIND, REVISION, expirySeconds } from "../src/actions.ts";
import { decisionLines, decisionsSection } from "../src/decisions.ts";
import { formatApprovals, knownKinds, runCommand, ship as runShip, shipPolicy, shipSecrets } from "./ship.mjs";

const HOME = homedir();
const CONFIG_DIR = process.env.ATELIER_CONFIG_DIR ?? join(HOME, ".config", "atelier");
const CONFIG = join(CONFIG_DIR, "config.json");
const CACHE = process.env.ATELIER_CACHE ?? join(HOME, "Library", "Caches", "ai-projects", "cloudflare-git");
const CHECK_TIMEOUT_MS = Number(process.env.ATELIER_CHECK_TIMEOUT ?? 20 * 60_000);
const CLI_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
// The one line --version prints, wherever it stands, ops included.
const VERSION_LINE = `atelier ${CLI_VERSION} (route level ${ROUTE_LEVEL})`;

// ── plumbing ───────────────────────────────────────────────────────────────

let doneStep;
// Each check the run recorded: { claim, result, where }, read into done's outcome.
const doneChecks = [];
const CLEAN_CLONE = "in a clean clone on this machine", CONTAINER = "in a Cloudflare container";

function die(msg, code = 1) {
  if (doneStep) msg = `${doneStep} failed: ${msg}`;
  process.stderr.write(`atelier: ${msg}\n`);
  process.exit(code);
}

function loadConfig() {
  try { return JSON.parse(readFileSync(CONFIG, "utf8")); } catch { return { server: null, projects: {} }; }
}
function saveConfig(c) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
}

// The token and the server `login` is checking, before either is saved.
let loginToken = null, loginServer = null;

const trimSlash = (url) => String(url).replace(/\/$/, "");

// ATELIER_TOKEN wins, for whichever server is in use: the environment is the
// user's own setting, for an agent's session or as an override. Otherwise the
// store for this system (see credentials.mjs) holds the token `login` stored
// once the server config.json names accepted it. Login writes the two
// together, so that server is the one the stored token belongs to, and the
// token goes nowhere else: with ATELIER_SERVER naming another server it is
// not sent, and the command says what to do instead.
function apiToken() {
  if (loginToken) return loginToken;
  const fromEnv = process.env.ATELIER_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  let token;
  try { token = readSecret("API_TOKEN"); } catch (error) { die(error.message); }
  if (!token) die("no API token: run `atelier login --server URL` to store one, or set ATELIER_TOKEN");
  const home = cfg.server ? trimSlash(cfg.server) : null;
  if (server() !== home) {
    die(home
      ? `the stored token was accepted by ${home} and is sent only there; for ${server()} run atelier login --server ${server()}, or set ATELIER_TOKEN`
      : `the stored token has no server on record (config.json names none); run atelier login --server ${server()}, or set ATELIER_TOKEN`);
  }
  return token;
}

// The store's own token, whatever ATELIER_TOKEN holds: readSecret answers
// with the environment first, and `login` needs to know what is stored.
function storedToken() {
  try { return readSecret("API_TOKEN", { env: { ...process.env, ATELIER_TOKEN: "" } }); } catch (error) { die(error.message); }
}

// The environment a git command runs with. Artifacts has no Git LFS: a push
// would try to upload a project's LFS objects and fail, so every push to
// Atelier skips the upload and Artifacts holds pointer files. A clone, always
// a disposable copy (a task workspace, a check run), keeps the pointers rather
// than trying to download what they point to. Nothing else skips the download:
// a merge or reset in the owner's own checkout writes real LFS files as
// git-lfs would. `ownerRemote` marks a push to one of the owner's own remotes
// (wrap --push). Those remotes need the project's LFS objects, so the upload
// runs: GIT_LFS_SKIP_PUSH is left out whatever the caller's environment holds,
// and a remote that has the commits without their LFS objects is never
// reported as pushed.
export function gitEnv(base = process.env, extra = {}, args = [], ownerRemote = false) {
  const env = { ...base, GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_PUSH: "1", ...(args.includes("clone") ? { GIT_LFS_SKIP_SMUDGE: "1" } : {}), ...extra };
  if (ownerRemote) delete env.GIT_LFS_SKIP_PUSH;
  return env;
}

// opts.token is an Artifacts token this one command sends as its
// Authorization header (see auth). It is cut from any error text shown.
// opts.hooks === false runs the command with every hook off (hooksOff in
// cli/landing.mjs), as each Git command of a landing runs (landingGit).
function git(args, opts = {}) {
  let off = {};
  if (opts.hooks === false) { try { off = configEnv(hooksOff(opts.cwd, gitEnv(process.env, {}, args))); } catch (error) { die(error.message); } }
  const env = { ...off, ...(opts.token ? auth(opts.token, { ...process.env, ...off }) : {}), ...opts.env };
  const r = spawnSync("git", args, { encoding: "utf8", cwd: opts.cwd, env: gitEnv(process.env, env, args, opts.ownerRemote === true), input: opts.input, maxBuffer: 256 * 1024 * 1024 });
  const shown = redactGitArgs(args);
  // git itself did not run: the folder it was to run in is missing, it is
  // not on PATH or not executable, or its output overran the buffer. There
  // is no exit status, so the error is the detail and the command ends; a
  // caller that takes failures gets the result and judges it, as it would a
  // probe of a folder that may not be there.
  if (r.error) {
    if (opts.allowFail) return r;
    const why = r.error.code !== "ENOENT" ? r.error.message : opts.cwd && !existsSync(opts.cwd) ? `the folder ${opts.cwd} does not exist` : "git was not found on PATH";
    die(`git ${shown.join(" ")} could not run: ${why}`);
  }
  let detail = (r.stderr || r.stdout || "").trim();
  for (const [i, arg] of args.entries()) {
    if (shown[i] === "[redacted]") detail = detail.split(arg).join("[redacted]");
  }
  if (opts.token) detail = detail.split(opts.token).join("[redacted]");
  if (r.status !== 0 && !opts.allowFail) die(`git ${shown.join(" ")} failed:\n${detail}`);
  return opts.allowFail ? r : opts.raw ? r.stdout : r.stdout.trim();
}

// Tokens go in a per-command header, never in a remote URL or the iCloud
// tree, and reach git through its environment (GIT_CONFIG_COUNT,
// GIT_CONFIG_KEY_n, GIT_CONFIG_VALUE_n), never through its arguments: every
// local user can read a process's arguments with ps, but only its own user
// and root can read its environment. The header takes the next free index, so
// configuration the caller's environment already passes this way still holds.
export function auth(token, base = process.env) {
  return configEnv([["http.extraHeader", `Authorization: Bearer ${token}`]], base);
}

// Settings given to git through its environment, as [key, value] pairs, at
// the indexes after those the caller's environment already uses.
function configEnv(settings, base = process.env) {
  const n = Number.parseInt(base.GIT_CONFIG_COUNT ?? "", 10) || 0;
  const env = { GIT_CONFIG_COUNT: String(n + settings.length) };
  settings.forEach(([key, value], i) => { env[`GIT_CONFIG_KEY_${n + i}`] = key; env[`GIT_CONFIG_VALUE_${n + i}`] = value; });
  return env;
}

// The runner for a landing's Git commands in the owner's checkout (merge,
// merge --cancel and sync): every hook is off, so no hook runs while the
// landing changes the checkout, whatever the accepted change put in a hooks
// folder or a file a hook runs. Each of those commands declares
// `const git = landingGit`, so every Git command in it, and in the helpers it
// passes `git` to, runs this way.
const landingGit = (args, opts = {}) => git(args, { ...opts, hooks: false });

// A workspace keeps its write token in a file of its own,
// .git/atelier-credentials, which only this user can read (0600) and which
// .git/config includes. The CLI writes that file itself, so the token is
// never an argument to git: git config only adds the include and removes any
// header .git/config holds directly. The file is replaced whole, through a
// rename, so a reader sees the old token or the new one, never part of
// either. A newline in the remote or the token would start a new setting in
// the file, so either is refused.
const CREDENTIALS = "atelier-credentials";
function storeWorkspaceToken(dir, remote, token) {
  if (/[\n\r\0]/.test(remote + token)) die("the server sent a workspace remote or token with a line break; nothing was stored");
  const quote = (s) => `"${s.replace(/[\\"]/g, "\\$&")}"`;
  const file = join(dir, ".git", CREDENTIALS), tmp = `${file}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, `[http ${quote(remote)}]\n\textraHeader = ${quote(`Authorization: Bearer ${token}`)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  // Exit status 5 means .git/config held no such header.
  const unset = git(["config", "--local", "--unset-all", `http.${remote}.extraHeader`], { cwd: dir, allowFail: true });
  if (unset.status !== 0 && unset.status !== 5) die(`could not remove the workspace's old header from .git/config:\n${unset.stderr.trim()}`);
  const includes = git(["config", "--local", "--get-all", "include.path"], { cwd: dir, allowFail: true }).stdout.split("\n");
  if (!includes.includes(CREDENTIALS)) git(["config", "--local", "--add", "include.path", CREDENTIALS], { cwd: dir });
}

// The write token's expiry, recorded beside the workspace at every claim, so
// atelier land can refresh the token before it lapses mid-landing (t275).
// The server keeps no expiry it can answer later: the claim's answer is the
// only place it is given. A server that sends none records nothing.
function recordTokenExpiry(dir, expiresAt) {
  if (typeof expiresAt === "string" && expiresAt) git(["config", "--local", "atelier.write-token-expires-at", expiresAt], { cwd: dir });
}

// Every flag each command takes, and what it takes. `true` marks a switch:
// it never takes the word after it, so `review --approve t2` reviews t2 and
// `merge --cancel t1` cancels t1; the only values a switch accepts are the
// words true and false, as --flag=false or --flag false. Any other entry
// marks a flag that needs a value: a bare one is refused, so a forgotten
// value is never sent as the text "true" (a required check named true, a
// handoff to the actor true, the project true). `false` refuses it with the
// general message; a string is the message for that flag. A flag outside
// the command's row is refused before the command runs. --project and --as
// belong to every row, since project() and actor() read them, and --help and
// --version anywhere print usage and the version. The commands in REST take
// `--` and the words after it.
// test/command-help.test.mjs holds this table to the help in src/usage.ts.
export const COMMON = { project: false, as: false };
export const FLAGS = {
  unwrap: {},
  wrap: { next: false, found: false, push: true, "no-check": true, "allow-failing": true },
  token: { days: false, label: false },
  ops: {},
  runner: { name: false, once: true, config: false, discover: true, probe: true, "dry-run": true, usage: true, integrate: true },
  login: { server: false, store: true },
  init: { title: 'give the title as --title TEXT, or --title "" to clear it', name: false, "rename-local": true, check: '--check needs text: atelier init --check "TEXT", once per entry', protect: '--protect needs text: atelier init --protect "TEXT", once per entry', core: '--core needs a glob: atelier init --core "GLOB", once per entry, or --core "" alone to clear them', approval: false, reset: true, "refuse-overlap": true, "require-criteria": true, "sandbox-only": true, "no-override": true, "history-since": false, "declare-read-only": '--declare-read-only needs a reason: atelier init --declare-read-only "why the checks change nothing outside the clone"', regenerate: '--regenerate needs a command: atelier init --regenerate "CMD", or --regenerate "" to clear it', "review-bar": '--review-bar needs text: atelier init --review-bar "what may block a review", or --review-bar "" to restore the default', "review-tier": '--review-tier needs models: atelier init --review-tier H/M,H/M,..., or --review-tier "" to clear it' },
  adopt: {},
  revert: {},
  publish: {},
  new: { scope: '--scope needs text: atelier new --scope "TEXT", once per entry', brief: '--brief needs text: atelier new "short title" --brief "TEXT"', accept: '--accept needs text: atelier new --accept "TEXT", once per criterion', "non-goal": '--non-goal needs text: atelier new --non-goal "TEXT", once per entry', "stop-when": '--stop-when needs text: atelier new --stop-when "TEXT", once per entry', "next-gate": '--next-gate needs text: atelier new --next-gate "TEXT"' },
  // edit takes the same, and --title; one empty value clears the field, so
  // the owner can take a framing back.
  edit: { scope: '--scope needs text: atelier edit ID --scope "GLOB", once per entry, or --scope "" alone to clear', title: '--title needs text: atelier edit ID --title "TEXT", at most 80 characters', brief: '--brief needs text: atelier edit ID --brief "TEXT", or --brief "" to clear it', accept: '--accept needs text: atelier edit ID --accept "TEXT", once per criterion, or --accept "" alone to clear', "non-goal": '--non-goal needs text: atelier edit ID --non-goal "TEXT", once per entry, or --non-goal "" alone to clear', "stop-when": '--stop-when needs text: atelier edit ID --stop-when "TEXT", once per entry, or --stop-when "" alone to clear', "next-gate": '--next-gate needs text: atelier edit ID --next-gate "TEXT", or --next-gate "" to clear' },
  block: {},
  unblock: {},
  ls: { all: true, json: true },
  show: { reviews: true, json: true },
  receipt: { json: true },
  start: { runner: false },
  claim: { runner: false },
  push: { force: true, rollback: true },
  update: {},
  check: { sandbox: true, merged: true },
  gc: { "dry-run": true, apply: true },
  report: { item: false },
  submit: { summary: '--summary needs text: atelier submit ID --summary "TEXT"' },
  diff: {},
  review: { approve: true, reject: true, note: false, head: false, findings: false, criteria: false, request: false },
  "review-claim": { runner: false },
  "review-release": { note: false },
  "review-unparsable": { head: false, note: false, "reply-file": false },
  "read-token": {},
  "base-token": {},
  integrated: { part: false, "merge-commit": false },
  "integration-failed": { part: false, reason: false, kind: false },
  refreshed: { "main-head": false, "merge-commit": false },
  "refresh-failed": { "main-head": false, reason: false, kind: false },
  handoff: { to: false, note: false },
  release: { note: false },
  accept: { head: false, note: false, "override-review": '--override-review needs a reason: atelier accept ID --override-review "why no independent review is possible"' },
  abandon: { note: false, "delivered-by": false },
  defect: { note: '--note needs text: atelier defect ID --note "what is wrong"', "found-in": false },
  finding: { head: false, index: false, verdict: '--verdict needs a value: atelier finding ID --head SHA --index N --verdict confirmed|refuted|fixed', note: false },
  "run-report": { actor: false, role: false, outcome: false, project: false, item: false, detail: false },
  served: { recorded: false, from: false, to: false, item: false, note: false, apply: true },
  // done takes its summary as a word; it refuses --summary itself, with its usage.
  done: { sandbox: true, summary: false, json: true },
  finish: { sandbox: true, summary: '--summary needs text: atelier finish ID --summary "TEXT"' },
  sync: {},
  merge: { cancel: true, "discard-local": true, head: false, approve: true, note: false, "policy-changed-ok": true, "override-review": '--override-review needs a reason: atelier merge ID --head FULL_REVISION --override-review "why no independent review is possible"' },
  land: { reviewer: false, "no-review": true, "dry-run": true, wait: true, "release-lease": true, workflow: true, checks: "--checks needs a mode: atelier land ID --workflow --checks local|container" },
  "notes-remote": { off: true },
  approve: { head: false, note: false, expires: false },
  approvals: { all: true, note: false },
  decide: { quote: '--quote needs the owner\'s words: atelier decide "text" --quote "what the owner said"' },
  decisions: { all: true, note: '--note needs text: atelier decisions withdraw ID --note "why"' },
  ship: { "dry-run": true, push: true },
  dispatch:{ to: false, agent: false, model: false, note: false, job: false, head: false, "overlap-ok": true },
  undispatch: {},
  queue: {},
  // Each plan subcommand takes only its own flags (PLAN_FLAGS); this row is their union.
  plan: { scope: '--scope needs text: atelier plan "goal" --scope "GLOB", once per entry', planner: false, json: true, hash: false, "allow-paid": true, note: false, to: false, resolve: true },
  // models add refuses --key, --api-key and --token itself, saying where keys go.
  models: { harness: false, where: false, provider: false, endpoint: false, keychain: false, alias: false, note: false, item: false, key: false, "api-key": false, token: false },
  showcase: { named: true, anonymous: true },
  projects: { force: true },
  owners: { json: true },
  inbox: { json: true },
  status: { json: true, brief: true },
  open: {},
  guide: { role: '--role needs a value: atelier guide --role build|review|plan|orchestrate', full: true },
  help: {},
};
const REST = new Set(["check"]);
// The flags each plan subcommand takes; "" is a new plan's.
const PLAN_FLAGS = { "": ["scope", "planner"], show: ["json"], approve: ["hash", "allow-paid"], revise: ["note"], reroute: ["to"], retry: [], refresh: ["resolve", "to"], stop: ["note"], post: [] };
// version is a switch too, so --version=… is refused as a value it does not
// take, instead of slipping through as a string that answers anyway.
const SWITCHES = new Set(["version", ...Object.values(FLAGS).flatMap((row) => Object.keys(row).filter((flag) => row[flag] === true))]);
// --brief is text for new and edit and a switch for status, so it is a switch
// only when the command is status: the first word that is not a flag or a
// flag's value.
const commandOf = (argv) => {
  const plain = new Set([...SWITCHES].filter((flag) => flag !== "brief"));
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") return undefined;
    if (!a.startsWith("-")) return a;
    if (!a.startsWith("--") || a.includes("=")) continue;
    const next = argv[i + 1];
    if (plain.has(a.slice(2)) ? next === "true" || next === "false" : next !== undefined && !next.startsWith("--")) i++;
  }
};
const switchesFor = (argv) => (commandOf(argv) === "status" ? SWITCHES : new Set([...SWITCHES].filter((flag) => flag !== "brief")));

export function parseArgs(argv, switches = switchesFor(argv)) {
  const out = { _: [], multi: {}, bare: [], problems: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { out.rest = argv.slice(i + 1); break; }
    // Help and the version are read before any flag, so a word after either
    // is never its value.
    if (a === "-h" || a === "--help") { out.help = true; continue; }
    if (a === "--version") { out.version = true; continue; }
    if (!a.startsWith("--")) { out._.push(a); continue; }
    const eq = a.indexOf("=");
    const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
    const next = argv[i + 1];
    let val;
    if (switches.has(key)) {
      // A switch is on unless it is given the word false, as --flag=false or
      // --flag false; any other word after it is a positional.
      const word = eq !== -1 ? a.slice(eq + 1) : next === "true" || next === "false" ? (i++, next) : "true";
      if (word !== "true" && word !== "false") out.problems.push(`--${key} takes no value: write --${key}, or --${key}=false to turn it off`);
      val = word === "true";
    } else if (eq !== -1) val = a.slice(eq + 1);
    // --key VALUE takes the next word unless that word is a flag. With no
    // word there the flag is bare, which checkFlags refuses.
    else if (next === undefined || next.startsWith("--")) { val = true; out.bare.push(key); }
    else val = (i++, next);
    (out.multi[key] ??= []).push(val);
    out[key] = val;
  }
  return out;
}

// The flags a command was given, against its row in FLAGS: an unknown flag,
// a `--` the command does not take, a flag that needs a value and got none,
// and a switch given a word other than true or false are refused here, before
// the command runs or contacts the server.
function checkFlags(cmd) {
  const row = { ...COMMON, ...FLAGS[cmd] };
  const see = COMMAND_USAGE[cmd] ? `atelier ${cmd} --help` : "atelier help";
  for (const flag of Object.keys(args.multi)) if (!(flag in row)) die(`${cmd} does not take --${flag}; see ${see}`);
  if (args.rest && !REST.has(cmd)) die(`${cmd} does not take "--" and the words after it; see ${see}`);
  for (const flag of args.bare) die(typeof row[flag] === "string" ? row[flag] : `--${flag} needs a value: --${flag} VALUE or --${flag}=VALUE`);
  for (const problem of args.problems) die(problem);
}

const isMain = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

// Portfolio operations (surveys, devices and shipping, backups, Observatory,
// the findings ledger) live in a private toolkit, not in this public command.
// `atelier ops ...` hands everything after `ops` to it before this command
// parses anything, so no argument is changed on the way, and it exits as the
// toolkit exits; only --version and the token-expiry command are read here
// first, so they never reach the toolkit. The toolkit is the program
// ATELIER_OPS names, or atelier-ops on PATH; only an executable file counts.
const runnable = (path) => {
  try { return statSync(path).isFile() && (accessSync(path, fsConstants.X_OK), true); } catch { return false; }
};
export function findOps(env = process.env) {
  if (env.ATELIER_OPS) { const named = resolve(env.ATELIER_OPS); return runnable(named) ? named : null; }
  // An empty PATH entry is the current directory, as a shell reads it.
  for (const dir of (env.PATH ?? "").split(":").map((d) => d || ".")) {
    const candidate = resolve(dir, "atelier-ops");
    if (runnable(candidate)) return candidate;
  }
  return null;
}
function runOps(argv) {
  const exe = findOps();
  if (!exe) {
    process.stderr.write("atelier: atelier ops runs the operations toolkit, atelier-ops, which is not installed on this machine: put it on PATH or set ATELIER_OPS to its path\n");
    process.exit(2);
  }
  const r = spawnSync(exe, argv, { stdio: "inherit" });
  if (r.error) { process.stderr.write(`atelier: could not run ${exe}: ${r.error.message}\n`); process.exit(2); }
  // A toolkit ended by a signal ends this command the same way; a signal Node
  // will not die of (SIGPIPE, SIGUSR1) gives the shell's 128 + its number.
  if (r.signal) {
    process.kill(process.pid, r.signal);
    process.exit(128 + (osConstants.signals[r.signal] ?? 0));
  }
  process.exit(r.status ?? 1);
}
// `atelier ops token-expiry NAME --on YYYY-MM-DD` records the day a named
// token expires, for `atelier status` to warn before it lapses. It is handled
// here, before anything reaches the private toolkit, because the record is
// local to this machine and `status` (this command) reads it: it stores a
// name and a day, never a token's value. Every other `ops` command still goes
// to the toolkit.
function runTokenExpiry(argv) {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write("usage: atelier ops token-expiry NAME --on YYYY-MM-DD\n\nRecords the day the named token expires, for `atelier status` to warn from 14 days before it. It stores the name and the day, never the token's value.\n");
    process.exit(0);
  }
  let name = null, on = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--on") { on = argv[i + 1]; i++; continue; }
    if (a.startsWith("--on=")) { on = a.slice(5); continue; }
    if (a.startsWith("--")) die(`token-expiry does not take ${a}; use atelier ops token-expiry NAME --on YYYY-MM-DD`);
    if (name !== null) die("token-expiry takes one name; use atelier ops token-expiry NAME --on YYYY-MM-DD");
    name = a;
  }
  if (!name) die("token-expiry needs a name: atelier ops token-expiry NAME --on YYYY-MM-DD");
  if (!on) die("token-expiry needs the expiry day: atelier ops token-expiry NAME --on YYYY-MM-DD");
  if (!parseExpiryDay(on)) die(`--on takes a day, YYYY-MM-DD, not ${JSON.stringify(on)}`);
  recordTokenExpiryDay(name, on);
  console.log(`Recorded ${name} expires ${on}; atelier status warns from ${TOKEN_EXPIRY_WARN_DAYS} days before.`);
  process.exit(0);
}
if (isMain && process.argv[2] === "ops") {
  const opsArgs = process.argv.slice(3);
  // --version stands before any parsing, so only the words up to a `--` are
  // read: an exact --version there is answered, like every other command.
  const version = opsArgs.indexOf("--version"), end = opsArgs.indexOf("--");
  if (version !== -1 && (end === -1 || version < end)) { console.log(VERSION_LINE); process.exit(0); }
  if (opsArgs[0] === "token-expiry") runTokenExpiry(opsArgs.slice(1));
  runOps(opsArgs);
}

const args = parseArgs(process.argv.slice(2));
const cfg = isMain ? loadConfig() : {};

// The server says which actor stands for the project owner; `login` records it.
const OWNER = process.env.ATELIER_OWNER ?? cfg.owner ?? "owner";
const OWNER_NAME = cfg.ownerName ?? "the project owner";

// The server in use: the one `login` is checking, else ATELIER_SERVER, else
// the one config.json names. Every request goes through here, so an address
// the token must not travel to ends the command before any request is made.
function server() {
  const s = loginServer ?? process.env.ATELIER_SERVER ?? cfg.server;
  if (!s) die("no server: run `atelier login --server https://…`");
  const url = trimSlash(s);
  const refusal = insecureServer(url);
  if (refusal) die(refusal);
  return url;
}

// Hosts a request reaches without leaving this machine.
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

// Why a server address is refused, or undefined when it may be used. Each
// request carries the owner token as a bearer header, so the server is
// reached over https: over plain http the token would be readable on every
// network between this machine and the server. Plain http is accepted for a
// server on this machine alone, where the request never leaves it.
export function insecureServer(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return `${url} is not a URL; name the server as https://HOST`; }
  if (parsed.protocol === "https:") return undefined;
  if (parsed.protocol === "http:" && LOOPBACK.has(parsed.hostname)) return undefined;
  return `${url} is not https: the owner token goes with every request, and over plain http it would be readable on every network on the way. Name the server as https://HOST; plain http is accepted for a server on this machine alone (localhost, 127.0.0.1 or [::1])`;
}

// A session driving Atelier by hand reads the project's AGENTS.md and the
// output of the commands it runs, not the briefs the build and review agents
// get. Unless the project's AGENTS.md already states the review path (atelier
// land --reviewer), status, ls and new end with one line that names
// `atelier guide --role orchestrate`. Nothing is remembered between runs: the
// CLI cannot tell one session from the next, so the line stays until the
// AGENTS.md says it. A task workspace gets none: its agent has the brief.
export function statesReviewPath(markdown) {
  return typeof markdown === "string" && /atelier land\b[^\n]*--reviewer/.test(markdown);
}

function readAgentsMd(dir) {
  try { return readFileSync(join(dir, "AGENTS.md"), "utf8"); } catch { return null; }
}

export function guidePointer(projects, names, inWorkspace = false, read = readAgentsMd) {
  if (inWorkspace) return null;
  const unread = names.filter((n) => !statesReviewPath(projects?.[n]?.path ? read(projects[n].path) : null));
  if (!unread.length) return null;
  const one = unread.length === 1;
  return `Review path${one ? ` for ${unread[0]}` : ""}: atelier guide --role orchestrate${one ? ` --project ${unread[0]}` : ""} prints how to run, review and land work here, including atelier land --reviewer.`;
}

// The short AGENTS.md section atelier init offers: it points at the guide and
// states the review path, so a session that reads only AGENTS.md finds both.
export const AGENTS_SECTION = `## Working through Atelier

Before driving this project's tasks by hand, run \`atelier guide --role orchestrate\`; it prints the whole orchestrator guide.

Review path: a finished task is reviewed before it merges. \`atelier land ID --reviewer HARNESS/MODEL\` lands it with that model's review; do not merge around the review.
`;

export function agentsMdOffer(markdown) {
  const pointsAtGuide = markdown !== null && /atelier guide/.test(markdown);
  const statesReview = statesReviewPath(markdown);
  if (pointsAtGuide && statesReview) return null;
  const gap = markdown === null ? "This checkout has no AGENTS.md" : !pointsAtGuide ? "AGENTS.md does not mention atelier guide" : "AGENTS.md does not state the review path (atelier land --reviewer)";
  return `${gap}, so a session that reads only it never sees the review path. atelier init did not edit it; add this section:\n\n${AGENTS_SECTION}`;
}

function pointToGuide(names) {
  if (args.json) return;
  const line = guidePointer(cfg.projects, names, Boolean(wsConfig("item")));
  if (line) console.log(`\n${line}`);
}

function wsConfig(key, cwd = process.cwd()) {
  const r = spawnSync("git", ["config", "--local", `atelier.${key}`], { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

let tokenActor;

async function actor(fallback) {
  await resolveTokenActor();
  if (tokenActor) return args.as ?? process.env.ATELIER_ACTOR ?? tokenActor;
  const a = args.as ?? process.env.ATELIER_ACTOR ?? wsConfig("actor") ?? fallback;
  if (!a) die("say who you are: --as harness/model (e.g. claude-code/opus-5.5), or set ATELIER_ACTOR");
  return a;
}

export function initName(projects, top, explicit, renameLocal) {
  const real = (path) => { try { return realpathSync(path); } catch { return resolve(path); } };
  const existing = Object.entries(projects ?? {}).find(([, p]) => real(p.path) === real(top))?.[0];
  if (explicit !== undefined && (typeof explicit !== "string" || !explicit.trim())) throw new Error("--name needs a project name");
  if (existing && explicit && explicit !== existing && !renameLocal) throw new Error(`this checkout is registered as ${existing}; use --rename-local to change only the local entry`);
  const name = explicit ?? existing ?? top.split("/").pop();
  if (renameLocal && (!existing || !explicit)) throw new Error("--rename-local needs a registered checkout and --name NAME");
  if (renameLocal && name !== existing && projects?.[name]) throw new Error(`${name} is already registered locally`);
  return { name, existing };
}

// The folder the current directory belongs to (the top of its Git repository,
// else the directory itself) and the project registered for it, or null.
// Compared as real paths: git reports /private/var/… for a checkout
// registered as /var/… on macOS, and any symlinked folder the same way.
function registeredHere() {
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  const here = top.status === 0 ? top.stdout.trim() : process.cwd();
  const real = (path) => { try { return realpathSync(path); } catch { return resolve(path); } };
  const name = top.status === 0 ? Object.entries(cfg.projects ?? {}).find(([, p]) => real(p.path) === real(here))?.[0] ?? null : null;
  return { here, name };
}

function project() {
  if (args.project) return args.project;
  const fromWs = wsConfig("project");
  if (fromWs) return fromWs;
  const { here, name } = registeredHere();
  if (name) return name;
  die(unregisteredMessage(here, cfg.projects));
}

// A project's override for one role's instructions, `.atelier/prompts/ROLE.md`,
// or null when the project has none. Read from the project's checkout on this
// machine; a role outside one prints its default text. The project is the one
// `--project` names, else this folder's workspace or registered checkout, else
// none.
function roleOverride(role) {
  // A `--project` that names no checkout registered on this Mac is a typo, not
  // a reason to print the default text: every other command that takes
  // `--project` dies, and the quiet fallback here would hide the typo'd name
  // and print the default as though the owner's override did not exist.
  if (args.project && !cfg.projects?.[args.project]) {
    die(unregisteredMessage(registeredHere().here, cfg.projects));
  }
  const name = args.project ?? wsConfig("project") ?? registeredHere().name;
  const path = name ? cfg.projects?.[name]?.path : null;
  if (!path) return null;
  try {
    const text = readFileSync(join(path, ".atelier", "prompts", `${role}.md`), "utf8");
    if (!text.trim()) return null;
    return text.endsWith("\n") ? text : `${text}\n`;
  } catch {
    return null;
  }
}

// What a command that needs a project says when this folder is neither a
// registered checkout nor a task workspace: the folder, every project
// registered on this Mac with its checkout, and the one named like this
// folder, since a copy or a second clone of a registered checkout is the
// usual way to be in the wrong one.
export function unregisteredMessage(here, projects) {
  const names = Object.keys(projects ?? {}).sort();
  const first = `which project? ${here} is not a registered checkout or a task workspace. Pass --project NAME, or run the command in a registered checkout or in a task workspace.`;
  if (!names.length) return `${first}\nNo project is registered on this Mac: run atelier init in a project's checkout to register it.`;
  const width = Math.max(...names.map((n) => n.length)) + 2;
  const lines = [first, "Registered on this Mac:", ...names.map((n) => `  ${n.padEnd(width)}${projects[n].path ?? "no folder recorded"}`)];
  const like = names.find((n) => n.toLowerCase() === basename(here).toLowerCase());
  if (like) lines.push(`${like}, named like this folder, is registered at ${projects[like].path}; run the command there, or pass --project ${like}.`);
  return lines.join("\n");
}

// The decisions as `atelier decisions` lists them: each as the briefs and
// the guide say it (decisionLines), and a withdrawn one with when and why.
export function formatDecisions(decisions) {
  return decisions.map((d) => {
    const [line] = decisionLines([d]);
    return d.withdrawn ? `${line} Withdrawn ${d.withdrawn.at.slice(0, 10)}: ${d.withdrawn.note}` : line;
  }).join("\n");
}

// Edit distance between two names: how many characters to insert, drop or
// change, so the registered name nearest a mistyped one comes first.
export function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}

// What a command says when the server has no project under the name it was
// given. The registered names come first, nearest the name first, since a
// mistyped --project is the usual cause. init is named only away from a
// registered checkout, where it would register the wrong folder; in one, the
// folder's own project is the answer. A name this Mac registers but the
// server lacks is its own case: the project is gone there, or the server is
// another one.
export function noProjectMessage(name, host, projects, here) {
  const names = Object.keys(projects ?? {});
  const first = `no project named ${name} on ${host}.`;
  if (projects?.[name]) return `${first}\nThis Mac registers ${name}'s checkout at ${projects[name].path}, but the server has no project under that name: it was removed there, or ${host} is not the server it was registered with. To create it there, run atelier init in that checkout.`;
  const lines = [first];
  if (names.length) lines.push(`Registered on this Mac, closest first: ${names.slice().sort((a, b) => editDistance(a, name) - editDistance(b, name) || a.localeCompare(b)).join(", ")}.`);
  if (here) lines.push(`This folder is ${here}'s checkout: run the command with --project ${here}, or without --project.`);
  else lines.push(names.length ? "To register a new project, run atelier init in its checkout." : "No project is registered on this Mac. To register one, run atelier init in its checkout.");
  return lines.join("\n");
}

// --summary takes text: an empty or blank value is refused, not dropped. A
// bare flag is refused by the flag table before the command runs.
function summaryArg(cmd) {
  if (args.summary === undefined) return;
  let text;
  try { text = cleanSummary(args.summary); } catch (error) { die(error.detail); }
  if (!text) die(`--summary needs text: atelier ${cmd} ID --summary "TEXT"`);
}

// --check, --protect and --scope take text, once per use. A bare flag is
// refused by the flag table, which gives it this message, before the command
// runs; an empty or blank value is refused here, before any request. A
// forgotten command after --check would otherwise register a required check
// named "true", which `sh -c true` passes every time. The server refuses the
// same (asStrings in src/index.ts).
function listArg(flag, cmd) {
  const values = args.multi[flag] ?? [];
  if (values.some((v) => typeof v !== "string" || !v.trim())) die(`--${flag} needs text: atelier ${cmd} --${flag} "TEXT", once per entry`);
  return values.map((v) => v.trim());
}

// --core, as init sends it: the globs given, once per use, or [] for one
// --core "" alone, which clears them; null when --core is not given, so the
// server keeps the recorded ones. Any other empty value is refused as a bare
// flag is, with the flag table's wording.
function coreArg() {
  const values = args.multi.core;
  if (values === undefined) return null;
  if (values.length === 1 && values[0] === "") return [];
  if (values.some((v) => typeof v !== "string" || !v.trim())) die(FLAGS.init.core);
  return values.map((v) => v.trim());
}

// --brief, --accept, --non-goal, --stop-when and --next-gate, as new and
// edit send them, and edit's --title: a list per use for --accept,
// --non-goal and --stop-when, text for the others, each trimmed. A flag not
// given is not sent, so the server keeps the item's value. For edit, one
// empty value clears the field (the title cannot be cleared); for new, an
// empty value is refused as a bare flag is, with the flag table's wording.
function fieldsArg(cmd) {
  const out = {};
  if (args.title !== undefined) {
    if (typeof args.title !== "string" || !args.title.trim()) die(FLAGS[cmd].title);
    out.title = args.title.trim();
  }
  if (args.brief !== undefined) {
    if (typeof args.brief !== "string" || (!args.brief.trim() && cmd !== "edit")) die(FLAGS[cmd].brief);
    out.brief = args.brief.trim() || null;
  }
  if (cmd === "edit" && args.multi.scope !== undefined) {
    const values = args.multi.scope;
    if (values.length === 1 && values[0] === "") out.scope = [];
    else if (values.some((v) => typeof v !== "string" || !v.trim())) die(FLAGS.edit.scope);
    else out.scope = values.map((v) => v.trim());
  }
  for (const [flag, key] of [["accept", "accept"], ["non-goal", "nonGoals"], ["stop-when", "stopWhen"]]) {
    const values = args.multi[flag];
    if (values === undefined) continue;
    if (cmd === "edit" && values.length === 1 && values[0] === "") { out[key] = []; continue; }
    if (values.some((v) => typeof v !== "string" || !v.trim())) die(FLAGS[cmd][flag]);
    out[key] = values.map((v) => v.trim());
  }
  const gate = args["next-gate"];
  if (gate !== undefined) {
    if (typeof gate !== "string" || (!gate.trim() && cmd !== "edit")) die(FLAGS[cmd]["next-gate"]);
    out.nextGate = gate.trim() || null;
  }
  return out;
}

// --override-review takes the reason the override records. A bare flag is
// refused by the flag table, which gives it this message, before the command
// runs; an empty or blank reason is refused here, before any request. The
// server refuses the same (overrideReason in src/rules.ts).
function overrideArg(form) {
  const reason = args["override-review"];
  if (reason === undefined) return undefined;
  if (typeof reason !== "string" || !reason.trim()) die(`--override-review needs a reason: atelier ${form} --override-review "why no independent review is possible"`);
  return reason.trim();
}

function itemArg(i = 1) {
  const id = args._[i] ?? wsConfig("item");
  if (!id) die("which item? pass its id (t3) or run inside its workspace");
  return id;
}

// push, update and finish act on the repository in the current directory:
// they push its HEAD to its origin, rebase it, or both. Only the item's own
// workspace clone, the one claimWorkspace made, may be that repository. The
// clone's .git/config names the project, the item and the actor the claim
// wrote, and all three must match what the command runs for, so a command
// run in the owner's checkout (whose origin is the owner's own remote), in
// another task's workspace or under another actor's name stops here, before
// git is asked to do anything, and the message says where it belongs.
function requireWorkspace(cmd, name, id, as) {
  const held = { project: wsConfig("project"), item: wsConfig("item"), actor: wsConfig("actor") };
  if (held.project === name && held.item === id && held.actor === as) return;
  if (held.project !== name || held.item !== id) {
    const here = held.item ? `this directory is ${held.project}/${held.item}'s workspace` : "this directory is not a task workspace";
    die(`${cmd} must run in ${id}'s claimed workspace; ${here}. Run: cd ${JSON.stringify(workspacePath(name, id))} && atelier ${cmd} (after atelier claim ${id} --project ${name} if that workspace does not exist yet)`);
  }
  die(`${cmd} must run as the actor that claimed ${id} in this workspace, ${held.actor ?? "which is not recorded here"}, not ${as}; if ${id} is yours now, run atelier claim ${id} --as ${as} first`);
}

async function resolveTokenActor() {
  if (tokenActor || !apiToken().startsWith("atl_")) return;
  const config = await call("GET", "/config");
  tokenActor = config.actor;
  const declared = args.as ?? process.env.ATELIER_ACTOR;
  if (tokenActor && args._[0] !== "token" && declared !== undefined && declared !== tokenActor) die("--as and ATELIER_ACTOR must match the agent token actor");
}

async function call(method, path, body, as, extra = {}) {
  try { return await request(method, path, body, as, extra); } catch (error) { if (error instanceof RequestError) die(error.message, error.code); throw error; }
}

// A request the server refused or could not answer: the message `call`
// prints and the exit code it ends with.
class RequestError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

// `call` without ending the command: a failure throws a RequestError, so a
// caller can retry it or name the step that failed.
async function request(method, path, body, as, extra = {}) {
  const die = (message, code = 1) => { throw new RequestError(message, code); };
  if (path !== "/config") await resolveTokenActor();
  if (tokenActor) as = args.as ?? process.env.ATELIER_ACTOR ?? tokenActor;
  let res, text;
  try {
    res = await fetch(server() + "/api" + path, {
      method,
      headers: { authorization: `Bearer ${apiToken()}`, ...(as ? { "x-atelier-actor": as } : {}), "content-type": "application/json", ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    text = await res.text();
  } catch (error) { die(`server request failed: ${error.message}`, 4); }
  let data;
  try { data = JSON.parse(text); } catch { data = { error: "bad_response", detail: text.slice(0, 300) }; }
  if (!res.ok) {
    // 4 for a server that cannot answer, 3 for a refused claim (the runner
    // reads it), 1 otherwise, whatever the message says.
    const code = res.status >= 500 || res.status === 408 || res.status === 429 ? 4 :
      method === "POST" && path.endsWith("/claim") && res.status >= 400 && res.status < 500 ? 3 : 1;
    // A project the server does not know, asked for by name: the answer
    // names what this Mac knows instead of the server's "run atelier init",
    // which an agent would obey in whatever folder it stands in.
    const named = data.error === "no_project" ? /^\/projects\/([^/]+)/.exec(path)?.[1] : undefined;
    if (named) die(noProjectMessage(decodeURIComponent(named), server(), cfg.projects, registeredHere().name), code);
    die(`${data.error ?? res.status}: ${data.detail ?? text.slice(0, 300)}`, code);
  }
  return data;
}

const P = (name) => `/projects/${encodeURIComponent(name)}`;
const I = (name, id) => `${P(name)}/items/${encodeURIComponent(id)}`;
const short = (s) => (s ? s.slice(0, 8) : "—");

// The owner's approval recorded on the project, or null when the project is
// not registered yet or records none. Asked with a plain request rather than
// `call`, because a project not yet registered answers 404, and here that is
// an answer, not a failure.
async function recordedApproval(name) {
  await resolveTokenActor();
  let res, data;
  try {
    res = await fetch(`${server()}/api${P(name)}`, { method: "GET", headers: { authorization: `Bearer ${apiToken()}`, "x-atelier-actor": tokenActor ?? OWNER } });
    data = await res.json().catch(() => ({}));
  } catch (error) { die(`server request failed: ${error.message}`, 4); }
  if (res.status === 404) return null;
  if (!res.ok) die(`${data.error ?? res.status}: ${data.detail ?? "the project could not be read"}`, res.status >= 500 ? 4 : 1);
  return data.project?.policy?.approval ?? null;
}

function workspacePath(name, id) {
  return join(CACHE, "work", name, id);
}

// Where a checkout's landing lock and journal live (cli/landing.mjs): under
// the cache, outside the iCloud checkout.
const landingHome = (gitDir) => landingDir(CACHE, gitDir);

// Take an item and prepare its workspace clone. The claim mints the write
// token for this actor alone, and the clone is reused when it already exists.
async function claimWorkspace(name, id, as, runner) {
  const r = await call("POST", `${I(name, id)}/claim`, {}, as, runner ? { "x-atelier-runner": runner } : {});
  const dir = workspacePath(name, id);
  const fresh = !existsSync(join(dir, ".git"));
  if (fresh) {
    mkdirSync(dir, { recursive: true });
    git(["clone", "--quiet", r.workspace.remote, dir], { token: r.workspace.token });
  }
  // The workspace keeps its token under Caches, not iCloud (see
  // storeWorkspaceToken). It is replaced before any fetch: git sends every
  // configured header, and a revoked one alongside the fresh one is refused.
  storeWorkspaceToken(dir, r.workspace.remote, r.workspace.token);
  recordTokenExpiry(dir, r.workspace.expiresAt);
  if (!fresh) git(["fetch", "--quiet", "origin"], { cwd: dir });
  // Each claim writes the branch the server gives, the project's branch,
  // which is the one Atelier reads, and says so when that changes what the
  // workspace held. Local commits are untouched: only where the next push
  // goes changes. The fork's own HEAD is then compared, so a registration
  // that disagrees with it shows here rather than at the push.
  const was = fresh ? null : wsConfig("branch", dir);
  const branch = r.workspace.defaultBranch;
  for (const [k, v] of Object.entries({ project: name, item: id, actor: as, branch })) {
    git(["config", "--local", `atelier.${k}`, v], { cwd: dir });
  }
  if (was && was !== branch) console.log(`This workspace pushed to ${was}; it now pushes to ${branch}, the branch Atelier reads. Commits pushed to ${was} in the fork are not seen there: push them again with atelier push.`);
  if (!fresh) takeForkHead(dir, id, branch);
  const reads = forkBranch(dir);
  if (reads && reads !== branch) console.log(`Warning: ${id}'s fork reads its head from ${reads}, but the project's branch is ${branch}, so atelier push will refuse. To register ${reads}, ${OWNER_NAME} runs atelier init in the project's checkout with ${reads} checked out.`);
  // Commit as the project's checkout does, not as this machine's global identity.
  const identity = applyIdentity(cfg.projects?.[name]?.path, dir);
  return { item: r.item, workspace: r.workspace, dir, identity };
}

// The branch a fork's HEAD names, as its Git remote reports it. Atelier
// reads a task's head from the fork's HEAD (headOf in src/index.ts), so this
// is the one branch a push is seen on. null when origin cannot be read or
// does not name a branch.
function forkBranch(cwd) {
  const r = git(["ls-remote", "--symref", "origin", "HEAD"], { cwd, allowFail: true });
  if (r.status !== 0) return null;
  return /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(r.stdout)?.[1] ?? null;
}

// Whether `commit` holds `ancestor` in its history, and whether the
// repository holds a commit at all, as git answers in the given directory.
const holds = (ancestor, commit, cwd) => git(["merge-base", "--is-ancestor", ancestor, commit], { cwd, allowFail: true }).status === 0;
const hasCommit = (sha, cwd) => git(["cat-file", "-e", `${sha}^{commit}`], { cwd, allowFail: true }).status === 0;
const count = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;

// A reused workspace holds what its last session left, and the fork's
// branch may have moved on since: another holder pushed to it after a
// handoff, or the same holder pushed from another machine. The fetch alone
// leaves the workspace behind it, and from there `atelier update` would
// carry only this workspace's commits onto the baseline and `atelier push
// --force` would put them over the others. So the fork's commits are taken
// here, before any work: when this workspace has no commits of its own past
// the fork's branch, it is fast-forwarded to it; when the two have diverged,
// the claim stops and names the commits to integrate, since replaying this
// workspace's commits can conflict and is the agent's to do. The claim on
// the server stands either way, and running it again after the rebase
// finds the workspace in step. A fork branch that origin does not list is
// left to the push to refuse (see the warning on forkBranch).
function takeForkHead(dir, id, branch) {
  const remote = `refs/remotes/origin/${branch}`;
  if (git(["rev-parse", "--verify", "--quiet", remote], { cwd: dir, allowFail: true }).status !== 0) return;
  if (holds(remote, "HEAD", dir)) return;
  const missing = git(["log", "--oneline", `HEAD..${remote}`], { cwd: dir });
  const n = count(missing.split("\n").filter(Boolean).length, "commit");
  if (holds("HEAD", remote, dir)) {
    const ff = git(["merge", "--ff-only", "--quiet", remote], { cwd: dir, allowFail: true });
    if (ff.status !== 0) die(`${id}'s fork holds ${n} this workspace lacks:\n${missing}\nFast-forwarding ${dir} to them failed:\n${(ff.stderr || ff.stdout).trim()}\nCommit or set aside its changes, then run atelier claim ${id} again.`);
    console.log(`This workspace was behind ${id}'s fork; it now holds the ${n} pushed there since:\n${missing}`);
    return;
  }
  die(`${id}'s fork holds ${n} this workspace lacks, and this workspace holds commits the fork lacks. The fork's:\n${missing}\nPut this workspace's commits on top of them first: cd ${JSON.stringify(dir)} && git rebase ${remote}, then run atelier claim ${id} again. This workspace's commits are untouched.`);
}

// ── clean-room checks ──────────────────────────────────────────────────────

// Each secret replaced by [redacted] wherever it appears in the text, longest
// first so a secret that contains another is cut whole.
export function redact(text, secrets) {
  for (const secret of [...new Set(secrets)].filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join("[redacted]");
  return text;
}

// The Artifacts tokens a workspace's extraHeader settings hold, in
// .git/config or in a file it includes: its write token, which a check can
// read from disk.
function workspaceTokens(dir) {
  if (!existsSync(join(dir, ".git"))) return [];
  const r = spawnSync("git", ["config", "--local", "--includes", "--get-regexp", "^http\\..*\\.extraheader$"], { cwd: dir, encoding: "utf8" });
  return r.status === 0 ? [...r.stdout.matchAll(/Bearer (\S+)/g)].map((m) => m[1]) : [];
}

function cleanClone(remote, token, head, baseline, name) {
  mkdirSync(join(CACHE, "checks"), { recursive: true });
  const dir = mkdtempSync(join(CACHE, "checks", "run-"));
  writeFileSync(markerPath(dir), JSON.stringify({ version: 1, project: name, pid: process.pid, startedAt: Date.now() }), { mode: 0o600 });
  git(["clone", "--quiet", remote, dir], { token });
  git(["checkout", "--quiet", "--detach", head], { cwd: dir });
  let changed, againstMain;
  if (baseline) {
    git(["fetch", "--quiet", baseline.remote, baseline.defaultBranch], { cwd: dir, token: baseline.token });
    // Every path on which the head differs from main's head, as the Worker
    // measures it (againstMain in src/diff.ts): which checks apply is read from these.
    const main = git(["diff", "--no-renames", "--name-only", "-z", "FETCH_HEAD", "HEAD"], { cwd: dir, allowFail: true });
    if (main.status === 0) againstMain = main.stdout.split("\0").filter(Boolean);
    const mb = git(["merge-base", "FETCH_HEAD", "HEAD"], { cwd: dir, allowFail: true });
    if (mb.status === 0) {
      const diff = git(["diff", "--no-renames", "--name-only", "-z", mb.stdout.trim(), "HEAD"], { cwd: dir, allowFail: true });
      if (diff.status === 0) changed = diff.stdout.split("\0").filter(Boolean);
    }
  }
  return { dir, changed, againstMain };
}

// The would-be merge, for atelier check --merged: a temporary merge commit of
// the clone's head with main's head, which cleanClone fetched to FETCH_HEAD.
// It is made in the clean clone with hooks and signing off, under an identity
// of its own, and goes away with the clone; nothing pushes it. Returns main's
// head, which the evidence is bound to. A merge that stops on conflicts ends
// the command: the preview on the item page lists the same paths, and the
// workspace's owner resolves them with atelier update.
function mergeWithMain(dir, id) {
  const main = git(["rev-parse", "FETCH_HEAD"], { cwd: dir });
  if (git(["merge-base", "--is-ancestor", "FETCH_HEAD", "HEAD"], { cwd: dir, allowFail: true }).status === 0) {
    process.stderr.write(`atelier: main at ${short(main)} is already in this revision; the merge is the revision itself\n`);
    return main;
  }
  const r = git(["-c", "user.name=atelier", "-c", "user.email=atelier@localhost", "-c", "commit.gpgsign=false", "merge", "--no-ff", "--no-verify", "--no-edit", "-m", `atelier check --merged: main at ${main}`, "FETCH_HEAD"], { cwd: dir, allowFail: true });
  if (r.status !== 0) {
    const conflicts = git(["diff", "--name-only", "--diff-filter=U"], { cwd: dir, allowFail: true }).stdout.trim();
    git(["merge", "--abort"], { cwd: dir, allowFail: true });
    die(`the merge of ${id} with main at ${short(main)} stops${conflicts ? ` on conflicts in:\n${conflicts}` : `:\n${(r.stderr || r.stdout).trim()}`}\nIn the workspace, run atelier update, resolve them, commit, and atelier push --force; then check again.`, 2);
  }
  process.stderr.write(`atelier: merged with main at ${short(main)} in the clean clone\n`);
  return main;
}

// Runs one check with checkEnv's variables and returns its output with every
// secret in `secrets` redacted. The output is redacted whole, before anything
// cuts its tail, so no part of a secret survives at the cut, and the hash is
// of the redacted text, the text a reader of the evidence is shown.
// The check leads a process group of its own. When its shell exits, when its
// time limit passes or when its output overruns, every process left in the
// group (a test runner's worker, a watcher, anything started with &) gets
// SIGTERM, then SIGKILL after `graceMs`, and the result comes back only once
// the group is gone, so nothing the check started still writes in the clone
// when it is removed. A process that leaves the group (setsid) is beyond this.
async function runCheck(cmd, dir, secrets, graceMs = 5000) {
  process.stderr.write(`atelier: running \`${cmd}\` in a clean clone…\n`);
  const record = JSON.parse(readFileSync(markerPath(dir), "utf8"));
  const r = await new Promise((done) => {
    const child = spawn("/bin/sh", ["-c", cmd], { cwd: dir, env: checkEnv(), detached: true });
    const pid = child.pid;
    checkGroup = pid;
    const onInt = interrupted("SIGINT"), onTerm = interrupted("SIGTERM");
    process.once("SIGINT", onInt).once("SIGTERM", onTerm);
    writeFileSync(markerPath(dir), JSON.stringify({ ...record, childPid: pid }));
    let stdout = "", stderr = "", error, bytes = 0, closed, ending = false, ended = !pid;
    // A signal to every process in the group; false once none is left.
    const send = (sig) => { try { process.kill(-pid, sig); return true; } catch { return false; } };
    const finish = () => {
      if (!closed || !ended) return;
      clearTimeout(deadline);
      if (checkGroup === pid) checkGroup = undefined;
      process.off("SIGINT", onInt).off("SIGTERM", onTerm);
      done({ ...closed, stdout, stderr, error: error ?? (closed.signal ? new Error(`check terminated by ${closed.signal}`) : undefined) });
    };
    const end = () => {
      if (ending || ended) return;
      ending = true;
      const until = Date.now() + graceMs;
      const wait = () => {
        if (!send(0)) { ended = true; return finish(); }
        if (Date.now() >= until) { send("SIGKILL"); ended = true; return finish(); }
        setTimeout(wait, 50);
      };
      send("SIGTERM");
      wait();
    };
    const deadline = setTimeout(() => { error ??= new Error(`check exceeded its time limit of ${Math.round(CHECK_TIMEOUT_MS / 1000)} s`); end(); }, CHECK_TIMEOUT_MS);
    const append = (key, chunk) => {
      if (error) return;
      bytes += Buffer.byteLength(chunk);
      if (key === "stdout") stdout += chunk; else stderr += chunk;
      if (bytes > 64 * 1024 * 1024) {
        error = new Error("check output exceeds 64 MiB");
        end();
        stdout = stdout.slice(-32 * 1024 * 1024);
        stderr = stderr.slice(-32 * 1024 * 1024);
      }
    };
    child.stdout.setEncoding("utf8").on("data", (s) => append("stdout", s));
    child.stderr.setEncoding("utf8").on("data", (s) => append("stderr", s));
    child.on("error", (e) => { error = e; });
    // A process left in the group can hold the output pipes open, so the
    // group is ended when the shell exits, not when the pipes close.
    child.on("exit", end);
    child.on("close", (status, signal) => { closed = { status, signal }; finish(); });
  });
  writeFileSync(markerPath(dir), JSON.stringify(record));
  const output = redact(`${r.stdout}${r.stderr}${r.error ? `\n[atelier] ${r.error.message}` : ""}`, secrets);
  return { passed: r.status === 0 && !r.error, output, sha: createHash("sha256").update(output).digest("hex") };
}

// The process group of the check running now. It is not the terminal's
// foreground group, so an interrupt of this command does not reach it: this
// process ends it on the way out instead.
let checkGroup;
process.on("exit", () => { if (checkGroup) { try { process.kill(-checkGroup, "SIGKILL"); } catch { /* The group has ended. */ } } });
const interrupted = (sig) => () => process.exit(128 + osConstants.signals[sig]);

// Posts one check's result. A server that cannot answer (no connection, a
// 5xx, 408 or 429) is asked once more; a failure then ends the command with
// the step named, and the clone is removed on the way out.
async function postEvidence(path, body, as) {
  const step = `posting the result of \`${body.claim}\``;
  for (let attempt = 1; ; attempt++) {
    try { return await request("POST", path, body, as); }
    catch (error) {
      if (!(error instanceof RequestError)) die(`${step} failed: ${error.message}`, 4);
      if (error.code === 4 && attempt === 1) { process.stderr.write(`atelier: ${step} failed (${error.message}); trying once more\n`); await new Promise((r) => setTimeout(r, 1000)); continue; }
      die(`${step} failed: ${error.message}`, error.code);
    }
  }
}

// Removes a check's clone and its record. The removal is retried, since a
// process can still be letting go of a file in it (ENOTEMPTY, EBUSY), and a
// removal that still fails is a warning naming the folder, never a failure of
// the checks: `atelier gc` collects what is left.
function removeClone(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(markerPath(dir), { force: true });
  } catch (error) {
    process.stderr.write(`atelier: warning: the check's clone ${dir} could not be removed (${error.code ?? error.message}); atelier gc --apply removes it later\n`);
  }
}

// ── ControlPlane ───────────────────────────────────────────────────────────
// Where a project is governed by ControlPlane, its policy files say who may act
// and what is protected. Atelier reads them and never writes them.

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

export function readControlPlane(top) {
  const dir = join(top, "docs", "control-plane");
  const read = (name) => {
    try {
      const value = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value) || !Object.keys(value).length) throw new Error("empty, or not a JSON object");
      return value;
    }
    catch (error) { if (error.code === "ENOENT") return null; throw new Error(`${join("docs", "control-plane", name)}: ${error.message}`); }
  };
  const agent = read("agent-policy.v1.json");
  const exec = read("execution-policy.v1.json");
  const adapter = read("project-adapter.v1.json");
  if (!agent && !exec && !adapter) return null;
  const sources = [];
  const protectedPaths = new Set(["AGENTS.md", "CLAUDE.md", "GLM.md", "docs/control-plane/**", "tools/control-plane/**"]);
  let eligible = null;
  let refuseOverlap = null;
  if (agent) {
    sources.push("agent-policy.v1.json");
    eligible = Object.entries(agent.agents ?? {}).filter(([, a]) => a.available).map(([k]) => k);
    refuseOverlap = agent.authority?.overlapping_claims === "refuse";
  }
  if (exec) {
    sources.push("execution-policy.v1.json");
    for (const p of exec.protected_path_patterns ?? []) protectedPaths.add(p);
    for (const rule of exec.maintenance_path_rules ?? []) for (const p of rule.paths ?? []) protectedPaths.add(p);
  }
  if (adapter) {
    sources.push("project-adapter.v1.json");
    for (const s of adapter.protected_surfaces ?? []) if (s.pattern) protectedPaths.add(s.pattern);
  }
  return {
    sources, protected: [...protectedPaths], eligible, refuseOverlap,
    ...(adapter ? { adapter } : {}),
    ...(agent ? { agents: agent.agents ?? {} } : {}),
    ...(exec ? { execution: {
      allowed_classes: exec.allowed_classes ?? ["direct", "coordinated", "protected"],
      direct: { enabled: exec.direct?.enabled ?? false, allowed_path_patterns: exec.direct?.allowed_path_patterns ?? [] },
      protected_path_patterns: exec.protected_path_patterns ?? [],
    } } : {}),
  };
}

export async function refreshControlPlane(top, name, request = call, report = console.log) {
  let cp;
  try { cp = readControlPlane(top); }
  catch (error) {
    report(`Warning: ControlPlane policy could not be read: ${error.message}. The stored policy was not refreshed.`);
    return { skipped: true, changes: [], error: error.message };
  }
  if (!cp) return null;
  const current = await request("GET", P(name), undefined, OWNER);
  const before = current.project.policy;
  // The ship order is the checkout's own declaration too: its commands and
  // kinds travel with the policy, so the gate guards what ship runs and the
  // inbox knows what a merged revision still needs.
  const ship = shipPolicy(top);
  const policy = { protected: [...new Set([...cp.protected, ...(cfg.projects?.[name]?.protect ?? [])])], eligible: cp.eligible ?? [], refuseOverlap: cp.refuseOverlap ?? false, shipRuns: ship.runs, shipKinds: ship.kinds, ...(cp.agents ? { agents: cp.agents } : {}), ...(cp.execution ? { execution: cp.execution } : {}) };
  // Roles and change classes are compared here too, as whole values with their
  // keys in a fixed order; the merge guard compares the fields an acceptance
  // records (mergePolicyDecision), and the ship order with shipChanges.
  const canon = (v) => JSON.stringify(v ?? null, (_, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
  const changes = [...controlPlaneChanges(before, policy),
    ...["agents", "execution"].filter((k) => policy[k] !== undefined && canon(before[k]) !== canon(policy[k])).map((k) => `${k} changed`),
    ...shipChanges(before, policy)];
  if (changes.length) {
    await request("PUT", P(name), policy, OWNER);
    for (const change of changes) report(`ControlPlane ${change}`);
  }
  return { before, policy: { ...before, ...policy }, changes, items: current.items ?? [] };
}

// The receipt goes only into a real folder reached through no symlink, the
// template is read only when it is a regular file, and the receipt file is
// opened with O_NOFOLLOW, so the receipt never reads or writes outside the
// checkout. merge refuses a tree with a symlink on these paths before the
// checkout changes (landingSymlinks); these checks hold even if one is there.
function writeReceipt(cwd, { name, id, item, owners, view, reviews, policy, branch, notesRemote, changeClass }) {
  const dir = join(cwd, RECEIPTS_DIR);
  const kind = (path) => lstatSync(join(cwd, path), { throwIfNoEntry: false });
  if (!["docs", "docs/control-plane", RECEIPTS_DIR].every((path) => kind(path)?.isDirectory())) return null;
  const template = (kind(RECEIPT_TEMPLATE)?.isFile() ? readJson(join(cwd, RECEIPT_TEMPLATE)) : null) ?? {};
  const date = new Date().toISOString().slice(0, 10);
  const file = join(dir, `${date}-atelier-${id}-${short(item.acceptedHead)}.json`);
  // The owner's override of the independent review, when one stands at the accepted head.
  const override = item.reviewOverride?.head === item.acceptedHead ? item.reviewOverride : null;
  const receipt = {
    schema_version: 1,
    kind: "control-plane.landing-receipt",
    receipt_id: `atelier-${name}-${id}-${date}`,
    project_id: template.project_id ?? name,
    execution_class: changeClass ?? "coordinated",
    closure: "compact",
    implementation_commit: item.acceptedHead,
    delivery: {
      kind: "atelier-merge",
      target: `${name}/${id}`,
      evidence: [
        `Atelier item ${id}, "${item.title}", worked by ${owners.join(" then ") || "nobody recorded"}, accepted by ${OWNER_NAME} at ${item.acceptedHead} and merged with --no-ff.`,
        policy.approval ? `The Atelier baseline copy in Artifacts was approved as: ${policy.approval.replace(/[.\s]*$/, "")}.` : null,
        reviews.length ? `Reviews at the accepted head: ${reviews.map((r) => `${r.by} ${r.approve ? "approved" : "rejected"}`).join("; ")}.` : override ? null : "No review was required at the accepted head.",
        override ? `${OWNER_NAME} overrode the independent review at the accepted head: ${override.reason.replace(/[.\s]*$/, "")}.` : null,
        `Provenance is on refs/notes/atelier for the merge commit${notesRemote ? `, and that ref alone is pushed to ${notesRemote}` : ""}.`,
      ].filter(Boolean).join(" "),
    },
    tests: view.map((e) =>
      e.grade === "observed"
        ? `Observed by Atelier in a clean clone at ${short(e.head)}${e.merged ? ` merged with main at ${short(e.mainHead)}` : ""}: \`${e.claim}\` ${e.passed ? "passed" : "failed"} (${e.by}, ${e.at})`
        : `Reported, not verified: ${e.claim} (${e.by}, ${e.at})`),
    next_gate: `${OWNER_NAME} chooses the next work. The merge is not deployed and not pushed to the project's own remotes.`,
    protected_actions_not_taken: [
      "deploy",
      notesRemote ? `push of ${branch} to the project's own remotes (only refs/notes/atelier went to ${notesRemote})` : "push to the project's own remotes",
      "migration",
      "credential change",
      "Observatory publication",
    ],
    unrelated_dirty: [],
    session_continuing: true,
  };
  writeFileSync(file, JSON.stringify(receipt, null, 2) + "\n", { flag: fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW });
  return file.slice(cwd.length + 1);
}

// Run the project's required checks in a Cloudflare container instead of
// here. The Worker records the results itself; this only starts and waits.
async function checkInSandbox() {
  const name = project(), id = itemArg(), as = await actor();
  // --merged asks for the checks on the merge of the head with main's head;
  // the Worker builds that tree itself and records the results bound to both.
  const merged = args.merged === true;
  const { runId } = await call("POST", `${I(name, id)}/sandbox`, merged ? { merged: true } : {}, as);
  process.stderr.write(`atelier: running the checks for ${id}${merged ? " on its merge with main" : ""} in a Cloudflare container (run ${runId})…\n`);
  let state;
  for (let waited = 0; ; waited += 5) {
    state = await call("GET", `${I(name, id)}/sandbox/${encodeURIComponent(runId)}`, undefined, as);
    if (state.status === "done" || state.status === "failed") break;
    if (waited > 20 * 60) die(`still ${state.status} after 20 minutes; check later with atelier show ${id}`);
    await new Promise((ok) => setTimeout(ok, 5000));
  }
  const on = state.request?.merged && state.mainHead ? ` merged with main ${short(state.mainHead)}` : "";
  for (const r of state.results ?? []) {
    doneChecks.push({ claim: r.claim, result: r.notApplicable ? "not applicable" : r.passed ? "passed" : "failed", where: CONTAINER });
    if (r.notApplicable) { console.log(`N/A   ${r.claim}  @ ${short(state.request.head)}${on}  (not run: this change touches none of the paths it applies to)`); continue; }
    console.log(`${r.passed ? "PASS" : "FAIL"}  ${r.claim}  @ ${short(state.request.head)}${on}  (${r.seconds}s, in Cloudflare)`);
    if (!r.passed) process.stdout.write(r.outputTail.slice(-2000) + "\n");
  }
  if (on) console.log(`Recorded on the merge with main at ${short(state.mainHead)}; these results stand beside the revision's own checks and go stale when main moves.`);
  else if (state.changedPaths) console.log(`changed: ${state.changedPaths.join(", ") || "nothing"}`);
  if (state.status === "failed") die(`the run failed: ${state.error}`);
  if (!state.recorded) die("the checks ran but the ledger did not record them");
  if (!doneStep && state.results.some((r) => r.passed === false)) process.exit(2);
}

// What an agent relays is one line per field: text a person or an agent
// wrote (a review note, a title, a dispatch note) is flattened, so a newline
// inside it can never pose as a line of the verdict, and terminal control
// codes are dropped. Atelier's own wording is what the lines start with.
const flat = (value) => stripVTControlCharacters(String(value)).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").trim();

// Where a project stands, as plain text an agent can paste into a chat: one
// line per item, and any text a person or agent wrote flattened.
const at = (iso) => `${String(iso).slice(0, 16).replace("T", " ")} UTC`;
// `origin` is the server in use, for the link to each merge by override.
export function formatStanding(s, ownerName = "the project owner", origin = "") {
  const runner = (q) => `${q.to}${q.agent ? ` ${q.agent}` : ""}${q.model ? `/${q.model}` : ""}`;
  const lines = [`${flat(s.project.title)} (${flat(s.project.name)}) as of ${at(s.generatedAt)}, from Atelier's record`];
  const group = (title, rows) => { if (rows.length) lines.push("", `${title}:`, ...rows.map((r) => `  ${r}`)); };
  group("Held now", s.live.map((i) => `${i.id}  ${i.state}  held by ${flat(i.owner ?? "nobody")}${i.since ? ` since ${at(i.since)}` : ", since when is not shown"}  ${flat(i.title)}`));
  group(`Waiting on ${flat(ownerName)}`, s.waiting.map((w) => `${w.id}  ${w.kind}  ${flat(w.title)}  ${flat(w.reason)}${w.brief ? `  brief, ${flat(w.brief.verdict)}: ${flat(w.brief.line)}` : ""}`));
  group("Queued for a runner", s.queued.map((q) => `${q.id}  for ${flat(runner(q))}  ${flat(q.title)}${q.note ? `  note: ${flat(q.note)}` : ""}`));
  group("Last merges", s.merged.map((m) => `${m.id}  ${at(m.at)}${m.commit ? `  ${m.commit.slice(0, 8)}` : ""}  ${flat(m.title)}${m.line ? `  summary: ${flat(m.line)}` : ""}`));
  // Every merge by override, counted in the heading and one per line under
  // it, each with the link to its page on the server in use (t371).
  group(`Merged by override: ${(s.overrides ?? []).length}`, (s.overrides ?? []).map((o) => `${o.id}  ${taskLink(origin, s.project.name, o.id)}  ${at(o.at)}  ${flat(o.title)}  reason: ${flat(o.reason)}`));
  group("Handoff notes", s.handoffs.map((h) => `${h.id}  ${flat(h.from || "?")} to ${flat(h.to || "?")}, ${at(h.at)}  ${flat(h.note)}`));
  if (lines.length === 1) lines.push("", "Nothing is held, waiting, queued or recently merged.");
  if (s.partial?.length) lines.push("", "Part of this record is not shown:", ...s.partial.map((x) => `  ${flat(x)}`));
  if (s.controlPlane) {
    lines.push("", `ControlPlane policy, approved: ${flat(s.controlPlane.approval)}. Protected areas: ${s.controlPlane.protected.map(flat).join(", ") || "none"}. Eligible agents: ${s.controlPlane.eligible.map(flat).join(", ") || "any"}. Overlapping claims: ${s.controlPlane.refuseOverlap ? "refused" : "flagged"}.`);
  }
  group("Checks", (s.checks ?? []).map((c) => `${flat(c.command)}  ${flat(c.text)}${c.paths?.length ? `; applies only when the change touches ${c.paths.map(flat).join(", ")}` : ""}`));
  return lines.join("\n");
}

// Whether this machine's checkout is in step with the baseline, from what git
// reported. A baseline that holds part of the history (--history-since) is
// matched by its paired project commit; otherwise the baseline's head must be
// in the checkout.
//   { registered, fresh, branch, baselineHead, head, paired, contains, ahead }
// paired: the project commit paired with baselineHead, or null. contains: the
// checkout's history holds baselineHead. ahead: the checkout's head is past paired.
export function checkoutLine(raw) {
  // Names come from configuration; flattened like every relayed field.
  const c = { ...raw, name: flat(raw.name), branch: flat(raw.branch ?? "") };
  if (!c.registered) return `Checkout: none is registered on this machine for ${c.name}, so it cannot be compared.`;
  const base = short(c.baselineHead);
  if (c.fresh) {
    if (!c.paired) return `Checkout: out of step. The baseline's head ${base} has no pair in this checkout; it was set up or synced from another machine.`;
    if (c.head === c.paired) return `Checkout: in step. ${c.branch} @ ${short(c.head)} is the commit the baseline's head ${base} matches.`;
    if (c.ahead) return `Checkout: out of step. ${c.branch} has commits the baseline lacks; run atelier sync --project ${c.name}.`;
    return `Checkout: out of step. ${c.branch} @ ${short(c.head)} is not the commit the baseline's head ${base} matches (${short(c.paired)}); reconcile the checkout, then run atelier sync --project ${c.name}.`;
  }
  return c.contains
    ? `Checkout: in step. ${c.branch} @ ${short(c.head)} holds the baseline's head ${base}.`
    : `Checkout: out of step. ${c.branch} @ ${short(c.head)} does not hold the baseline's head ${base}; reconcile the checkout before merging.`;
}

// The one outcome done ends with (exit codes in cli/help.mjs): failed checks,
// nothing submitted; checked but blocked, submitted with a gate open; or
// submitted and ready for the owner. Acceptance, merge and deploy are separate.
export function doneReport({ id, head, checks, item, gate, changed = [] }) {
  const submitted = item?.state === "submitted";
  const failed = checks.filter((c) => c.result === "failed").map((c) => flat(c.claim));
  const blockers = (gate?.blockers ?? []).map(flat);
  const checkText = checks.length ? `Checks: ${checks.map((c) => `${flat(c.claim)} ${c.result}`).join("; ")} (${checks[0].where})` : "Checks: none ran";
  let outcome, exitCode, line, unresolved, accept, merge, ownerAction;
  if (failed.length) {
    outcome = "failed_checks"; exitCode = 2;
    unresolved = "not evaluated; nothing was submitted";
    accept = "not reached"; merge = "not reached";
    ownerAction = `none yet; fix ${failed.join("; ")} in the workspace, then run done again`;
    const left = changed.length ? `; the workspace also changed: ${changed.map(flat).join(", ")}` : "";
    line = `Outcome: failed checks: ${failed.join("; ")}; nothing was submitted${left}`;
  } else if (submitted && gate.ready) {
    outcome = "submitted"; exitCode = 0;
    unresolved = "none";
    accept = "waiting for the owner"; merge = "not yet; it follows acceptance";
    ownerAction = `accept ${id} at ${short(head)}: atelier accept ${id} --head ${head}`;
    line = "Outcome: submitted, ready for the owner";
  } else {
    outcome = "checked_but_blocked"; exitCode = 3;
    unresolved = `${blockers.length} (named on the last line)`;
    accept = "not yet; the gate must be clear first"; merge = "not yet; it follows acceptance";
    ownerAction = `clear the first blocker: ${blockers[0]}`;
    line = `Outcome: checked but blocked by ${blockers.length} ${blockers.length === 1 ? "blocker" : "blockers"}: ${blockers.join("; ")}`;
  }
  const deploy = "not covered by done";
  const summary = [
    `Head: ${short(head)}`,
    checkText,
    `Unresolved gates: ${unresolved}`,
    `Submitted: ${submitted ? "yes" : "no"}`,
    `Accept: ${accept}`,
    `Merge: ${merge}`,
    `Deploy: ${deploy}`,
    `Owner action: ${ownerAction}`,
  ];
  const json = {
    outcome, exitCode, outcomeLine: line, head, submitted,
    checks: checks.map(({ claim, result, where }) => ({ claim, result, where })),
    unresolvedGates: failed.length ? [] : blockers,
    accept, merge, deploy, ownerAction,
  };
  return { outcome, exitCode, summary, line, json };
}

// --json keeps stdout to the one object: what the steps print goes to stderr.
function progressToStderr() {
  const log = console.log, write = process.stdout.write;
  console.log = (...text) => console.error(...text);
  process.stdout.write = (...text) => process.stderr.write(...text);
  return () => { console.log = log; process.stdout.write = write; };
}

// The owner's framing of a task, one line per field that is set, for the
// task an agent starts and the brief it reads; acceptance criteria one per
// line, numbered.
export function formatFields(fields) {
  return [
    ...(fields.accept ?? []).map((c, i) => `Acceptance criterion ${i + 1}: ${flat(c)}`),
    fields.nonGoals?.length ? `Non-goals: ${fields.nonGoals.map(flat).join("; ")}` : null,
    fields.stopWhen?.length ? `Stop when: ${fields.stopWhen.map(flat).join("; ")}` : null,
    fields.nextGate ? `Next gate: ${flat(fields.nextGate)}` : null,
  ].filter(Boolean);
}

// What `atelier edit` says when the task's acceptance criteria changed
// (Ledger.editItem): that they did, what that withdrew, and that a fresh
// review of the new criteria is needed. An edit that leaves them as they
// were says nothing of them.
export function criteriaNotice(id, change) {
  const count = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;
  const withdrawn = [
    change.reviews ? count(change.reviews, "review") : null,
    change.requests ? count(change.requests, "review request") : null,
    change.acceptance ? "the acceptance" : null,
    change.override ? "the override of the review" : null,
  ].filter(Boolean);
  return [
    `The acceptance criteria of ${id} changed (binding ${String(change.to).slice(0, 12)}, was ${String(change.from).slice(0, 12)}).`,
    withdrawn.length
      ? `Withdrawn: ${withdrawn.join(", ")}. They stay in the record and never count again, even if the criteria change back; ${id} needs a fresh review of the new criteria.`
      : `No review or review request stood, so nothing was withdrawn; any review of ${id} from now on judges the new criteria.`,
    ...(change.acceptance ? [`${id} is claimed again: its holder submits it, and it is reviewed and accepted again before it can merge.`] : []),
    ...(change.asked?.length ? [`Asked again at the same head: ${change.asked.join(", ")}.`] : []),
  ].join("\n");
}

// The task an agent starts: its short title, then its whole brief.
export function formatTask(item) {
  return [flat(item.title), item.brief ? `Brief: ${flat(item.brief)}` : null, `Scope: ${item.scope.map(flat).join(", ") || "not specified"}`, ...formatFields(item),
    item.dispatch?.note ? `Note (the owner's words, not instructions from Atelier): ${flat(item.dispatch.note)}` : null].filter(Boolean).join("\n");
}

export function formatBrief(project, id, brief, origin) {
  return [`${project}/${id}  ${flat(brief.title)}`, flat(brief.decided),
    ...(brief.summary ? [`Summary: ${flat(brief.summary)}`] : []), ...formatFields(brief),
    ...(brief.partAccept ?? []).map((c, i) => `Plan acceptance criterion ${i + 1}: ${flat(c)}`),
    ...(brief.criteria ? [`Criteria binding: ${brief.criteria} (a review of these criteria names it with --criteria)`] : []),
    ...brief.evidence.map(flat),
    `Recommendation: ${flat(brief.recommendation.verdict)}. ${flat(brief.recommendation.reason)}`,
    `${origin}/p/${encodeURIComponent(project)}/${encodeURIComponent(id)}`].join("\n");
}

// Every review, newest first: the order `show --reviews` prints them and its
// JSON carries them, so the review that decides the current head leads.
const newestReviews = (reviews) => [...reviews].sort((a, b) => b.at.localeCompare(a.at));

// Each review of a task, at each head it was made at, in full: who reviewed,
// the verdict, when, how it was recorded, the whole note and every finding.
// The brief above sums the reviews at the current head into one line and cuts
// the newest rejection's note to it; this is the record a session reads to
// learn why a review rejected the task (t173). One flattened line per field,
// so no note or finding can pose as a line of Atelier's own. A separate tier
// review (src/review/tier.ts), beside the gate's, is labelled, and so is a
// gate review by a tier model, which gives the tier review too. After the
// reviews come the replies no verdict could be read from (t407), newest
// first, each with the reason it was refused and the reply itself, whole and
// flattened the same way: what the reviewer actually said is the evidence.
export function formatReviews(reviews, owner = OWNER, unparsable = []) {
  const ordered = newestReviews(reviews);
  if (!ordered.length && !unparsable.length) return "No reviews are recorded.";
  const lines = ordered.length ? ["Reviews:"] : [];
  for (const r of ordered) {
    const recorded = recordedText(r, owner);
    lines.push(`  ${r.tier ? "Tier review: " : r.topTier ? "Gate review, top tier: " : ""}${flat(r.by)} ${r.approve ? "approved" : "rejected"} at ${short(r.head)} (${at(r.at)}${recorded ? `; ${flat(recorded)}` : ""}).`);
    lines.push(`    Note: ${flat(r.note) || "(no note)"}`);
    for (const f of r.findings ?? []) lines.push(`    ${f.severity} ${flat(f.file)}${f.line ? `:${f.line}` : ""} ${flat(f.text)}`);
  }
  for (const r of newestReviews(unparsable)) {
    lines.push(`  ${flat(r.by)} wrote a reply no verdict could be read from at ${short(r.head)} (${at(r.at)}): ${flat(r.note) || "(no reason recorded)"}`);
    lines.push(`    Reply: ${flat(r.reply) || "(nothing written)"}`);
  }
  return lines.join("\n");
}

// ── commands ───────────────────────────────────────────────────────────────

// The checkout's state against the baseline, in words. The baseline's head
// comes from the server (GET baseline-head), as the Worker reads it from
// Artifacts: no token is minted and nothing is fetched into the checkout, so
// status and unwrap, which print this line, read and write nothing.
// Every path out of it is one flattened line, whatever a name holds.
async function checkoutStatus(name, as) {
  return flat(await checkoutStatusLine(name, as));
}

async function checkoutStatusLine(name, as) {
  const p = cfg.projects?.[name];
  if (!p?.path || !existsSync(p.path)) return checkoutLine({ name, registered: false });
  const cwd = p.path, fresh = p.fresh === true;
  const baselineHead = (await call("GET", `${P(name)}/baseline-head`, undefined, as)).head;
  if (!baselineHead) return `Checkout: cannot be compared: the baseline has no ${p.branch} branch yet.`;
  // The registered branch is compared, whatever is checked out: the line
  // names that branch, so its head is what it must describe.
  const head = git(["rev-parse", "--verify", "--quiet", `refs/heads/${p.branch}`], { cwd, allowFail: true }).stdout?.trim();
  if (!head) return `Checkout: cannot be compared: this checkout has no ${p.branch} branch.`;
  const has = (sha) => git(["cat-file", "-e", `${sha}^{commit}`], { cwd, allowFail: true }).status === 0;
  const is = (a, b) => git(["merge-base", "--is-ancestor", a, b], { cwd, allowFail: true }).status === 0;
  const paired = fresh ? loadPairs(git(["rev-parse", "--absolute-git-dir"], { cwd }), name)[baselineHead] ?? null : null;
  return checkoutLine({
    name, registered: true, fresh, branch: p.branch, baselineHead, head, paired,
    contains: !fresh && has(baselineHead) && is(baselineHead, head),
    ahead: !!paired && head !== paired && is(paired, head),
  });
}

// ── this machine ────────────────────────────────────────────────────────────

// The task ids with a workspace on this machine: the folders workspacePath
// makes under the CLI's cache. An empty list means no task of the project is
// being worked on here, and the local section is left out entirely.
function localWorkspaceIds(name) {
  try {
    return readdirSync(join(CACHE, "work", name), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch { /* no such folder: no workspace here */ return []; }
}

// One workspace's facts, as git reports them in the workspace: paths with
// uncommitted changes (`.scratch/` aside, the session's scratch space),
// commits not pushed to the fork, a merge in progress and its conflicted
// files, and a COMMIT_MSG.txt an agent left waiting. `from` holds where
// pushed history is measured from, best first: the head the server last
// observed, then the fork point for a task nothing was pushed for. A folder
// that is not a Git repository is reported as unreadable, never a crash.
function localWorkspace(dir, id, from) {
  const unreadable = (why) => ({ id, uncommitted: null, unpushed: null, merging: null, conflicts: null, commitMessage: null, error: why });
  const gitDir = git(["rev-parse", "--absolute-git-dir"], { cwd: dir, allowFail: true });
  if (gitDir.error || gitDir.status !== 0) return unreadable("not a Git repository");
  // Git leaves .scratch/ out itself, by pathspec, and -z keeps a path with a
  // space or a quote as it is; a rename is one entry followed by its source.
  const status = git(["--no-optional-locks", "status", "--porcelain", "-z", "--", ".", ":(exclude).scratch"], { cwd: dir, allowFail: true });
  if (status.error || status.status !== 0) return unreadable("its Git state could not be read");
  const entries = status.stdout.split("\0").filter(Boolean);
  let uncommitted = 0;
  for (let i = 0; i < entries.length; i++) {
    uncommitted++;
    if (/^[RC]/.test(entries[i])) i++;
  }
  const merging = existsSync(join(gitDir.stdout.trim(), "MERGE_HEAD"));
  const conflicts = merging ? git(["diff", "--name-only", "--diff-filter=U"], { cwd: dir, allowFail: true }).stdout.split("\n").filter(Boolean) : [];
  const start = from.find((sha) => hasCommit(sha, dir));
  const counted = start ? git(["rev-list", "--count", `${start}..HEAD`], { cwd: dir, allowFail: true }) : null;
  const n = counted && !counted.error && counted.status === 0 ? Number(counted.stdout.trim()) : NaN;
  const unpushed = Number.isFinite(n) ? n : null;
  return { id, uncommitted, unpushed, merging, conflicts, commitMessage: existsSync(join(dir, "COMMIT_MSG.txt")) };
}

// Whether a landing is running on this machine for the project: the lock
// file bin/orchestrate/queue.sh holds through the kernel's file lock (flock
// on Linux, lockf on macOS) while it lands. The file stays after a landing,
// so existence says nothing; it is probed without blocking in a child process
// that takes the lock and exits at once, and a probe that could not run, or
// neither prober existing, counts as held rather than free. A missing file
// means no landing.
function landingRunning(name) {
  const file = join(CACHE, `landing-${name}.lock`);
  if (!existsSync(file)) return false;
  for (const [tool, argv] of [["flock", ["-n", file, "true"]], ["lockf", ["-t", "0", file, "true"]]]) {
    const r = spawnSync(tool, argv, { encoding: "utf8" });
    if (r.error?.code === "ENOENT") continue;
    return !!r.error || r.status !== 0;
  }
  return true;
}

// The server's landing lease for the project (atelier land, t187): who holds
// it, for which task, since when. Asked with a plain request rather than
// `call`, because a session whose token cannot read it, such as an agent
// token, still gets the rest of the section; the lease is then reported as
// unreadable. The holder is a person's or agent's name, so it is flattened.
async function landingLease(name, as) {
  await resolveTokenActor();
  let res, data;
  try {
    res = await fetch(`${server()}/api${P(name)}/landing-lease`, { method: "GET", headers: { authorization: `Bearer ${apiToken()}`, "x-atelier-actor": tokenActor ?? as } });
    data = await res.json().catch(() => ({}));
  } catch (error) { die(`server request failed: ${error.message}`, 4); }
  if (!res.ok) return { unreadable: `${data.error ?? res.status}` };
  const lease = data.lease;
  if (!lease || typeof lease !== "object") return null;
  return { item: flat(lease.item ?? "?"), holder: flat(lease.holder ?? "nobody"), since: lease.at ? at(lease.at) : "when is not shown" };
}

// What this machine holds for the project, for the On this Mac section: one
// entry per task of the project with a workspace under the CLI's cache, in
// the server's order, plus whether a landing is running here. The heads and
// fork points come from the server's own task list, so nothing is minted and
// no workspace is written to. null when no task of the project has a
// workspace here, and the command prints what it did before.
async function localStanding(name, as) {
  const here = new Set(localWorkspaceIds(name));
  if (!here.size) return null;
  const { items } = await call("GET", P(name), undefined, as);
  // A merged or abandoned task's workspace is a leftover, not work in
  // progress: it is counted, not listed, so the live tasks stand out.
  const closed = (i) => i.state === "merged" || i.state === "abandoned";
  const tasks = items.filter((i) => here.has(i.id) && !closed(i))
    .map((i) => localWorkspace(workspacePath(name, i.id), i.id, [i.head, i.base].filter(Boolean)));
  const leftover = items.filter((i) => here.has(i.id) && closed(i)).length;
  return { project: name, tasks, leftover, landing: { lock: landingRunning(name), lease: await landingLease(name, as) } };
}

// One line per remote of the local checkout: where the registered branch
// stands against that remote's tracking ref, as it was last fetched or
// pushed. Nothing is fetched and no call takes a lock, so unwrap leaves the
// checkout as it found it. A remote with no tracking ref recorded says so;
// so does a checkout without the registered branch, which the checkout line
// already names. Remote names come from the user's checkout and are printed
// cleaned; git always takes them as one argument, never as shell text.
function remoteStatusLines(name, cwd) {
  const branch = cfg.projects?.[name]?.branch;
  if (!branch || git(["--no-optional-locks", "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd, allowFail: true }).status !== 0) return [];
  const commit = (n) => `${n} commit${n === 1 ? "" : "s"}`;
  return git(["--no-optional-locks", "remote"], { cwd }).split("\n").filter(Boolean).slice(0, 100).map((remote) => {
    const shown = sessionText(remote, 200), where = `${shown}/${flat(branch)}`;
    const tracking = `refs/remotes/${remote}/${branch}`;
    if (git(["--no-optional-locks", "rev-parse", "--verify", "--quiet", tracking], { cwd, allowFail: true }).status !== 0)
      return `Remote ${shown}: no ${where} recorded; fetch to compare.`;
    const counted = git(["--no-optional-locks", "rev-list", "--left-right", "--count", `refs/heads/${branch}...${tracking}`], { cwd, allowFail: true });
    if (counted.status !== 0) return `Remote ${shown}: cannot compare ${flat(branch)} with ${where} (git rev-list exited ${counted.status}).`;
    const [ahead = 0, behind = 0] = counted.stdout.trim().split(/\s+/).map(Number);
    if (!ahead && !behind) return `Remote ${shown}: ${flat(branch)} is in step with ${where} (as last fetched or pushed).`;
    const drift = ahead && behind ? `${commit(ahead)} ahead of and ${commit(behind)} behind` : ahead ? `${commit(ahead)} ahead of` : `${commit(behind)} behind`;
    return `Remote ${shown}: ${flat(branch)} is ${drift} ${where} (as last fetched or pushed)${ahead ? "; not published" : ""}.`;
  });
}

function sessionCheckout(name, requireHere = false) {
  const cwd = cfg.projects?.[name]?.path;
  if (!cwd || !existsSync(cwd)) {
    if (requireHere) die("wrap needs a registered local checkout");
    return null;
  }
  if (requireHere) {
    const top = git(["rev-parse", "--show-toplevel"]);
    if (realpathSync(top) !== realpathSync(cwd)) die("run wrap in the registered project checkout");
  }
  return cwd;
}

function sessionFiles(cwd) {
  const paths = ["docs/STATE.md", "STATE.md", "PROJECT.md"].filter((p) => existsSync(join(cwd, p)));
  const state = stateFile(paths);
  const contents = state ? readFileSync(join(cwd, state), "utf8") : "";
  const scan = (dir, recursive) => {
    if (!existsSync(join(cwd, dir))) return;
    for (const entry of readdirSync(join(cwd, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isFile() && entry.name.endsWith(".md")) paths.push(path);
      else if (recursive && entry.isDirectory()) scan(path, true);
    }
  };
  scan("docs/handoffs", true);
  scan("docs", false);
  const modified = Object.fromEntries(paths.map((path) => [path, statSync(join(cwd, path)).mtime.toISOString()]));
  return { state, contents, paths, modified };
}

function sessionTree(cwd) {
  return git(["--no-optional-locks", "status", "--short", "--untracked-files=all"], { cwd });
}

// What wrap needs before it stages anything: asked first, and again after the
// registered checks, which can change the tree. It refuses a detached HEAD, a
// merge, cherry-pick, revert, rebase or landing in progress, unmerged files in
// the index (a squash merge or a stash pop leaves those with no marker file),
// another branch than the registered one, and a surface over its ceiling. The
// ceiling is the policy committed at HEAD: the working tree's copy can be
// edited or deleted in the session that goes over it, so it is only compared.
// `report` prints advisories; a refusal always prints what it counted.
function wrapReady(name, cwd, report) {
  const branch = git(["branch", "--show-current"], { cwd });
  // The landing marker is the journal under the cache, or one an earlier CLI
  // left in the Git directory and merge has not yet moved; the others are
  // files in the Git directory. A refusal changes nothing in the checkout, so
  // the old journal is named here and moved by merge (cli/landing.mjs).
  const gitDir = git(["rev-parse", "--absolute-git-dir"], { cwd });
  const markerFiles = (marker) => marker === "landing"
    ? [landingJournalFile(landingHome(gitDir)), oldLandingJournalFile(gitDir)]
    : [resolve(cwd, git(["rev-parse", "--git-path", marker], { cwd }))];
  const inProgress = Object.keys(WRAP_MARKERS).filter((marker) => markerFiles(marker).some((file) => existsSync(file)));
  const unmerged = unmergedPaths(git(["ls-files", "-u", "-z"], { cwd, raw: true }));
  const refusal = wrapRefusal({ branch, registered: cfg.projects[name].branch, inProgress, unmerged });
  if (refusal) die(refusal);
  const committed = git(["ls-tree", "--name-only", "HEAD", "--", CONTEXT_BUDGET_PATH], { cwd }) ? git(["show", `HEAD:${CONTEXT_BUDGET_PATH}`], { cwd, raw: true }) : undefined;
  let working;
  try { working = readFileSync(join(cwd, CONTEXT_BUDGET_PATH), "utf8"); } catch { /* absent or unreadable: it differs from HEAD's */ }
  const notice = policyNotice(committed, working);
  if (notice && report) console.log(notice);
  if (committed === undefined) return branch;
  let policy;
  try { policy = contextBudget(JSON.parse(committed)); }
  catch (err) { die(`${CONTEXT_BUDGET_PATH} at HEAD is not a valid policy: ${err.message}`); }
  const contents = Object.create(null);
  for (const surface of policy.surfaces) {
    const path = join(cwd, surface.path);
    if (!existsSync(path)) continue;
    if (!realpathSync(path).startsWith(realpathSync(cwd) + "/")) die(`context surface escapes checkout: ${surface.path}`);
    contents[surface.path] = readFileSync(path, "utf8");
  }
  const result = evaluateCeilings(policy, contents);
  if (report || result.refused) result.messages.forEach((message) => console.log(message));
  if (result.refused) die("wrap refused: context ceiling exceeded");
  return branch;
}

// A report a runner makes under its name: a model's status, a tool's usage.
// The answer is the server's JSON; a refusal is an error naming its detail.
async function postAsRunner(path, body, runner, signal) {
  const res = await fetch(`${server()}/api${path}`, {
    method: "POST", signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    headers: { authorization: `Bearer ${apiToken()}`, "x-atelier-actor": OWNER, "x-atelier-runner": runner, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* a reply that is not JSON has no detail */ }
  if (!res.ok) throw new Error(`${res.status}${data?.detail ? ` ${data.detail}` : ""}`);
  return data;
}

// The pool is read as `atelier models` reads it. A status goes to the status
// route under the runner's name; one that fails does not stop the others, and
// runDiscover names every failure at the end.
async function discoverModels() {
  const { runDiscover } = await import("./discover.mjs");
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  try {
    await runDiscover(args, {
      signal: controller.signal,
      pool: () => call("GET", "/models", undefined, OWNER),
      report: (id, body, runner) => postAsRunner(`/models/${encodeURIComponent(id)}/status`, body, runner, controller.signal),
    });
  } catch (error) { die(error.message); }
}

// `runner setup` (runner-setup.mjs): the pool from the server, and each
// provider's model list read without a key, as a public page is.
async function setupRunner() {
  const { runSetup } = await import("./runner-setup.mjs");
  try {
    await runSetup(args, {
      pool: () => call("GET", "/models", undefined, OWNER),
      async fetchJson(url) {
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
          return res.ok ? await res.json() : null;
        } catch { return null; }
      },
    });
  } catch (error) { die(error.message); }
}

// Each tool's usage goes to the usage route under the runner's name; one
// that fails does not stop the others, and runUsage names every failure.
// The AI Gateway's figures are read back from GET /api/usage, and each
// model's speed from GET /api/reliability (a route older servers have too).
async function reportUsage() {
  const { runUsage } = await import("./usage.mjs");
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  try {
    await runUsage(args, {
      signal: controller.signal,
      report: (tool, body, runner) => postAsRunner(`/usage/${encodeURIComponent(tool)}`, body, runner, controller.signal),
      gateway: async () => (await request("GET", "/usage", undefined, OWNER)).gateway,
      speed: async () => (await request("GET", "/reliability", undefined, OWNER)).speed,
    });
  } catch (error) { die(error.message); }
}

// The text `atelier status` prints, with the token-expiry warnings read from
// this machine's record prepended when any token warns. Pure enough to test:
// the record is read here, the wording lives in src/token-expiry.ts.
function tokenExpiryWarningsText(text) {
  const warnings = formatTokenExpiryWarnings(readTokenExpiries());
  return warnings.length ? `${warnings.join("\n")}\n\n${text}` : text;
}

const commands = {
  async unwrap() {
    const name = project(), as = await actor(OWNER), cwd = sessionCheckout(name);
    const standing = await call("GET", `${P(name)}/standing`, undefined, as);
    console.log(formatStanding(standing, OWNER_NAME, server()));
    console.log(await checkoutStatusLine(name, as));
    if (cwd) for (const line of remoteStatusLines(name, cwd)) console.log(line);
    if (cwd) {
      console.log(`Current branch: ${git(["branch", "--show-current"], { cwd }) || "detached HEAD"}`);
      console.log(`Uncommitted files:\n${sessionTree(cwd) || "none"}`);
    }
    const [note] = await call("GET", `${P(name)}/sessions`, undefined, as);
    console.log(sessionNoteText(note));
    if (cwd) {
      const files = sessionFiles(cwd);
      if (files.state) console.log(fileExcerpt(files.state, files.contents));
      else console.log("State file: none (looked for docs/STATE.md, STATE.md and PROJECT.md).");
      for (const path of handoffNotes(files.contents, files.paths, note?.at, files.modified)) console.log(fileExcerpt(path, readFileSync(join(cwd, path), "utf8")));
    }
    console.log(UNWRAP_RELAY);
  },

  async wrap() {
    const name = project(), as = await actor(OWNER), cwd = sessionCheckout(name, true);
    // The server records a session only for the project owner. Refuse here,
    // before wrap commits or pushes anything the server would then not take a
    // note for.
    if (as !== OWNER) die(`only the project owner records a session: run wrap as ${OWNER}, without --as or ATELIER_ACTOR naming another actor`);
    const head = git(["rev-parse", "HEAD"], { cwd });
    let data;
    // An unquoted summary reaches here as several words: they are one summary.
    try { data = cleanSession({ summary: args._.slice(1).join(" "), next: args.next, head, dirty: false, checks: [] }); }
    catch (err) { die(err.message); }
    const found = args.multi.found ?? [];
    if (found.length > 100 || found.some((text) => !sessionText(text))) die("--found needs text, at most 100 times");
    const allowFailing = args["allow-failing"] === true;
    data.checksSkipped = args["no-check"] === true;
    // Skipped checks cannot fail, so the override would record nothing: the
    // owner says which of the two is meant.
    if (allowFailing && data.checksSkipped) die("--allow-failing and --no-check together: skipped checks cannot fail; give one or the other");
    wrapReady(name, cwd, true);
    const { project: record } = await call("GET", P(name), undefined, as);
    const refused = data.checksSkipped ? [] : record.policy.checks.flatMap((cmd) => { const why = refusalOf(cmd); return why ? [refusalText(cmd, why)] : []; });
    if (refused.length) die(`${refused.join(".\n")}.\nwrap runs the registered checks in this checkout, so it stopped before running any. Replace the check with atelier init --check, or wrap with --no-check.`);
    const failing = [];
    if (!data.checksSkipped) for (const command of record.policy.checks) {
      const result = spawnSync(command, { cwd, shell: true, encoding: "utf8", timeout: CHECK_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
      data.checks.push({ command, passed: result.status === 0, grade: "reported" });
      console.log(`Reported: ${command}: ${result.status === 0 ? "passed" : "failed"} (owner's checkout, not a clean clone).`);
      if (result.status !== 0) failing.push({ command, status: result.status, signal: result.signal, timedOut: result.error?.code === "ETIMEDOUT" });
    }
    // A failing registered check stops wrap here, with every result printed
    // and nothing staged, recorded or pushed: the checks ran in the checkout
    // as the owner left it, and the refusal touches nothing after them.
    // --allow-failing commits anyway, and the note names the checks it let
    // through beside their Reported results.
    if (failing.length && !allowFailing) die(failingChecksRefusal(failing));
    if (failing.length) {
      data.checksOverridden = failing.map((c) => c.command);
      console.log(failingChecksOverridden(failing));
    }
    const [previous] = await call("GET", `${P(name)}/sessions`, undefined, as);
    const { state, modified } = sessionFiles(cwd);
    if (state && previous) {
      // A state file Git does not track has no copy at the previous session's
      // HEAD to compare with: its modification time stands in, counted as
      // unchanged while it is not later than that note.
      const tracked = git(["--no-optional-locks", "ls-files", "--error-unmatch", "--", state], { cwd, allowFail: true }).status === 0;
      let unchanged = false, compared = true;
      if (tracked) {
        const before = git(["show", `${previous.data.head}:${state}`], { cwd, allowFail: true });
        unchanged = before.status === 0 && before.stdout === readFileSync(join(cwd, state), "utf8");
        compared = before.status === 0;
      } else unchanged = new Date(modified[state]) <= new Date(previous.at);
      const warning = staleState(state, previous.data.head, unchanged);
      if (warning) console.log(warning);
      if (!compared) console.log(`Could not compare ${state} with the previous session HEAD.`);
    }
    const tree = sessionTree(cwd);
    console.log(`Uncommitted files:\n${tree || "none"}`);
    const branch = wrapReady(name, cwd, false);
    const remotes = args.push ? git(["remote"], { cwd }).split("\n").filter(Boolean) : [];
    if (remotes.length > 100) die("wrap supports at most 100 remote results");
    data = cleanSession(data);
    data.sessionAt = new Date().toISOString();
    // Conflict markers refuse the commit, checked before anything is staged so
    // a refusal leaves the index as the owner had it: tracked changes against
    // HEAD, staged or not, and each new file against nothing. A conflict
    // resolved with `git add` and its markers left in leaves no operation
    // marker or unmerged entry behind, so only the content shows it.
    // The scan reads the lines the commit would add, never Git's diff
    // attributes: a file marked -diff or binary skips git diff --check, so
    // tracked changes are read with --text and new files are read whole. A
    // line opening or closing a conflict (seven < or > then a space or the
    // end) refuses the commit; a bare ======= alone does not, since Markdown
    // underlines headings with it. The scan fails closed: if git cannot
    // diff a path, wrap stops. Paths are literal, so none is read as an
    // option, a pathspec or standard input. No call writes the index, so a
    // refusal leaves even its cached file data as it was: git diff refreshes
    // a stat-dirty index on its own unless diff.autoRefreshIndex is off,
    // whatever --no-optional-locks says, and iCloud leaves files stat-dirty.
    const opensOrCloses = /^(<{7}|>{7})( |$)/;
    const marked = [];
    const readOnly = ["-c", "diff.autoRefreshIndex=false", "--no-optional-locks"];
    const changed = git([...readOnly, "diff", "HEAD", "--name-only", "--no-renames", "-z"], { cwd, raw: true }).split("\0").filter(Boolean);
    for (const file of changed) {
      const added = git([...readOnly, "--literal-pathspecs", "diff", "HEAD", "--text", "--no-ext-diff", "--no-textconv", "-U0", "--", file], { cwd, allowFail: true });
      if (added.status !== 0) die(`wrap could not read the changes to ${sessionText(file, 200)} (git diff exited ${added.status}); nothing was staged`);
      if ((added.stdout || "").split("\n").some((line) => line.startsWith("+") && !line.startsWith("+++") && opensOrCloses.test(line.slice(1)))) marked.push(file);
    }
    for (const file of git(["ls-files", "--others", "--exclude-standard", "-z"], { cwd, raw: true }).split("\0").filter(Boolean)) {
      const path = join(cwd, file);
      let stat;
      try { stat = lstatSync(path); } catch { die(`wrap could not read ${sessionText(file, 200)}; nothing was staged`); }
      if (!stat.isFile()) continue; // a symbolic link is committed as a link, not as the content it names
      if (readFileSync(path).toString("latin1").split("\n").some((line) => opensOrCloses.test(line))) marked.push(file);
    }
    if (marked.length) {
      die(`wrap will not commit conflict markers: ${marked.map((p) => sessionText(p, 200)).join(", ")}; resolve them first. Nothing was staged.`);
    }
    git(["add", "-A"], { cwd });
    // Whitespace is checked on what the commit will hold, after staging: the
    // index against HEAD takes in staged changes and new files, which a diff of
    // the working tree against the index leaves out.
    const diff = git(["diff", "--cached", "--check"], { cwd, allowFail: true });
    data.checks.push({ command: "git diff --cached --check", passed: diff.status === 0, grade: "reported" });
    console.log(`Reported: git diff --cached --check: ${diff.status === 0 ? "passed" : "failed"} (owner's checkout, not a clean clone).`);
    if (diff.stdout || diff.stderr) console.log(diff.stdout || diff.stderr);
    const staged = git(["diff", "--cached", "--quiet"], { cwd, allowFail: true });
    if (staged.status === 1) {
      git(["commit", "-F", "-"], { cwd, input: sessionCommitMessage(data.summary, data.next, data.sessionAt) });
      data.commit = git(["rev-parse", "HEAD"], { cwd });
      console.log(`Committed session as ${data.commit}.`);
    } else if (staged.status === 0) console.log("Nothing to commit.");
    else die("could not inspect staged changes");
    data.pushes = [];
    for (const remote of remotes) {
      // The owner's own remotes: a normal push, LFS objects included (see gitEnv).
      const result = git(["-c", `remote.${remote}.mirror=false`, "push", "--no-force", "--no-follow-tags", remote, `refs/heads/${branch}:refs/heads/${branch}`], { cwd, allowFail: true, ownerRemote: true });
      data.pushes.push({ remote, passed: result.status === 0 });
      console.log(`Remote ${sessionText(remote, 200)}: ${result.status === 0 ? "pushed" : "failed"}.`);
    }
    if (!args.push) console.log("Checkout remotes not pushed (no --push).");
    data.found = [];
    for (const text of found) {
      const item = await call("POST", `${P(name)}/items`, { title: sessionText(text), scope: [] }, as);
      data.found.push(item.id);
      console.log(`Filed ${item.id}: ${sessionText(text)}`);
    }
    data.dirty = !!sessionTree(cwd);
    data.head = git(["rev-parse", "HEAD"], { cwd });
    const note = await call("POST", `${P(name)}/sessions`, cleanSession(data), as);
    console.log(sessionNoteText(note));
    if (cfg.projects[name].fresh === true) await commands.sync();
    else await commands.publish();
    console.log("Nothing deployed or published as a release.");
    console.log(FILING_RELAY);
    console.log(wrapRelay(note));
    // Every remote was tried, the note is recorded and the baseline is in
    // step; only now does a remote that did not take the push fail the command.
    const failed = data.pushes.filter((p) => !p.passed);
    if (failed.length) die(`the session is recorded, but the push failed for ${failed.length} remote${failed.length === 1 ? "" : "s"}: ${failed.map((p) => sessionText(p.remote, 200)).join(", ")}`);
  },

  async token() {
    const action = args._[1];
    if (action === "issue") {
      if (typeof args.as !== "string") die("token issue needs --as HARNESS/MODEL");
      if (args.days !== undefined && (!Number.isInteger(Number(args.days)) || Number(args.days) < 1 || Number(args.days) > 365)) die("--days needs an integer from 1 to 365");
      const result = await call("POST", "/tokens", {
        actor: args.as, ...(args.multi.project ? { projects: args.multi.project } : {}),
        ...(args.days !== undefined ? { days: Number(args.days) } : {}),
        ...(args.label !== undefined ? { label: args.label } : {}),
      }, OWNER);
      console.log(`Token ${result.id} for ${result.actor}, expires ${result.expiresAt}`);
      console.log("This token is not shown again. Set ATELIER_TOKEN to this value in the agent's session:");
      console.log(result.token);
    } else if (action === "ls") {
      const tokens = await call("GET", "/tokens", undefined, OWNER);
      console.log(JSON.stringify(tokens.map(({ token, hash, ...record }) => record), null, 2));
    } else if (action === "revoke" && args._[2]) {
      const result = await call("DELETE", `/tokens/${encodeURIComponent(args._[2])}`, {}, OWNER);
      console.log(result.revoked ? "Token revoked." : "No such token.");
    } else die(COMMAND_USAGE.token);
  },
  // Reached only when `ops` is not the first word; see runOps.
  async ops() {
    die("put ops first: atelier ops COMMAND [ARGS...]; everything after it goes to the operations toolkit", 2);
  },

  // `runner --discover` reports what each home model's harness serves (discover.mjs);
  // `runner --usage` reports each tool's windows, served models and balances (usage.mjs).
  async runner() {
    if (args._[1] === "setup") return setupRunner();
    if (args.discover === true) return discoverModels();
    if (args.usage === true) return reportUsage();
    const { runRunner } = await import("./runner.mjs");
    // The runner's own server calls for plan jobs and parts, as the queue's:
    // fetches under the runner's token, naming the assignment's actor. They
    // throw rather than die, so the runner's loop decides what a failure
    // means; a 422 from posting a plan is a result the runner reports, not an
    // error thrown here.
    const auth = (actor) => ({ authorization: `Bearer ${apiToken()}`, "x-atelier-actor": actor, "content-type": "application/json" });
    const readJson = async (res) => { try { return await res.json(); } catch { return null; } };
    try {
      await runRunner(args, {
        workspacePath,
        // The server's route level against the CLI's, checked once at start:
        // a server behind this CLI would fail the runner's calls one by one.
        // A server that cannot be read is refused as land refuses it, with
        // the same "does not answer" message (GET /api/version is public).
        async version(signal) {
          try {
            const res = await fetch(server() + "/api/version", { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
            if (!res.ok) return null;
            return await res.json();
          } catch {
            return null;
          }
        },
        // A poll that times out, cannot reach the server, or meets a 5xx or a
        // 429 throws an error marked transient, which the runner's loop takes
        // as the server being slow rather than a failure (transientQueueError).
        async queue(offer, signal) {
          await resolveTokenActor();
          let res;
          try {
            res = await fetch(server() + "/api/queue", {
              method: "POST", signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
              headers: { authorization: `Bearer ${apiToken()}`, "x-atelier-actor": tokenActor ?? OWNER, "content-type": "application/json" },
              body: JSON.stringify(offer),
            });
          } catch (error) {
            if (signal.aborted) throw error;
            throw Object.assign(new Error(`queue: ${error.message}`), { transient: true });
          }
          if (!res.ok) throw Object.assign(new Error(`queue: ${res.status}`), { transient: res.status >= 500 || res.status === 429 });
          const incomplete = res.headers.get("x-atelier-incomplete");
          if (incomplete) console.log(`Could not read: ${incomplete}. Tasks waiting there are not listed.`);
          return res.json();
        },
        async jobBrief(project, id, actor) {
          await resolveTokenActor();
          let res;
          try {
            res = await fetch(server() + `/api${I(project, id)}/job-brief`, { headers: auth(actor), signal: AbortSignal.timeout(30_000) });
          } catch (error) { throw Object.assign(new Error(`the job brief could not be read: ${error.message}`), { infrastructure: true }); }
          const data = await readJson(res);
          if (!res.ok) throw Object.assign(new Error(`the job brief could not be read: ${res.status} ${data?.detail ?? ""}`.trim()), { infrastructure: res.status >= 500 || res.status === 429 });
          return data;
        },
        async postPlan(project, id, actor, text) {
          await resolveTokenActor();
          let res;
          try {
            res = await fetch(server() + `/api${I(project, id)}/plan`, { method: "POST", headers: auth(actor), body: text, signal: AbortSignal.timeout(60_000) });
          } catch (error) { throw Object.assign(new Error(`the plan could not be posted: ${error.message}`), { infrastructure: true }); }
          const data = await readJson(res);
          if (res.status === 422 && data && data.valid === false) return data;
          if (!res.ok) throw Object.assign(new Error(`the plan could not be posted: ${res.status} ${data?.detail ?? ""}`.trim()), { infrastructure: res.status >= 500 || res.status === 429 });
          return data;
        },
        // A run that stalled, timed out or was refused goes to the run
        // reports, under the runner's name, as a model's status does.
        reportRun: (body, runner, signal) => postAsRunner("/runs", body, runner, signal),
      });
    } catch (error) { die(error.message); }
  },

  async login() {
    if (args.store) {
      const held = storedToken();
      const env = process.env.ATELIER_TOKEN?.trim() ? " ATELIER_TOKEN is set in the environment and is used instead." : "";
      return console.log(`The token store is ${describeStore("API_TOKEN")}. ${held ? "A token is stored." : "No token is stored."}${env}`);
    }
    if (!args.server || args.server === true) die(COMMAND_USAGE.login);
    const target = trimSlash(args.server);
    // Refused before a token is asked for or sent anywhere.
    const insecure = insecureServer(target);
    if (insecure) die(insecure);
    // The stored token and the server config.json names are a pair: the token
    // was stored when that server accepted it, and apiToken sends it there
    // alone. ATELIER_TOKEN is the user's own pair with the server in use,
    // ATELIER_SERVER or else the one config.json names. Login sends the named
    // server only a token already paired with it: ATELIER_TOKEN when its
    // server is the named one, else the stored token when config.json names
    // it, and otherwise asks for one. So a token never reaches a server it was
    // not given for: a typo in --server would otherwise hand the owner token
    // to whatever host answers there.
    const home = cfg.server ? trimSlash(cfg.server) : null;
    const fromEnv = process.env.ATELIER_TOKEN?.trim();
    const envServer = process.env.ATELIER_SERVER ? trimSlash(process.env.ATELIER_SERVER) : home;
    let token = null, from = null;
    if (fromEnv && target === envServer) { token = fromEnv; from = "ATELIER_TOKEN"; }
    else if (target === home) { token = storedToken(); if (token) from = "store"; }
    if (!token) {
      if (home && target !== home) process.stderr.write(`atelier: ${target} is not ${home}, the server the stored token belongs to; a token for ${target} is needed.\n`);
      try { token = await promptSecret("Server token (not shown): "); } catch (error) { die(`no token entered: ${error.message}`); }
      if (!token) die("no token entered");
      from = "typed";
    }
    // Nothing is saved until the server accepts the token: `call` ends the
    // command on a refusal or a server that cannot answer, and config.json and
    // the store stay as they were.
    loginToken = token;
    loginServer = target;
    const conf = await call("GET", "/config", undefined, "owner");
    // Accepted. The pair is rewritten whole or not at all: whenever config.json
    // is about to name a server other than the stored token's, or the token was
    // typed, the accepted token goes to the store first and config.json names
    // the server after. A token ATELIER_TOKEN holds is stored on that path too;
    // leaving the store alone there would pair the old token with the new
    // server, and the next command without ATELIER_TOKEN would send it there.
    // A token reused for the server config.json already names leaves the store
    // as it is.
    const store = from === "typed" || target !== home;
    let where;
    if (store) { try { where = writeSecret("API_TOKEN", token); } catch (error) { die(error.message); } }
    else where = from === "ATELIER_TOKEN" ? "the ATELIER_TOKEN environment variable" : describeStore("API_TOKEN");
    cfg.server = target;
    cfg.owner = conf.ownerActor;
    cfg.ownerName = conf.ownerName ?? undefined;
    try { saveConfig(cfg); } catch (error) { die(`the token is stored, but config.json could not be written (${error.message}); run login again`); }
    const what = from === "ATELIER_TOKEN" && store ? "The token, from ATELIER_TOKEN," : "The token";
    console.log(`Signed in to ${cfg.server} as the project owner, actor "${cfg.owner}". ${what} ${store ? "is now stored in" : "is read from"} ${where}.`);
    if (from === "typed" && fromEnv) console.log("ATELIER_TOKEN is set in the environment and is used instead of the stored token until it is unset.");
  },

  // The project owner, in the project's checkout.
  async init() {
    // A task workspace is a clone claimWorkspace made, named by the project
    // and item in its Git config. Registering it would make the workspace a
    // project called after its folder, so init stops here and says where to run.
    const wsItem = wsConfig("item"), wsProject = wsConfig("project");
    if (wsItem) {
      const path = cfg.projects?.[wsProject]?.path;
      die(`this folder is ${wsProject}/${wsItem}'s task workspace, not a project checkout; nothing was registered. Run atelier init in ${wsProject}'s checkout${path ? `: cd ${JSON.stringify(path)} && atelier init` : ", which is not registered on this Mac."}`);
    }
    const checks = listArg("check", "init"), given = args.multi.protect ? listArg("protect", "init") : null;
    const top = git(["rev-parse", "--show-toplevel"]);
    let name, existing;
    try { ({ name, existing } = initName(cfg.projects, top, args.name, args["rename-local"] === true)); }
    catch (err) { die(err.message); }
    if (args["rename-local"] === true) {
      cfg.projects[name] = cfg.projects[existing];
      if (name !== existing) delete cfg.projects[existing];
      saveConfig(cfg);
      console.log(`Local registration changed from ${existing} to ${name}. No server project or repository was changed.`);
      return;
    }
    const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: top });
    let cp;
    try { cp = readControlPlane(top); }
    catch (error) { die(`ControlPlane policy could not be read: ${error.message}. Fix the file, then run atelier init again.`); }
    // A ControlPlane project is copied into Artifacts with the owner's
    // approval recorded on it. An init that changes the checks, the title or
    // the policy of a project already registered keeps that approval; it is
    // asked for again when --reset starts the policy over, which drops it,
    // and when --history-since replaces the baseline.
    if (cp && !args.approval) {
      const replaced = args.reset === true ? "--reset starts the policy over" : args["history-since"] !== undefined ? "--history-since replaces the baseline" : null;
      const recorded = replaced ? null : await recordedApproval(name);
      if (!recorded) {
        die(`${name} is governed by ControlPlane, and copying it into Artifacts is an off-machine copy.${replaced ? ` ${replaced}, so the approval recorded on the project does not carry over.` : ""}\nRecord the project owner's approval: atelier init --approval "${OWNER_NAME}, ${new Date().toISOString().slice(0, 10)}: …"`);
      }
    }
    // Only what this command names is sent; the server keeps everything else
    // as it is. --reset starts the policy over from these options and the
    // defaults. A ControlPlane project always sends the policy ControlPlane holds.
    const reset = args.reset === true;
    const protect = given ?? (reset ? [] : cfg.projects?.[name]?.protect ?? []);
    const policy = {};
    if (args.multi.check || reset) policy.checks = checks;
    // Each check must be read-only (src/checks.ts). One that is never
    // read-only is refused here, before any request. The ControlPlane
    // adapter declares the checks it lists as read-only capabilities, and
    // --declare-read-only declares, with the owner's reason, the ones Atelier
    // cannot tell from their words. Without --check, the checks classed are
    // the ones registered now, and only declarations are sent.
    const declaring = args["declare-read-only"];
    if (declaring !== undefined && (typeof declaring !== "string" || !declaring.trim())) die('--declare-read-only needs a reason: atelier init --declare-read-only "why the checks change nothing outside the clone"');
    let registered = null, onServer = false;
    if (!policy.checks && (cp?.adapter || declaring !== undefined)) {
      const list = await call("GET", "/projects", undefined, OWNER);
      onServer = Array.isArray(list) && list.some((p) => p.name === name);
      registered = (Array.isArray(list) ? list.find((p) => p.name === name)?.policy : null) ?? { checks: [] };
    }
    const classed = policy.checks ?? registered?.checks ?? [];
    const fromAdapter = cp?.adapter ? adapterClasses(cp.adapter, classed) : { declarations: [], refusals: [] };
    const byWords = classed.flatMap((cmd) => { const why = refusalOf(cmd); return why ? [refusalText(cmd, why)] : []; });
    const byAdapter = fromAdapter.refusals.filter((r) => !refusalOf(r.command)).map((r) => r.text);
    if (policy.checks && (byWords.length || byAdapter.length)) die(`${[...byWords, ...byAdapter].join(".\n")}.\nNothing was sent.`);
    // A registered check is refused at run time by its words alone; what the adapter says is read here only.
    for (const refusal of byWords) console.log(`Warning: ${refusal}. It is registered, and Atelier runs it nowhere; replace it with atelier init --check.`);
    for (const refusal of byAdapter) console.log(`Warning: ${refusal}. It is registered, and Atelier still runs it, since its words do not show this; replace it with atelier init --check.`);
    const settled = new Set([...fromAdapter.refusals, ...fromAdapter.declarations, ...(registered?.checkClasses ?? [])].map((d) => d.command));
    const needing = classed.filter((cmd) => !refusalOf(cmd) && !knownReadOnly(cmd) && !settled.has(cmd));
    const owned = declaring === undefined ? [] : needing.map((command) => ({ command, by: "owner", note: declaring.trim() }));
    if (declaring !== undefined && !owned.length) console.log("--declare-read-only declared nothing: every check is already known to be read-only.");
    if (fromAdapter.declarations.length || owned.length) policy.checkClasses = [...fromAdapter.declarations, ...owned];
    // The adapter's change_rules say which checks apply to which paths. A
    // first init, or one that names the checks with --check or starts over
    // with --reset, takes them, as it takes protected paths. A re-init that
    // names no check narrows nothing: rules that condition a check to some
    // paths can drop coverage outright, since a change to none of the checks'
    // paths then runs no check at all (on 2026-10-06 Omniscope's check would
    // have applied only to **.py, omniscope/**, tests/**, frontend/** and
    // **.sh, leaving family/** and package.json with no check). The recorded
    // paths stand, and each narrowing the rules would make is named here.
    const fromRules = cp?.adapter ? adapterCheckPaths(cp.adapter, classed) : null;
    const reinit = onServer && !policy.checks;
    if (fromRules && !reinit) policy.checkPaths = fromRules.paths;
    if (fromRules && reinit) {
      for (const rule of fromRules.paths) {
        const current = registered.checkPaths?.find((c) => c.command === rule.command);
        if (current && current.paths.join("\u0000") === rule.paths.join("\u0000")) continue;
        console.log(`Warning: ControlPlane's change rules would set \`${rule.command}\` to apply only when the change touches ${rule.paths.join(", ")}; as registered it applies to ${current ? `${current.paths.join(", ")} only` : "every change"}, and a re-init does not narrow a check's coverage. Take the rules with atelier init --reset.`);
      }
    }
    // The ship order's commands and kinds are recorded with the policy from
    // the checkout's own files, so the gate guards what ship runs like a
    // check's files and the inbox can say a merged revision is not delivered.
    const ship = shipPolicy(top);
    policy.shipRuns = ship.runs;
    policy.shipKinds = ship.kinds;
    if (cp || args.multi.protect || reset) policy.protected = [...new Set([...(cp?.protected ?? ["AGENTS.md", "CLAUDE.md", "wrangler.*"]), ...protect])];
    if (cp) {
      policy.eligible = cp.eligible ?? [];
      if (cp.agents) policy.agents = cp.agents;
      if (cp.execution) policy.execution = cp.execution;
    }
    // --refuse-overlap and --sandbox-only are switches: given, they turn the
    // setting on; given as --sandbox-only=false or --sandbox-only false, off.
    if (cp || args["refuse-overlap"] !== undefined || reset) policy.refuseOverlap = cp?.refuseOverlap ?? args["refuse-overlap"] === true;
    if (args["require-criteria"] !== undefined || reset) policy.requireCriteria = args["require-criteria"] === true;
    if (args["sandbox-only"] !== undefined || reset) policy.sandboxOnly = args["sandbox-only"] === true;
    // --no-override is a switch too (t371): given, overrides of the
    // independent review are refused in the project; --no-override=false
    // allows them again, with the owner's confirmation.
    if (args["no-override"] !== undefined || reset) policy.noOverride = args["no-override"] === true;
    // --core names the core files, once per glob, replacing the recorded
    // ones; --core "" alone clears them, and --reset without it does too.
    const core = coreArg();
    if (core || reset) policy.coreFiles = core ?? [];
    const r = await call("PUT", P(name), {
      ...policy,
      ...(reset ? { reset: true } : {}),
      // The command that regenerates the project's fixtures after a task
      // merges main (atelier land); omitted keeps it, "" clears it.
      ...(args.regenerate !== undefined ? { regenerate: args.regenerate } : {}),
      // What may block a review, stated in every review brief; omitted keeps
      // it, "" restores the default bar.
      ...(args["review-bar"] !== undefined ? { reviewBar: args["review-bar"] } : {}),
      // The top review tier, harness/model actors separated by commas, each
      // reviewing every protected change beside the gate's review; omitted
      // keeps it, "" clears it.
      ...(args["review-tier"] !== undefined ? { reviewTier: args["review-tier"] } : {}),
      approval: args.approval,
      // Omitted keeps the current title; --title "" clears it.
      ...(args.title === undefined ? {} : { title: args.title }),
      defaultBranch: branch,
    }, OWNER);
    // A project too large for Artifacts joins with its recent history only
    // (cli/fresh.mjs). Once set up that way it stays that way: a later init
    // changes the policy and pushes nothing; atelier sync carries new commits.
    const fresh = cfg.projects?.[name]?.fresh === true;
    const since = typeof args["history-since"] === "string" ? args["history-since"] : null;
    if (args["history-since"] === "") die("give the day the baseline's history starts: --history-since YYYY-MM-DD");
    let pushed = "HEAD";
    if (fresh) {
      if (since) die(`${name} already has a baseline from part of its history; use atelier sync to carry new commits`);
    } else if (since) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) die("--history-since takes a day, YYYY-MM-DD");
      if (git(["status", "--porcelain"], { cwd: top })) die("commit or set aside the checkout's changes first; the baseline is built from its commits");
      const gitDir = git(["rev-parse", "--absolute-git-dir"], { cwd: top });
      const start = git(["rev-list", "-1", "--first-parent", `--before=${since}T00:00:00`, "HEAD"], { cwd: top });
      if (!start) die(`${branch} has no commit before ${since}`);
      const head = git(["rev-parse", "HEAD"], { cwd: top });
      const built = buildHistory(git, top, start, head);
      // The baseline may already hold the project's original history, which an
      // init that pushed in steps and stopped partway leaves behind without
      // registering the project: --history-since replaces the baseline, so the
      // rebuilt history is pushed over that remainder, on a lease on the tip
      // read here. A baseline this checkout cannot account for (set up from
      // another machine) is left to git to refuse.
      const lease = [];
      if (!cfg.projects?.[name]) {
        const listed = git(["ls-remote", r.baseline.remote, `refs/heads/${branch}`], { cwd: top, token: r.baseline.token, allowFail: true });
        const held = listed.status === 0 ? /^([0-9a-f]{40,64})\s/.exec(listed.stdout)?.[1] ?? null : null;
        if (held && holds(held, head, top)) lease.push(`--force-with-lease=${branch}:${held}`);
      }
      git(["push", "--quiet", "--recurse-submodules=no", ...lease, r.baseline.remote, `${built.head}:refs/heads/${branch}`], { cwd: top, token: r.baseline.token });
      savePairs(gitDir, name, { ...loadPairs(gitDir, name), ...built.pairs });
      pushed = built.head;
      console.log(`Baseline history starts at ${short(start)} (${since}): ${Object.keys(built.pairs).length - 1} commits on ${branch}'s first-parent line rebuilt with the same trees, authors, dates and messages.`);
    } else {
      try { pushHistory(git, top, { remote: r.baseline.remote, token: r.baseline.token, branch, say: console.log }); }
      catch (err) { die(err.message); }
    }
    cfg.projects ??= {};
    cfg.projects[name] = { ...cfg.projects[name], path: top, branch, protect, ...(since || fresh ? { fresh: true } : {}) };
    saveConfig(cfg);
    const pol = r.project.policy;
    console.log(fresh
      ? `${r.project.title ? `${r.project.title} (${name})` : name}: policy updated; the baseline was not pushed (it holds part of the history; atelier sync carries new commits).`
      : `${r.project.title ? `${r.project.title} (${name})` : name}: baseline ${r.project.repo} now holds ${branch} @ ${short(git(["rev-parse", pushed], { cwd: top }))}.`);
    if (cp) console.log(`Policy read from ControlPlane (${cp.sources.join(", ")}).`);
    console.log(`Checks:     ${pol.checks.join(" | ") || "none"}`);
    for (const v of checkClasses(pol)) console.log(`  ${v.command}: ${classText(v)}${pol.checkPaths?.some((c) => c.command === v.command) ? `; ${appliesText(pol, v.command)}` : ""}`);
    if (fromRules?.unrun.length) console.log(`ControlPlane change rules also require ${fromRules.unrun.map((u) => `${u.name} (\`${u.command}\`)`).join(", ")}, which no registered check runs; add one with --check to require it.`);
    console.log(`Ship:       ${pol.shipKinds?.length ? `needs ${pol.shipKinds.join(", ")}; ` : ""}${pol.shipRuns?.length ?? 0} protected command${(pol.shipRuns?.length ?? 0) === 1 ? "" : "s"}`);
    if (pol.regenerate) console.log(`Regenerate: ${pol.regenerate}`);
    console.log(`Review bar: ${pol.reviewBar ?? "the default, which blocks for a correctness, security or data-loss defect, a behaviour change without a test that covers it, docs or help that now contradict the code, a breaking change to a command, route or API field without a migration, or a visible regression on a user-facing page; anything else is a follow-up"}`);
    // A server older than the review bar ignores it and answers without one.
    if (typeof args["review-bar"] === "string" && args["review-bar"].trim() && !pol.reviewBar) console.log("Warning: the server did not record the review bar; deploy the server, then run atelier init --review-bar again.");
    console.log(`Review tier: ${pol.reviewTier?.length ? `${pol.reviewTier.join(", ")}, one of which reviews every protected change: the gate's review goes to the tier first, and a separate tier review is asked only when the gate's reviewer is outside it` : "none"}`);
    if (typeof args["review-tier"] === "string" && args["review-tier"].trim() && !pol.reviewTier?.length) console.log("Warning: the server did not record the review tier; deploy the server, then run atelier init --review-tier again.");
    const checkInputs = checkFiles(pol.checks ?? []);
    console.log(`Protected:  ${[...new Set([...(pol.protected ?? []), ...checkInputs])].sort().join(", ")}`);
    console.log(`Eligible:   ${pol.eligible?.join(", ") || "any agent"}`);
    console.log(`Overlap:    ${pol.refuseOverlap ? "refused" : "flagged"}`);
    console.log(`Overrides:  ${pol.noOverride ? "refused; every change needs its independent review" : "allowed with a reason, once the owner confirms on the task's page with the Access sign-in or the server's confirmation secret"}`);
    // A server older than --no-override ignores it and answers without it.
    if (args["no-override"] === true && !pol.noOverride) console.log("Warning: the server did not record --no-override; deploy the server, then run atelier init --no-override again.");
    console.log(`Criteria:   ${pol.requireCriteria ? "required on every task" : "optional"}`);
    // A server older than the criteria requirement ignores it and answers without one.
    if (args["require-criteria"] === true && !pol.requireCriteria) console.log("Warning: the server did not record the criteria requirement; deploy the server, then run atelier init --require-criteria again.");
    console.log(`Core files: ${pol.coreFiles?.length ? `${pol.coreFiles.join(", ")}; the queue holds a dispatch whose scope overlaps a live item's in one` : "none; the queue holds no dispatch for its scope"}`);
    // A server older than core files ignores them and answers without any.
    if (core?.length && !pol.coreFiles?.length) console.log("Warning: the server did not record the core files; deploy the server, then run atelier init --core again.");
    if (pol.approval) console.log(`Approval:   ${pol.approval}`);
    let agentsMd = null;
    try { agentsMd = readFileSync(join(top, "AGENTS.md"), "utf8"); } catch {}
    const offer = agentsMdOffer(agentsMd);
    if (offer) console.log(`\n${offer}`);
  },

  // Move one project from ControlPlane to Atelier. This is itself an Atelier
  // task: adopt creates it, claims it, and writes the forwarding entry point
  // and the Atelier guide into its workspace, where the agent that finishes
  // the task works. The checkout is read and reported on, never changed.
  async adopt() {
    const name = project();
    const p = cfg.projects?.[name];
    if (!p?.path) die(`${name} is not registered on this Mac; run atelier init in its checkout first`);
    if (git(["status", "--porcelain"], { cwd: p.path })) die(`${p.path} has uncommitted changes; commit or set them aside before moving ${name}`);
    // Every check that can refuse the move runs on the checkout first — the
    // files readable and computable, no symlink in the way — so a refusal
    // leaves nothing behind: no task, no claim, no workspace.
    try { adoption({ project: name, checkout: p.path, workspace: p.path, guide: guideText() }); }
    catch (error) { die(error.message); }
    const as = await actor(OWNER);
    // The project's policy says who may claim here. It is asked before the
    // task exists, as the claim would ask it, so an agent it does not admit
    // leaves no unclaimed task behind.
    const { project: record } = await call("GET", P(name), undefined, as);
    try { assertEligible(as, record?.policy ?? {}, OWNER); }
    catch (error) { die(`${error.message}. The move was not started; run it as an eligible agent: atelier adopt --project ${name} --as HARNESS/MODEL`); }
    const item = await call("POST", `${P(name)}/items`, { title: `Move ${name} from ControlPlane to Atelier`, scope: SCOPE }, as);
    const { dir } = await claimWorkspace(name, item.id, as);
    let plan;
    try { plan = adoption({ project: name, checkout: p.path, workspace: dir, guide: guideText() }); }
    catch (error) { die(error.message); }
    try { writeMove(dir, plan.files); }
    catch (error) { die(error.message); }
    git(["add", "--", ...plan.files.map((f) => f.path)], { cwd: dir });
    // Adopting a project that already moved leaves the workspace as it is;
    // committing nothing keeps that a success rather than a git failure.
    const moved = git(["diff", "--cached", "--quiet"], { cwd: dir, allowFail: true }).status !== 0;
    if (moved) git(["commit", "--quiet", "-m", plan.message], { cwd: dir });
    console.log(`${item.id} is yours, ${as}. ${moved
      ? "The move is committed here and not pushed:"
      : "The move is already in place; nothing to commit:"}\n  cd ${JSON.stringify(dir)}`);
    console.log(plan.leftovers.length
      ? `\nLeftovers in ${p.path} for the agent finishing ${item.id}:`
      : `\nNothing in ${p.path} is left over from ControlPlane.`);
    for (const line of plan.leftovers) console.log(`  ${line}`);
    // A task has no note field of its own, so the same list is recorded on it
    // as reported claims, which the task's page shows to the reviewer and the
    // owner. Reports are never counted as evidence.
    for (const line of plan.leftovers) await call("POST", `${I(name, item.id)}/evidence`, { kind: "report", claim: line, head: item.head }, as);
    if (plan.leftovers.length) console.log(`The same lines are recorded on ${item.id} as reported notes.`);
  },

  // The project owner: push commits made directly in the checkout so new forks start from them.
  async publish() {
    const name = project();
    const p = cfg.projects?.[name] ?? die(`${name} is not registered on this Mac; run atelier init in it`);
    if (p.fresh === true) die(`${name}'s baseline holds part of its history; atelier sync carries new commits to it`);
    const t = await call("POST", `${P(name)}/baseline-token`, { scope: "write" }, OWNER);
    git(["push", "--quiet", "--recurse-submodules=no", t.remote, `${p.branch}:${p.branch}`], { cwd: p.path, token: t.token });
    console.log(`Baseline ${name} now at ${short(git(["rev-parse", p.branch], { cwd: p.path }))}.`);
  },

  async revert() {
    if (args._.length !== 2) die(COMMAND_USAGE.revert);
    const name = project(), as = await actor(OWNER);
    await runRevert(args._[1], as, {
      create: (body) => call("POST", `${P(name)}/items`, body, as),
      claim: (id, who) => claimWorkspace(name, id, who),
      git, say: console.log,
    });
  },

  // The title is the words given; with --brief the long text goes apart.
  // One long string alone is sent as the title, as an older CLI sends it:
  // the server keeps it as the brief and derives the short title, and the
  // answer says so.
  async new() {
    const title = args._.slice(1).join(" ");
    const fields = fieldsArg("new");
    if (!title && !fields.brief) die(COMMAND_USAGE.new);
    const scope = listArg("scope", "new");
    const item = await call("POST", `${P(project())}/items`, { title, scope, ...fields }, await actor(OWNER));
    console.log([
      `${item.id}  ${item.title}${item.scope.length ? `  [${item.scope.join(" ")}]` : ""}`,
      ...(item.derived ? [`The text is longer than a title, so it is kept as the brief and the title is its first clause; change it with atelier edit ${item.id} --title "TEXT".`] : []),
      ...formatFields(item),
    ].join("\n"));
    if (!fields.accept?.length) console.error(`Warning: ${item.id} has no acceptance criteria, so a review of it will have none to judge the change against. Give them with atelier edit ${item.id} --accept "TEXT", once per criterion.`);
    pointToGuide([project()]);
  },

  // The project owner changes a task's framing; the server keeps every field
  // not named and refuses a closed task.
  async edit() {
    const name = project(), id = itemArg();
    const fields = fieldsArg("edit");
    if (!Object.keys(fields).length) die(COMMAND_USAGE.edit);
    const item = await call("POST", `${I(name, id)}/edit`, fields, OWNER);
    const lines = [
      ...(fields.title !== undefined ? [`Title: ${flat(item.title)}`] : []),
      ...(fields.brief !== undefined ? [item.brief ? `Brief: ${item.brief.length} characters, shown on the task's page.` : "Brief: cleared."] : []),
      ...(fields.scope !== undefined ? [`Scope: ${item.scope.map(flat).join(", ") || "not specified (it overlaps every live task)"}`] : []),
      ...formatFields(item),
    ];
    console.log(`${id} edited.${lines.length ? `\n${lines.join("\n")}` : " No framing is set now."}`);
    if (item.criteriaChange) console.log(criteriaNotice(id, item.criteriaChange));
  },

  // The holder or the owner blocks a task with what it is waiting on. The
  // id comes first when given; in a workspace it is the workspace's item.
  async block() {
    const words = args._.slice(1);
    const named = /^t\d+$/.test(words[0] ?? "") ? words.shift() : null;
    const reason = words.join(" ");
    if (!reason.trim()) die(COMMAND_USAGE.block);
    const name = project(), id = named ?? wsConfig("item");
    if (!id) die(`which item? pass its id (t3) or run inside its workspace: ${COMMAND_USAGE.block}`);
    const item = await call("POST", `${I(name, id)}/block`, { reason }, await actor(OWNER));
    console.log(`${id} is blocked: ${flat(item.blocked?.reason ?? reason)}. It keeps its owner and workspace; run atelier unblock ${id} when it can go on.`);
  },

  async unblock() {
    const name = project(), id = itemArg();
    const item = await call("POST", `${I(name, id)}/unblock`, {}, await actor(OWNER));
    console.log(`${id} is unblocked and ${flat(item.state)} again.`);
  },

  // The items as one line each, or as JSON for a machine reader such as
  // Observatory, which draws on the times each item carries.
  async ls() {
    const name = project();
    const { items } = await call("GET", P(name), undefined, await actor(OWNER));
    const shown = items.filter((i) => args.all || (i.state !== "merged" && i.state !== "abandoned"));
    if (args.json) return console.log(JSON.stringify(shown.map(itemJson), null, 2));
    for (const i of shown) {
      console.log(`${i.id.padEnd(5)} ${i.state.padEnd(10)} ${(i.owner ?? "—").padEnd(26)} ${short(i.head)}  ${i.title}`);
    }
    pointToGuide([name]);
  },

  async show() {
    const name = project(), id = itemArg(), as = await actor(OWNER);
    const brief = await call("GET", `${I(name, id)}/brief`, undefined, as);
    // The brief sums the reviews at the current head into one line and carries
    // none of their findings. The item's own record holds every review at
    // every head; --reviews prints it in full and --json carries it, so a
    // session can read why a review rejected the task (t173).
    let d = {};
    try { d = await request("GET", I(name, id), undefined, as); }
    catch (error) {
      // Older servers may serve the brief without the detail route. Keep
      // that brief usable, but do not conceal authentication or server errors.
      if (!(error instanceof RequestError)) throw error;
      if (error.code !== 1 || error.message !== "not_found: no such route") die(error.message, error.code);
    }
    // Revert requests are historical links, not proof that the undo merged.
    // Keep them outside the server brief's five-line evidence limit.
    for (const event of d.events ?? []) {
      if (event.itemId !== id || !["item.reverts", "item.revert_requested"].includes(event.kind)) continue;
      const { itemId, mergeCommit } = event.data ?? {};
      if (!/^t[1-9]\d*$/.test(itemId ?? "") || !/^[a-f0-9]{40,64}$/.test(mergeCommit ?? "")) continue;
      const label = event.kind === "item.reverts" ? "Reverts" : "Revert requested in";
      brief.evidence.push(`${label} ${itemId} (recorded merge ${mergeCommit}): ${server()}/p/${encodeURIComponent(name)}/${itemId}`);
    }
    if (args.json) return console.log(JSON.stringify({ ...brief, reviews: newestReviews(d?.reviews ?? []), unparsable: newestReviews(d?.unparsable ?? []) }, null, 2));
    const text = formatBrief(name, id, brief, server());
    console.log(args.reviews ? `${text}\n\n${formatReviews(d?.reviews ?? [], d?.ownerActor, d?.unparsable ?? [])}` : text);
  },

  // The task's whole story from the ledger, in order (cli/receipt.mjs): one
  // line per event that says what became of it, the same detail route `show
  // --reviews` reads, printed from created to merged or abandoned.
  async receipt() {
    const name = project(), id = itemArg(), as = await actor(OWNER);
    const d = await call("GET", I(name, id), undefined, as);
    if (args.json) return console.log(JSON.stringify(receiptJson(name, id, d), null, 2));
    console.log(receiptText(name, id, d, server()));
  },

  async start() {
    await commands.claim();
    const d = await call("GET", I(project(), itemArg()), undefined, await actor());
    console.log(formatTask(d.item));
  },

  // Agents: take an item and get a private workspace for it.
  async claim() {
    const name = project();
    const id = itemArg();
    const as = await actor();
    const { workspace, dir, identity } = await claimWorkspace(name, id, as, args.runner ?? null);
    console.log(`${id} is yours, ${as}. Work here:\n  cd ${JSON.stringify(dir)}`);
    if (identity.email) console.log(`Commits here are authored as ${identity.name ?? "(global name)"} <${identity.email}>, as in the project checkout.`);
    console.log(`Write token expires ${workspace.expiresAt}; run \`atelier claim ${id}\` again to refresh it.`);
    console.log(args._[0] === "start" ? 'Then: commit, then atelier done "summary"' : `Then: commit → atelier push → atelier check → atelier submit`);
  },

  async push() {
    const name = project(), id = itemArg(), as = await actor();
    requireWorkspace("push", name, id, as);
    // A push to any branch but the one the fork's HEAD names lands where
    // Atelier never reads, so it is refused before anything is sent. When
    // origin does not name its branch, the push goes ahead and the
    // comparison below still reports a head Atelier did not see.
    const recorded = wsConfig("branch"), reads = forkBranch();
    if (recorded && reads && recorded !== reads) {
      die(`${id}'s fork reads its head from ${reads}, but this workspace pushes to ${recorded} (git config atelier.branch); nothing was pushed. Run atelier claim ${id} to refresh the workspace's branch, then push again.`);
    }
    const branch = recorded ?? reads ?? "main";
    const head = git(["rev-parse", "HEAD"]);
    // --force is for the head `atelier update` rebuilt, which no longer holds
    // the head Atelier recorded for the item. Two things guard what the
    // force replaces. The lease names the recorded head, read from the
    // Ledger, not the ref this workspace last fetched: the fork's branch must
    // still stand exactly where Atelier last saw it, or the push is refused
    // and nothing pushed since is overwritten. And every commit reachable
    // from the recorded head must survive in HEAD, as git identifies commits
    // across a rebase, by patch: a workspace whose rebuilt history dropped
    // one is refused before anything is sent. Merge commits are left out of
    // that comparison, since a rebase replays what they merged and not the
    // merge itself. The push then declares the head it rebased from, so the
    // Ledger can tell this rewrite from one it must refuse (recordPush in
    // src/ledger.ts).
    // --rollback returns the fork to an earlier commit of the history Atelier
    // recorded, dropping what was recorded after it, as the plan integrator
    // does when a merged part fails the plan's checks: HEAD must be an
    // ancestor of the recorded head, and the push declares the head it
    // replaces, under the same lease as --force.
    let rebasedFrom = null, known = null;
    const lease = [];
    if (args.rollback === true) {
      known = (await call("GET", I(name, id), undefined, as)).item.head;
      if (!known) die(`nothing is recorded for ${id} yet; there is nothing to roll back`);
      if (!hasCommit(known)) die(`Atelier recorded ${id}'s head as ${short(known)}, which this workspace does not hold; nothing was pushed`);
      if (head === known) die(`${id}'s workspace is at the recorded head ${short(known)}; reset it to the commit to roll back to first. Nothing was pushed.`);
      if (!holds(head, known)) die(`push --rollback returns ${id} to a commit of its recorded history, and ${short(head)} is not an ancestor of the recorded head ${short(known)}. Nothing was pushed.`);
      rebasedFrom = known;
      lease.push(`--force-with-lease=${branch}:${known}`);
    } else if (args.force === true) {
      known = (await call("GET", I(name, id), undefined, as)).item.head;
      if (!known) die(`nothing is recorded for ${id} yet; push without --force`);
      if (!hasCommit(known)) die(`Atelier recorded ${id}'s head as ${short(known)}, which this workspace does not hold; run atelier update to take what the fork holds, then push again`);
      if (!holds(known, "HEAD")) {
        const dropped = git(["rev-list", "--cherry-pick", "--left-only", "--no-merges", `${known}...HEAD`]).split("\n").filter(Boolean);
        if (dropped.length) die(`push --force would drop ${count(dropped.length, "commit")} Atelier recorded for ${id} at ${short(known)}:\n${git(["log", "--oneline", "--no-walk", ...dropped])}\nRun atelier update to carry them onto the baseline with yours, then push again. Nothing was pushed.`);
        rebasedFrom = known;
      }
      lease.push(`--force-with-lease=${branch}:${known}`);
    }
    const pushArgs = ["push", "--quiet", "--recurse-submodules=no", ...lease, "origin", `HEAD:${branch}`];
    if (!lease.length) git(pushArgs);
    else {
      const r = git(pushArgs, { allowFail: true });
      if (r.status !== 0) die(`${id}'s fork no longer stands at ${short(known)}, the head Atelier recorded: something was pushed to it since. Run atelier update to take what it holds, then atelier push --force again. Nothing was pushed.\n${(r.stderr || r.stdout).trim()}`);
    }
    const item = await call("POST", `${I(name, id)}/push`, { head, ...(rebasedFrom ? { rebasedFrom } : {}) }, as);
    if (item.head !== head) die(`pushed ${short(head)} but Artifacts reports ${short(item.head)}; recorded what Artifacts reports`);
    console.log(`${id} head ${short(item.head)} (observed in Artifacts).`);
    // The push's secret scan (t332), as the answer reports it: a flag names
    // file and line, never the value; a scan still pending blocks the gate
    // until a later push, or Atelier's own retry, completes it.
    if (item.secretScan === item.head) console.log(`${id}: the secret scan of ${short(item.head)} has not completed; acceptance waits for it. Run atelier push again to retry it.`);
    for (const f of (item.secret ?? []).filter((f) => f.head === item.head && !f.cleared)) {
      console.log(f.unscanned ? `${id}: the secret scan could not read ${f.file} in full${f.reason ? ` (${f.reason})` : ""}; the flag blocks acceptance until the owner clears it or a push removes the line.`
        : `${id}: a key pattern was added at ${f.file}:${f.line}; the flag blocks acceptance until the owner clears it or a push removes the line.`);
    }
  },

  // Agents: bring the workspace up to date with what has merged since the
  // fork. The fork's own branch comes first: a workspace that lacks commits
  // another holder pushed there (a re-claim after a handoff, a retry on
  // another machine) takes them before its own commits move, since the
  // rebase onto the baseline replays only what HEAD holds, and the push
  // --force that follows would then drop the rest from the fork. A rebase
  // that stops leaves git's own state to finish; update run again carries on
  // from there.
  async update() {
    const name = project(), id = itemArg(), as = await actor();
    requireWorkspace("update", name, id, as);
    const branch = wsConfig("branch") ?? forkBranch() ?? "main";
    const remote = `refs/remotes/origin/${branch}`;
    git(["fetch", "--quiet", "origin"]);
    if (git(["rev-parse", "--verify", "--quiet", remote], { allowFail: true }).status === 0 && !holds(remote, "HEAD")) {
      const missing = git(["log", "--oneline", `HEAD..${remote}`]);
      const n = count(missing.split("\n").filter(Boolean).length, "commit");
      const r = git(["rebase", "--quiet", remote], { allowFail: true });
      if (r.status !== 0) die(`${id}'s fork holds ${n} this workspace lacks:\n${missing}\nRebasing this workspace's commits onto them did not complete:\n${(r.stderr || r.stdout).trim()}\nFinish that (resolve conflicts and git rebase --continue; or commit or set aside uncommitted changes), then run atelier update again.`);
      console.log(`${id}: this workspace's commits now sit on the ${n} the fork held that it lacked:\n${missing}`);
    }
    const t = await call("POST", `${I(name, id)}/base-token`, { scope: "read" }, as);
    git(["fetch", "--quiet", t.remote, t.defaultBranch], { token: t.token });
    // After the rebase the fork no longer holds the head Atelier recorded,
    // so the push needs --force, whose lease refuses to overwrite anything
    // pushed since (see push). Both ends of the rebase name that one command.
    const next = "Push with: atelier push --force";
    const r = git(["rebase", "FETCH_HEAD"], { allowFail: true });
    if (r.status !== 0) die(`rebase stopped on a conflict. Resolve it, then git rebase --continue. ${next}\n${r.stdout}${r.stderr}`);
    console.log(`${id} rebased onto baseline ${short(git(["rev-parse", "FETCH_HEAD"]))}. ${next}`);
  },

  // Observed evidence: run each required check (or the given command) in a
  // clean clone of exactly the head Artifacts holds, and record the result.
  async check() {
    if (args.sandbox) return checkInSandbox();
    const name = project(), id = itemArg(), as = await actor();
    const d = await call("GET", I(name, id), undefined, as);
    if (d.policy.sandboxOnly) return checkInSandbox();
    const cmds = args.rest?.length ? [args.rest.join(" ")] : d.policy.checks;
    if (!cmds.length) die("this project has no required checks; pass one: atelier check -- npm test");
    // A command that is never read-only is not run, here or anywhere.
    const refused = cmds.flatMap((cmd) => { const why = refusalOf(cmd); return why ? [refusalText(cmd, why)] : []; });
    if (refused.length) die(`${refused.join(".\n")}.${args.rest?.length ? "" : `\nNothing was run. Ask ${OWNER_NAME} to replace the check with atelier init --check.`}`);
    const ws = await call("POST", `${I(name, id)}/read-token`, {}, as);
    if (!ws.head) die("nothing pushed yet");
    // The base a part is measured against is its plan's fork, not the baseline
    // (docs/orchestrator.md, section 5).
    const base = await call("POST", `${I(name, id)}/base-token`, { scope: "read" }, as);
    const { dir, changed, againstMain } = cleanClone(ws.remote, ws.token, ws.head, base, name);
    // The clone goes however this command ends: below once the checks are
    // recorded, or on the way out when a step ends the command first.
    const cleanup = () => removeClone(dir);
    process.once("exit", cleanup);
    const policy = d.policy;
    // What a check could print and this command would then upload: the API
    // token, the read tokens for the fork and the baseline, and the write
    // token in the workspace's Git settings.
    const secrets = [apiToken(), ws.token, base.token, ...workspaceTokens(workspacePath(name, id))];
    let failed = 0, recorded, mainHead;
    try {
      // --merged checks the would-be merge: the head merged with main's head,
      // in this clone. The evidence is bound to both revisions, and the
      // Worker refuses a main head that is not on main's line.
      if (args.merged) mainHead = mergeWithMain(dir, id);
      const on = mainHead ? ` merged with main ${short(mainHead)}` : "";
      // A landing's required checks compete with the home runners for this
      // machine (t403): while the load average is at or above the limit they
      // wait, saying so, and each result records the load it started at. The
      // limit is ATELIER_LOAD_LIMIT when set, else the core count.
      const configuredLimit = process.env.ATELIER_LOAD_LIMIT;
      const limit = loadLimitOf(configuredLimit !== undefined && Number(configuredLimit) > 0 ? Number(configuredLimit) : undefined, coreCount());
      // One reader for the whole command, so a sequence of readings (a test's
      // ATELIER_LOAD) advances across the checks and each records its own.
      const readLoad = envLoad();
      for (const cmd of cmds) {
        // A registered check whose paths this change does not touch is not
        // run. It is recorded as not applicable, which the Worker accepts only
        // when the paths it measures itself show the same.
        if (!args.rest?.length && againstMain && checkApplies(policy, cmd, againstMain) === false) {
          const n = await postEvidence(`${I(name, id)}/evidence`, { kind: "check", claim: cmd, head: ws.head, notApplicable: true }, as);
          const row = n?.evidence?.filter?.((e) => e.head === ws.head && e.claim === cmd).at(-1);
          if (row) recorded = row.changedPaths;
          doneChecks.push({ claim: cmd, result: "not applicable", where: CLEAN_CLONE });
          console.log(`N/A   ${cmd}  @ ${short(ws.head)}  (it ${appliesText(policy, cmd)}; this change touches none of them)`);
          continue;
        }
        // The wait is per check (t403): a check that starts later must wait on
        // the load as the earlier one did, and its own starting load is what
        // its result records, not the first check's.
        const startLoad = await waitForLoad(limit, {
          readLoad,
          report: (current) => process.stderr.write(`atelier: load ${formatLoad(current)} is at or above the limit ${formatLoad(limit)}; waiting for it to fall before running the checks\n`),
        });
        const r = await runCheck(cmd, dir, secrets);
        // The Worker measures the changed paths from Artifacts and ignores this
        // list, which is sent only so a deployment without that measurement
        // still records one. The list printed below is the one the Worker
        // recorded, which is the one the gate reads; this clone's is shown only
        // when the reply carries none. A merged check measures no paths.
        const d = await postEvidence(`${I(name, id)}/evidence`, {
          kind: "check", claim: cmd, head: ws.head, passed: r.passed, changedPaths: changed,
          outputTail: `${r.output.slice(-3500)}\n[sha256 of full output: ${r.sha}]`,
          load: startLoad,
          ...(mainHead ? { merged: true, mainHead } : {}),
        }, as);
        const row = d?.evidence?.filter?.((e) => e.head === ws.head && e.claim === cmd && !e.merged).at(-1);
        if (row) recorded = row.changedPaths;
        doneChecks.push({ claim: cmd, result: r.passed ? "passed" : "failed", where: CLEAN_CLONE });
        console.log(`${r.passed ? "PASS" : "FAIL"}  ${cmd}  @ ${short(ws.head)}${on}`);
        if (!r.passed) { failed++; process.stdout.write(r.output.slice(-2000) + "\n"); }
      }
    } finally {
      process.off("exit", cleanup);
      cleanup();
    }
    const paths = recorded === undefined ? changed : recorded;
    if (mainHead) console.log(`Recorded on the merge with main at ${short(mainHead)}; these results stand beside the revision's own checks and go stale when main moves.`);
    else console.log(Array.isArray(paths) ? `changed: ${paths.join(", ") || "nothing"}` : "changed: not measured; the gate waits for a check that measures it");
    if (failed && !doneStep) process.exit(2);
  },

  async gc() {
    if (args._.length !== 1 || (args.apply && args["dry-run"])) die(COMMAND_USAGE.gc);
    const name = project(), as = await actor(OWNER);
    const { items } = await call("GET", P(name), undefined, as);
    if (!existsSync(CACHE)) { console.log("No local cache to collect."); return; }
    await collectCache({ cache: CACHE, name, items, apply: args.apply === true,
      getItem: async (id) => (await call("GET", I(name, id), undefined, as)).item });
  },

  // A Reported claim on an item: atelier report [ID] "what you verified and
  // how". The item is the ID written first, else --item ID, else the
  // workspace's. Inside a workspace, an ID that is not its item is refused:
  // an agent in t1's workspace writing `report t7 "…"` is more likely to be
  // in the wrong workspace than to mean t7, and the claim would otherwise be
  // recorded on t1 with "t7" folded into its text. --item ID names the item
  // outright, and --project NAME with an ID says the workspace is not the
  // context; either records the claim where it says.
  async report() {
    const words = args._.slice(1);
    const named = /^t\d+$/.test(words[0] ?? "") ? words.shift() : null;
    const claim = words.join(" ");
    if (!claim) die(COMMAND_USAGE.report);
    if (args.item !== undefined && (typeof args.item !== "string" || !/^t\d+$/.test(args.item))) die(`--item needs an item id, such as t7: ${COMMAND_USAGE.report}`);
    const name = project(), here = wsConfig("item"), id = args.item ?? named ?? here;
    if (!id) die(`which item? pass its id (t3) or run inside its workspace: ${COMMAND_USAGE.report}`);
    if (here && id !== here && args.item === undefined && args.project === undefined) {
      die(`this is ${here}'s workspace, and the claim names ${id}; to record it on ${id} from here: atelier report "…" --item ${id}`);
    }
    const as = await actor();
    const d = await call("GET", I(name, id), undefined, as);
    await call("POST", `${I(name, id)}/evidence`, { kind: "report", claim, head: d.item.head }, as);
    console.log(`Recorded on ${id} as REPORTED at ${short(d.item.head)}. Reports are shown, never counted as checks.`);
  },

  async submit() {
    summaryArg("submit");
    const name = project(), id = itemArg(), as = await actor();
    await call("POST", `${I(name, id)}/submit`, args.summary === undefined ? {} : { summary: args.summary }, as);
    const d = await call("GET", I(name, id), undefined, as);
    if (doneStep) return { item: d.item, gate: d.gate };
    console.log(d.gate.ready ? `${id} submitted and ready for ${OWNER_NAME}.` : `${id} submitted. Still blocking:\n${d.gate.blockers.map((b) => `  - ${b}`).join("\n")}`);
  },

  // Reviewers: read another agent's work without being able to change it.
  async diff() {
    const name = project(), id = itemArg(), as = await actor(OWNER);
    const ws = await call("POST", `${I(name, id)}/read-token`, {}, as);
    const base = await call("POST", `${I(name, id)}/base-token`, { scope: "read" }, as);
    const { dir } = cleanClone(ws.remote, ws.token, ws.head, null, name);
    try {
      git(["fetch", "--quiet", base.remote, base.defaultBranch], { cwd: dir, token: base.token });
      const mb = git(["merge-base", "FETCH_HEAD", "HEAD"], { cwd: dir });
      process.stdout.write(git(["log", "--format=%h %s", `${mb}..HEAD`], { cwd: dir }) + "\n\n");
      process.stdout.write(git(["diff", "--stat", mb, "HEAD"], { cwd: dir }) + "\n\n");
      process.stdout.write(git(["diff", mb, "HEAD"], { cwd: dir }) + "\n");
    } finally {
      removeClone(dir);
    }
  },

  async review() {
    if (!args.approve && !args.reject) die(COMMAND_USAGE.review);
    const name = project(), id = itemArg(), as = await actor();
    const d = await call("GET", I(name, id), undefined, as);
    let findings;
    if (args.findings !== undefined) {
      if (typeof args.findings !== "string" || !args.findings.trim()) die("--findings needs a JSON list of findings");
      try { findings = JSON.parse(args.findings); } catch { die("--findings is not valid JSON"); }
    }
    // The criteria binding is the one the reviewer read, never the task's
    // now: a verdict without it is refused by the server, with how to refresh.
    if (args.criteria !== undefined && !/^[a-f0-9]{64}$/.test(String(args.criteria))) die("--criteria needs the 64-digit binding atelier show prints");
    if (args.request !== undefined && !/^[0-9]+$/.test(String(args.request))) die("--request needs the request number the review claim gave");
    await call("POST", `${I(name, id)}/review`, {
      approve: args.approve === true, note: args.note ?? "", head: args.head ?? d.item.head,
      ...(args.criteria !== undefined ? { criteria: String(args.criteria) } : {}),
      ...(args.request !== undefined ? { request: Number(args.request) } : {}),
      ...(findings !== undefined ? { findings } : {}),
    }, as);
    console.log(`${args.approve ? "Approved" : "Rejected"} ${id} @ ${short(d.item.head)} as ${as}.`);
  },

  async "review-claim"() {
    const name = project(), id = itemArg(), as = await actor();
    const r = await call("POST", `${I(name, id)}/review-claim`, {}, as, args.runner ? { "x-atelier-runner": args.runner } : {});
    console.log(JSON.stringify(r));
  },

  async "review-release"() {
    const name = project(), id = itemArg(), as = await actor();
    await call("POST", `${I(name, id)}/review-release`, { note: args.note ?? "" }, as);
    console.log(`${id}'s review request released.`);
  },

  // t407: a reviewer's reply no verdict could be read from is kept on the
  // task, its last 100 KB with the reviewer and the head, as the request it
  // held goes back to the queue. The reply travels as the file the harness
  // wrote, never as an argument, which the operating system caps far below a
  // long reply.
  async "review-unparsable"() {
    const name = project(), id = itemArg(), as = await actor();
    if (typeof args.head !== "string" || !/^[a-f0-9]{40,64}$/.test(args.head)) die("--head needs the full revision the review read");
    if (typeof args["reply-file"] !== "string" || !args["reply-file"]) die('--reply-file needs the path of the file the harness wrote its reply to');
    let reply;
    try { reply = readFileSync(args["reply-file"], "utf8"); }
    catch (error) { die(`could not read the reply file: ${error.message}`); }
    const r = await call("POST", `${I(name, id)}/review-unparsable`, { head: args.head, note: args.note ?? "", reply: reply.slice(-VERDICT_LIMITS.reply) }, as);
    console.log(`Kept the unparsable review reply on ${id}${r.released === false ? "" : ", and released its review request"}.`);
  },

  // Read-only access tokens the runner uses outside a task or review job: the
  // item's own fork, or the repository it is measured against.
  async "read-token"() {
    const name = project(), id = itemArg(), as = await actor();
    console.log(JSON.stringify(await call("POST", `${I(name, id)}/read-token`, {}, as)));
  },

  async "base-token"() {
    const name = project(), id = itemArg(), as = await actor();
    console.log(JSON.stringify(await call("POST", `${I(name, id)}/base-token`, { scope: "read" }, as)));
  },

  // The integrator's reports (docs/orchestrator.md, section 5). Both run as
  // atelier/integrator through its token; the server verifies the merge commit.
  async integrated() {
    const name = project(), id = itemArg(), as = await actor();
    if (typeof args.part !== "string" || !args.part.trim()) die("usage: atelier integrated tP --part KEY --merge-commit SHA");
    if (typeof args["merge-commit"] !== "string" || !/^[a-f0-9]{40,64}$/.test(args["merge-commit"])) die("--merge-commit needs the full merge commit hash");
    const r = await call("POST", `${I(name, id)}/integrated`, { part: args.part, mergeCommit: args["merge-commit"] }, as);
    console.log(JSON.stringify(r));
  },

  async "integration-failed"() {
    const name = project(), id = itemArg(), as = await actor();
    if (typeof args.part !== "string" || !args.part.trim()) die("usage: atelier integration-failed tP --part KEY --reason TEXT [--kind conflict|checks]");
    if (args.kind !== undefined && args.kind !== "conflict" && args.kind !== "checks") die("--kind is conflict or checks");
    const r = await call("POST", `${I(name, id)}/integration-failed`, { part: args.part, reason: args.reason ?? "", ...(args.kind ? { kind: args.kind } : {}) }, as);
    console.log(JSON.stringify(r));
  },

  // The integrator's reports on a refresh of the plan's branch with main's
  // head (docs/orchestrator.md, section 5). The server verifies the merge.
  async refreshed() {
    const name = project(), id = itemArg(), as = await actor();
    if (typeof args["main-head"] !== "string" || !/^[a-f0-9]{40,64}$/.test(args["main-head"])) die("usage: atelier refreshed tP --main-head SHA [--merge-commit SHA]; --main-head needs the full hash of the main head merged");
    if (args["merge-commit"] !== undefined && (typeof args["merge-commit"] !== "string" || !/^[a-f0-9]{40,64}$/.test(args["merge-commit"]))) die("--merge-commit needs the full merge commit hash");
    const r = await call("POST", `${I(name, id)}/refreshed`, { mainHead: args["main-head"], ...(args["merge-commit"] ? { mergeCommit: args["merge-commit"] } : {}) }, as);
    console.log(JSON.stringify(r));
  },

  async "refresh-failed"() {
    const name = project(), id = itemArg(), as = await actor();
    if (typeof args["main-head"] !== "string" || !/^[a-f0-9]{40,64}$/.test(args["main-head"])) die("usage: atelier refresh-failed tP --main-head SHA --reason TEXT [--kind conflict|checks]");
    if (args.kind !== undefined && args.kind !== "conflict" && args.kind !== "checks") die("--kind is conflict or checks");
    const r = await call("POST", `${I(name, id)}/refresh-failed`, { mainHead: args["main-head"], reason: args.reason ?? "", ...(args.kind ? { kind: args.kind } : {}) }, as);
    console.log(JSON.stringify(r));
  },

  async handoff() {
    if (!args.to) die(COMMAND_USAGE.handoff);
    const name = project(), id = itemArg(), as = await actor();
    const r = await call("POST", `${I(name, id)}/handoff`, { to: args.to, note: args.note ?? "" }, as);
    console.log(`${id} now belongs to ${r.item.owner}. Your write token is revoked.\nNext: ${r.next}`);
  },

  async release() {
    const name = project(), id = itemArg(), as = await actor();
    await call("POST", `${I(name, id)}/release`, { note: args.note ?? "" }, as);
    console.log(`${id} released; your write token is revoked.`);
  },

  // --override-review "reason" accepts with the owner's override of a
  // missing independent review; the server records it and refuses it where
  // nothing is missing.
  async accept() {
    const name = project(), id = itemArg(), reason = overrideArg("accept ID");
    const d = await call("GET", I(name,id), undefined, OWNER);
    const item = await call("POST", `${I(name, id)}/accept`, {head: args.head ?? d.item.head, ...(reason !== undefined ? { overrideReview: reason } : {}), ...(typeof args.note === "string" ? { note: args.note } : {})}, OWNER);
    const overridden = reason !== undefined
      ? item.availableReviewer
        ? `, with the independent review overridden; ${item.availableReviewer} was available to review it instead: atelier land ${id} --reviewer ${item.availableReviewer}`
        : ", with the independent review overridden"
      : "";
    console.log(`${id} accepted at ${short(item.acceptedHead)}${overridden}. Merge it with: atelier merge ${id}`);
  },

  // The server clears the owner and revokes the holder's write token, as a
  // handoff or a release does. The holder is read first: the answer carries
  // the item with its owner already cleared, and an open item has none.
  async abandon() {
    const name = project(), id = itemArg();
    const { item: before } = await call("GET", I(name, id), undefined, OWNER);
    await call("POST", `${I(name, id)}/abandon`, { note: args.note ?? "", ...(typeof args["delivered-by"] === "string" ? { deliveredBy: args["delivered-by"] } : {}) }, OWNER);
    console.log(before.owner ? `${id} abandoned; ${before.owner}'s write token is revoked.` : `${id} abandoned; nobody held it, so no write token was revoked.`);
  },

  // The project owner traces a defect to an item's accepted revision. The
  // server refuses an item never accepted, and a blank note.
  async defect() {
    const name = project(), id = itemArg();
    if (typeof args.note !== "string" || !args.note.trim()) die('a defect needs a note: atelier defect ID --note "what is wrong" [--found-in ID]');
    const item = await call("POST", `${I(name, id)}/defect`, { note: args.note.trim(), ...(args["found-in"] !== undefined ? { foundIn: args["found-in"] } : {}) }, OWNER);
    console.log(`Defect traced to ${id} at ${short(item.acceptedHead)}. It counts against the model that built that revision and each model that approved it; the Models page shows the record.`);
  },

  // The project owner records a verdict on one finding of a review, at the
  // head the review was made at and the finding's position in its findings.
  async finding() {
    const name = project(), id = itemArg();
    const verdict = args.verdict;
    if (!["confirmed", "refuted", "fixed"].includes(verdict)) die('--verdict must be confirmed, refuted or fixed: atelier finding ID --head SHA --index N --verdict ...');
    if (typeof args.head !== "string" || !/^[a-f0-9]{40,64}$/.test(args.head)) die('--head needs the full revision the review was made at: atelier finding ID --head SHA --index N --verdict ...');
    const index = Number(args.index);
    if (!Number.isInteger(index) || index < 1) die('--index needs the finding\'s position in the review, one based: atelier finding ID --head SHA --index N --verdict ...');
    await call("POST", `${I(name, id)}/finding`, { head: args.head, index, verdict, note: args.note ?? "" }, OWNER);
    console.log(`Recorded ${verdict} on finding ${index} of ${id}'s review at ${args.head.slice(0, 8)}. The Models page counts it under the reviewer.`);
  },

  // The project owner records a run that ended without a result the ledger
  // saw, for a run outside the runner: an early stop, a permission stop, a
  // duplicate design or an incomplete merge, beside stalled, timed-out and
  // refused, which the runner reports itself.
  async "run-report"() {
    if (typeof args.actor !== "string" || !args.actor.includes("/")) die('usage: atelier run-report --actor H/M --role build|review --outcome KIND [--project P] [--item ID] [--detail TEXT]');
    const role = args.role === undefined ? "build" : args.role;
    if (!["build", "review"].includes(role)) die('--role must be build or review');
    const outcomes = ["stalled", "timed-out", "refused", "early_stop", "permission_stop", "duplicate_design", "incomplete_merge"];
    if (!outcomes.includes(args.outcome)) die(`--outcome must be one of ${outcomes.join(", ")}`);
    await call("POST", "/runs", {
      actor: args.actor, role, outcome: args.outcome,
      ...(args.project !== undefined ? { project: args.project } : {}),
      ...(args.item !== undefined ? { item: args.item } : {}),
      detail: args.detail ?? "",
    }, OWNER);
    console.log(`Recorded a ${role} run (${args.outcome}) by ${args.actor}${args.project ? ` on ${args.project}${args.item ? `/${args.item}` : ""}` : ""}.`);
  },

  // The project owner records which model served events recorded under
  // another: each matching event gets an annotation, and the event itself
  // never changes. Without --apply it lists the matches and records nothing.
  async served() {
    const name = project(), model = args._[1];
    if (args._.length !== 2 || ["recorded", "from", "to"].some((k) => typeof args[k] !== "string")) {
      die("usage: atelier served MODEL --recorded HARNESS/MODEL --from TIME --to TIME [--item ID]... [--note TEXT] [--apply] [--project P]");
    }
    const r = await call("POST", `${P(name)}/served`, {
      served: model, recorded: args.recorded, from: args.from, to: args.to,
      ...(args.multi.item ? { items: args.multi.item } : {}), ...(args.note !== undefined ? { note: args.note } : {}), apply: args.apply === true,
    }, OWNER);
    const n = r.matched.length;
    console.log(`${n} ${n === 1 ? "event" : "events"} on ${r.project} recorded as ${r.recorded} from ${r.from} to ${r.to}, in ${r.items ? r.items.join(" ") : "every task"}:`);
    for (const m of r.matched) console.log(`  ${m.itemId ?? "(no task)"}  #${m.seq}  ${m.kind}  ${m.at}${m.served ? `  annotated as served by ${m.served}` : ""}`);
    const as = `${r.recorded.slice(0, r.recorded.indexOf("/"))}/${r.served}`;
    if (r.applied) console.log(`Annotated ${r.annotated} as served by ${r.served}; ${n - r.annotated} already were. The records count them under ${as}.`);
    else if (r.pending) console.log(`Nothing was recorded. To annotate ${r.pending} as served by ${r.served}, run this again with --apply.`);
    else console.log(`Nothing to record: ${n ? `each is already annotated as served by ${r.served}` : "no event matches"}.`);
  },

  async done() {
    if (args._.length !== 2 || !args._[1].trim() || args.summary !== undefined || args.rest) die(COMMAND_USAGE.done);
    args.summary = args._[1];
    args._ = ["done"];
    const restore = args.json === true ? progressToStderr() : () => {};
    doneStep = "prepare";
    let result;
    try {
      result = await commands.finish();
      doneStep = undefined;
    } catch (error) { die(error.message); }
    restore();
    const report = doneReport(result);
    if (args.json === true) console.log(JSON.stringify(report.json, null, 2));
    else console.log([...report.summary, report.line].join("\n"));
    process.exitCode = report.exitCode;
  },

  async finish() {
    summaryArg("finish");
    const name = project(), id = itemArg(), as = await actor();
    requireWorkspace("finish", name, id, as);
    const d = await call("GET", I(name,id), undefined, as);
    if (d.item.owner !== as || !["claimed","submitted"].includes(d.item.state)) die("this task must be live and owned by you");
    if (git(["status","--porcelain"])) die("commit your changes before finishing");
    const head = git(["rev-parse","HEAD"]);
    doneChecks.length = 0;
    if (doneStep) doneStep = "push";
    await commands.push();
    if (doneStep) doneStep = "check";
    if (d.policy.sandboxOnly || args.sandbox) await checkInSandbox(); else await commands.check();
    const changed = git(["status","--porcelain"], { raw: true }).split("\n").filter(Boolean).map((line) => line.slice(3));
    // A failed check is the outcome even when it also changed the workspace; the changed files are named with it.
    if (doneChecks.some((c) => c.result === "failed")) return { id, head, checks: doneChecks, changed };
    if (git(["rev-parse","HEAD"]) !== head || changed.length) die("the workspace changed while finishing; inspect it and finish again");
    const current = await call("GET", I(name,id), undefined, as);
    if (current.item.head !== head) die("the remote revision changed while checks ran; finish again");
    if (doneStep) doneStep = "submit";
    const submitted = await commands.submit();
    return { id, head, checks: doneChecks, ...submitted };
  },

  // The project owner merges an exact revision. With --head, a submitted item
  // is first approved (with --approve) and accepted at that revision only.
  // A baseline holding part of the history (init --history-since) does not
  // follow the checkout by itself: commits made in the checkout outside
  // Atelier are carried to it here, rebuilt with the same trees.
  async sync() {
    const git = landingGit;
    const name = project();
    const p = cfg.projects?.[name] ?? die(`${name} is not registered on this Mac`), cwd = p.path;
    const refreshed = await refreshControlPlane(cwd, name);
    // A policy that cannot be read is not stepped over with a warning: the
    // stored policy would stay stale with nothing else saying so, so sync
    // stops as merge and init do, until the file is fixed.
    if (refreshed?.skipped) die(`ControlPlane policy could not be read: ${refreshed.error}. Fix the file, then run atelier sync again.`);
    if (p.fresh !== true) {
      if (!refreshed) die(`${name}'s baseline holds its whole history; atelier init pushes new commits to it`);
      if (!refreshed.changes.length) console.log(`${name}: ControlPlane policy is current.`);
      return;
    }
    if (git(["status", "--porcelain"], { cwd })) die("the registered checkout has uncommitted changes; commit or set them aside first");
    if (git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd }) !== p.branch) die(`check out ${p.branch} in ${cwd} first`);
    const gitDir = git(["rev-parse", "--absolute-git-dir"], { cwd }), landing = landingHome(gitDir);
    let unlock;
    try { unlock = landingLock(landing); } catch (error) { die(error.message); }
    try {
      try { adoptOldLanding(gitDir, landing); } catch (error) { die(error.message); }
      if (existsSync(landingJournalFile(landing))) die("a merge is in progress; finish it or cancel it first");
      const base = await call("POST", `${P(name)}/baseline-token`, { scope: "write" }, OWNER);
      git(["fetch", "--quiet", base.remote, p.branch], { cwd, token: base.token });
      const baselineHead = git(["rev-parse", "FETCH_HEAD"], { cwd });
      const pairs = loadPairs(gitDir, name);
      const paired = pairs[baselineHead] ?? die(`the baseline's head ${short(baselineHead)} has no pair in this checkout; it was set up or synced from another machine`);
      const head = git(["rev-parse", "HEAD"], { cwd });
      if (head === paired) return console.log(`${name}: the baseline already matches ${p.branch} @ ${short(head)}.`);
      if (git(["merge-base", "--is-ancestor", paired, head], { cwd, allowFail: true }).status !== 0) die(`${p.branch} no longer contains ${short(paired)}, the commit the baseline matches; its history was rewritten, and it cannot be carried`);
      let built;
      try { built = syncHistory(git, cwd, baselineHead, paired, head); } catch (error) { die(error.message); }
      // The pairs are saved before the push: a push that lands just before a
      // crash is still paired, and the rebuild gives the same commits again.
      savePairs(gitDir, name, { ...pairs, ...built.pairs });
      git(["push", "--quiet", "--recurse-submodules=no", base.remote, `${built.head}:refs/heads/${p.branch}`], { cwd, token: base.token });
      const n = Object.keys(built.pairs).length;
      console.log(`${name}: carried ${n} commit${n === 1 ? "" : "s"} to the baseline; it now matches ${p.branch} @ ${short(head)}. Tasks forked earlier can run atelier update.`);
    } finally { unlock(); }
  },

  async merge() {
    const git = landingGit;
    // A plan's branch is updated only by its integrator, which merges
    // recorded parts, so an accepted plan that conflicts with main would stay
    // accepted with no one able to update it. Its merge, already aborted,
    // puts it back to building through plan refresh instead: the acceptance
    // is withdrawn and main's head is merged into the branch, or, when that
    // conflicts, a merge-main part is added for a model to resolve.
    const planConflicted = async (name, id, item) => {
      let view;
      try { view = await request("POST", `${I(name, id)}/plan/refresh`, {}, OWNER); }
      catch (error) { die(`merge conflicts: ${id}'s branch does not merge with main, so nothing was merged, and ${id} stays accepted at ${short(item.acceptedHead)}: putting it back to building was refused: ${error.message}. Once that is cleared, take main into the branch with atelier plan refresh ${id}`); }
      const main = view.refresh?.last?.mainHead ?? view.refresh?.main ?? "";
      die(`merge conflicts: ${id}'s branch does not merge with main, so nothing was merged. Its acceptance at ${short(item.acceptedHead)} is withdrawn and the plan is building again: a refresh from main at ${short(main)} is queued for atelier/integrator, and if it conflicts the plan adds a merge-main part whose builder resolves it. The integrator submits the plan again once every part is integrated; then merge it with atelier merge ${id} --head H, H being the integration head atelier plan show ${id} prints`);
    };
    // An override is recorded only while accepting, which needs the revision.
    if (args["override-review"] !== undefined && args.head === undefined) die("--override-review is recorded while accepting a submitted revision: atelier merge ID --head FULL_REVISION --override-review REASON");
    const name = project(), id = itemArg();
    const p = cfg.projects?.[name] ?? die(`${name} is not registered on this Mac`), cwd = p.path;
    // Ends a landing. It holds the landing lock throughout, as merge does, so
    // it never runs beside a merge of this checkout that may be publishing.
    // The journal is matched by project and item alone, so a landing whose
    // acceptance was withdrawn or moved after it began, and which can no
    // longer be finished, can still be cancelled. What the landing left in
    // the checkout, a merge commit or an unfinished Git merge (landingLeft),
    // is kept unless the owner asks for it to go with --discard-local; then
    // the checkout returns to where the merge began. The landing lease is
    // cancelled on the server while the item is accepted at the revision the
    // journal names, or when there is no journal: a lease is taken for the
    // accepted revision alone, and no push or review moves the acceptance
    // while one is held, so with another acceptance this landing has none,
    // and a lease on the new revision is not this landing's to end.
    if (args.cancel === true) {
      const gitDir = git(["rev-parse", "--absolute-git-dir"], { cwd }), landing = landingHome(gitDir);
      let unlock;
      try { unlock = landingLock(landing); } catch (error) { die(error.message); }
      try {
        let journal;
        try { adoptOldLanding(gitDir, landing); journal = landingJournal(landing, { project: name, item: id }); } catch (error) { die(error.message); }
        const item = (await call("GET", I(name, id), undefined, OWNER)).item;
        const begun = journal.state, head = begun ? begun.head : item.acceptedHead;
        const ours = !begun || (item.state === "accepted" && item.acceptedHead === begun.head);
        const now = item.state === "accepted" ? `accepted at ${short(item.acceptedHead)}` : item.state;
        const left = begun ? landingLeft(git, cwd, gitDir, begun, p.branch, `Atelier: ${name}/${id} accepted at ${begun.head}`) : {};
        const local = left.commit;
        // Whether the baseline holds a commit, asked of its whole history,
        // fetched here and read by Git.
        let baselineHead = null;
        if (local || (ours && head)) {
          const base = await call("POST", `${P(name)}/baseline-token`, { scope: "read" }, OWNER);
          git(["fetch", "--quiet", base.remote, p.branch], { cwd, token: base.token });
          baselineHead = git(["rev-parse", "FETCH_HEAD"], { cwd });
        }
        const onBaseline = (commit) => !!commit && !!baselineHead && git(["merge-base", "--is-ancestor", commit, baselineHead], { cwd, allowFail: true }).status === 0;
        // A merge already on the baseline is never cancelled, and the checkout
        // keeps it. The journal says so once the push has returned; for a
        // push that reached the baseline just before the process stopped, the
        // baseline's history says so. In a project whose baseline holds part
        // of its history, the baseline has the merge's rebuilt twin, paired
        // with it before the push. A merge the server has recorded, or can no
        // longer record since the item is not accepted at its revision, leaves
        // only the journal to remove; one it can record, merge records.
        if (local) {
          const pairs = p.fresh === true ? loadPairs(gitDir, name) : null;
          const sent = pairs ? Object.keys(pairs).find((commit) => pairs[commit] === local) : local;
          if (begun.phase === "published" || onBaseline(sent)) {
            const lost = left.held ? "" : `\n${p.branch} no longer holds the merge commit ${short(local)}; put it back on that commit before the next merge.`;
            if (ours) die(`${id}'s merge ${short(sent ?? local)} is already on the baseline, so the landing cannot be cancelled, and the checkout keeps it.\nRecord the merge with: atelier merge ${id}${lost}`);
            journal.clear();
            if (item.state === "merged") return console.log(`${id} is already merged as ${short(sent ?? local)}. The landing journal is removed; the checkout keeps the merge.${lost}`);
            return console.log(`${id}'s merge ${short(sent ?? local)} is on the baseline, but ${id} is ${now}, so Atelier cannot record it. The landing journal is removed; the checkout keeps the merge, as the baseline does.${lost}`);
          }
        }
        // The accepted revision on the baseline through another merge commit,
        // made elsewhere: its lease is that merge's, left for it to be
        // recorded. Without a journal there is nothing else to cancel.
        const landed = ours && onBaseline(head);
        if (landed && !begun) die(item.state === "merged" ? `${id} is already merged; there is no landing to cancel` : `${id} at ${short(head)} is already merged on the baseline, so its landing lease cannot be cancelled. Record that merge by running atelier merge ${id} in the checkout that made it`);
        if (left.held || left.merging) {
          const what = left.held ? `this merge's unpublished commit ${short(local)} on top of ${short(begun.start)}` : `this merge's unfinished Git merge of ${short(begun.head)} on ${short(begun.start)}`;
          if (args["discard-local"] !== true) {
            if (!ours) die(`${id} is ${now}, no longer accepted at ${short(begun.head)}, the revision this landing merged, so the landing cannot be finished. The checkout holds ${what}.\nRemove it with: atelier merge ${id} --cancel --discard-local`);
            if (landed) die(`${id} at ${short(head)} is already on the baseline through another merge commit, so this landing cannot be finished. The checkout holds ${what}.\nRemove it with: atelier merge ${id} --cancel --discard-local`);
            die(`the checkout holds ${what}.\n${left.held ? `Finish it with: atelier merge ${id}` : `Abort it with git merge --abort, then finish the landing with: atelier merge ${id}`}\nor cancel and remove it with: atelier merge ${id} --cancel --discard-local`);
          }
          if (git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd }) !== p.branch) die(`check out ${p.branch} in ${cwd} first`);
          const at = git(["rev-parse", "HEAD"], { cwd });
          if (left.held && at !== local) die(`${p.branch} moved since the merge: it is at ${short(at)}, past the merge commit ${short(local)}. Nothing was changed. Move your commits off it and put ${p.branch} back on ${short(local)}, or on ${short(begun.start)} where the merge began, then run: atelier merge ${id} --cancel --discard-local`);
          if (left.held && git(["status", "--porcelain"], { cwd })) die(`the checkout has uncommitted changes on top of the merge commit ${short(local)}. Nothing was changed. Set them aside (git stash), then run: atelier merge ${id} --cancel --discard-local`);
        }
        if (ours && !landed) await call("POST", `${I(name, id)}/landing`, { cancel: true }, OWNER);
        if (left.held) {
          git(["reset", "--quiet", "--hard", begun.start], { cwd });
          console.log(`Removed the unpublished merge commit; ${p.branch} is back at ${short(begun.start)}.`);
        } else if (left.merging) {
          git(["merge", "--abort"], { cwd });
          const rest = git(["status", "--porcelain", "--untracked-files=all"], { cwd });
          console.log(`Aborted the unfinished Git merge; ${p.branch} is at ${short(begun.start)}, where the merge began.${rest ? `\nGit still lists these files as changed or untracked; remove any the merge left:\n${rest}` : ""}`);
        }
        journal.clear();
        if (landed) return console.log(`${id}: the landing in this checkout is cancelled. ${id} at ${short(head)} is already on the baseline through another merge commit, so its landing lease is left for that merge to be recorded.`);
        if (ours) return console.log(`${id}: the merge is cancelled; its owner can push a new revision.`);
        return console.log(`${id}: the landing in this checkout is cancelled. ${id} is ${now}, and nothing changed on the server${item.state === "accepted" ? `; merge its accepted revision with: atelier merge ${id}` : ""}.`);
      } finally { unlock(); }
    }
    const refreshed = await refreshControlPlane(cwd, name);
    // The merge compares the policy as it is now with the one the acceptance
    // was made under, so a policy it cannot read stops it here.
    if (refreshed?.skipped) die(`ControlPlane policy could not be read: ${refreshed.error}. Fix the file, then run atelier merge ${id} again.`);
    if (args.head !== undefined) {
      if (!/^[a-f0-9]{40,64}$/.test(args.head)) die(COMMAND_USAGE.merge);
      const reason=overrideArg("merge ID --head FULL_REVISION");
      const d=await call("GET",I(name,id),undefined,OWNER);
      if (d.item.state==="submitted") {
        if (d.item.head!==args.head) die("the task changed; review the new revision before merging");
        // The owner approves here the criteria this command read with the head.
        if (args.approve) await call("POST",`${I(name,id)}/review`,{head:args.head,criteria:d.criteria,approve:true,note:args.note??""},OWNER);
        await call("POST",`${I(name,id)}/accept`,{head:args.head,...(reason!==undefined?{overrideReview:reason}:{})},OWNER);
      }
    }
    const gitDir=git(["rev-parse","--absolute-git-dir"],{cwd}), landing=landingHome(gitDir);
    let unlock;
    try { unlock=landingLock(landing); } catch (error) { die(error.message); }
    try {
      try { adoptOldLanding(gitDir,landing); } catch (error) { die(error.message); }
      const d=await call("GET",I(name,id),undefined,OWNER), item=d.item;
      // A landing begun at an acceptance that has since been withdrawn or
      // moved cannot be finished: what it merged is no longer what is accepted.
      let begun;
      try { begun=landingJournal(landing,{project:name,item:id}).state; } catch (error) { die(error.message); }
      if (begun && (begun.head!==item.acceptedHead || !['accepted','merged'].includes(item.state))) {
        const left=landingLeft(git,cwd,gitDir,begun,p.branch,`Atelier: ${name}/${id} accepted at ${begun.head}`);
        die(`${id} is ${item.state==='accepted'?`accepted at ${short(item.acceptedHead)}`:item.state}, no longer accepted at ${short(begun.head)}, where this checkout began landing it, so that landing cannot be finished. Cancel it with: atelier merge ${id} --cancel${left.held||left.merging?' --discard-local':''}${item.state==='accepted'?', then merge again':''}`);
      }
      if (!['accepted','merged'].includes(item.state)) die(`${id} is ${item.state}; accept the reviewed revision first`);
      if (args.head && args.head!==item.acceptedHead) die("the accepted revision differs from --head; review it before merging");
      const journal=landingJournal(landing,{project:name,item:id,head:item.acceptedHead});
      if (item.state==='merged') { journal.clear(); console.log(`${id} is already merged.`); return; }
      const acceptedPolicy = acceptancePolicy(d, refreshed?.before ?? d.policy), context = mergeContext(d, refreshed?.items);
      if (refreshed?.policy) {
        const decision = mergePolicyDecision(acceptedPolicy, refreshed.policy, [], false, context);
        if (decision.warning) console.error(decision.warning);
      }
      if (git(["status","--porcelain"],{cwd})) die("the registered checkout has uncommitted changes; preserve them before retrying");
      if (git(["rev-parse","--abbrev-ref","HEAD"],{cwd})!==p.branch) die(`check out ${p.branch} in ${cwd} first`);
      const base=await call("POST",`${P(name)}/baseline-token`,{scope:'write'},OWNER);
      git(['fetch','--quiet',base.remote,p.branch],{cwd,token:base.token});
      const baselineHead=git(['rev-parse','FETCH_HEAD'],{cwd});
      const ws=await call('POST',`${I(name,id)}/read-token`,{},OWNER);
      git(['fetch','--quiet',ws.remote,item.acceptedHead],{cwd,token:ws.token});
      if (git(['rev-parse','FETCH_HEAD'],{cwd})!==item.acceptedHead) die('fetched revision differs from the approval');
      if (refreshed?.policy) {
        if (!item.base) die('the accepted revision has no recorded base; review the task again on its page and accept again');
        // The accepted revision's own changes: those since the newest baseline
        // commit it holds, which atelier update moves past the recorded base.
        const forkPoint = git(['merge-base', baselineHead, item.acceptedHead], { cwd, allowFail: true });
        const since = forkPoint.status === 0 && forkPoint.stdout.trim() ? forkPoint.stdout.trim() : item.base;
        const paths = git(['diff', '--name-only', '--no-renames', '-z', since, item.acceptedHead], { cwd, raw: true }).split('\0').filter(Boolean);
        const decision = mergePolicyDecision(acceptedPolicy, refreshed.policy, paths, args['policy-changed-ok'] === true, context);
        if (decision.refusal) die(`${decision.refusal}\n${server()}/p/${encodeURIComponent(name)}/${encodeURIComponent(id)}`);
      }
      const local=git(['rev-parse','HEAD'],{cwd});
      const owners=[...new Set(d.events.filter(e=>['item.claimed','item.handoff'].includes(e.kind)).map(e=>e.data.to??e.actor))];
      const view=d.evidence.filter(e=>e.head===item.acceptedHead), reviews=d.reviews.filter(r=>r.head===item.acceptedHead);
      const marker=`Atelier: ${name}/${id} accepted at ${item.acceptedHead}`;
      // A project whose baseline holds part of its history (cli/fresh.mjs)
      // merges the task's commits rebuilt onto the paired project commit.
      const fresh=p.fresh===true, pairs=fresh?loadPairs(gitDir,name):null;
      if (!journal.state) {
        if (fresh) {
          const paired=pairs[baselineHead];
          if (!paired) die(`the baseline's head ${short(baselineHead)} has no pair in this checkout; it was set up or synced from another machine`);
          if (local!==paired) die(`${p.branch} has moved since the baseline last matched it (${short(paired)}); run atelier sync --project ${name}, then merge`);
        }
        else if (git(['merge-base','--is-ancestor',baselineHead,'HEAD'],{cwd,allowFail:true}).status!==0) die('the baseline has commits missing locally; reconcile the checkout before merging');
        journal.save({start:local,phase:'prepared',baselineStart:baselineHead});
      }
      if (!journal.state.mergeCommit) {
        // What is merged: the accepted head, or its rebuilt twin on the project's commits.
        let target=item.acceptedHead;
        if (fresh) {
          try { target=carryTask(git,cwd,journal.state.baselineStart??baselineHead,item.acceptedHead,pairs); } catch (error) { journal.clear(); die(error.message); }
          if (!target) { journal.clear(); die('the accepted revision adds nothing to the baseline'); }
        }
        // Recover a commit made just before a crash prevented the journal update.
        const parents=git(['rev-list','--parents','-n','1','HEAD'],{cwd}).split(' ');
        const ownCommit=parents.length===3 && parents[1]===journal.state.start && parents[2]===target && git(['log','-1','--format=%B'],{cwd}).split('\n').includes(marker);
        if (ownCommit) journal.save({mergeCommit:local,phase:'committed'});
        else {
          if(local!==journal.state.start) die('checkout moved during an interrupted merge; inspect the journal before retrying');
          // Paths that differ only by letter case or Unicode form are one file
          // on a Mac, so Git would write one over the other here and in every
          // clone on a Mac. The baseline is shared, so this is refused on every
          // platform, before the checkout changes. The tree checked is the
          // merge's own, from merge-tree, which touches neither the index nor
          // the work tree; it is the accepted tree where merge-tree cannot
          // write one, as with a Git older than 2.38.
          const merged=git(['merge-tree','--write-tree','--no-messages',local,target],{cwd,allowFail:true});
          const mergedTree=merged.status<=1?merged.stdout.split('\n')[0]:'';
          const tree=/^[0-9a-f]{40,64}$/.test(mergedTree)?mergedTree:target;
          const entries=treeEntries(git(['ls-tree','-r','-z','--full-tree',tree],{cwd,raw:true}));
          const clashes=pathCollisions(entries.map(e=>e.path));
          if(clashes.length){journal.clear();die(`the merge would hold paths that a Mac stores as one file, since they differ only by letter case or Unicode form: ${clashes.map(g=>g.join(' and ')).join('; ')}. Git would write one over the other in this checkout and in every clone on a Mac. Nothing was merged; the task's owner must rename or remove all but one of each and submit a new revision`);}
          // The landing reads the ControlPlane policy and receipt template
          // and writes the receipt; a symlink on one of those paths would
          // take the read or the write outside the checkout.
          const links=landingSymlinks(entries);
          if(links.length){journal.clear();die(`the merge would put a symlink where the landing reads or writes its ControlPlane files: ${links.join(', ')}. The landing would follow it out of the checkout. Nothing was merged; the task's owner must replace each with the file or folder itself and submit a new revision`);}
          // A file that this checkout's Git configuration runs (a hook, a
          // filter or merge driver script, an included configuration file)
          // and that the merge would change would run during the merge, or
          // stay to run at the owner's next Git command. The changed paths
          // are those between this checkout and the merge's own tree.
          let runs;
          try{runs=touchedExecutables(git(['diff','--name-only','--no-renames','-z',local,tree],{cwd,raw:true}).split('\0').filter(Boolean),executablePaths(cwd,gitEnv()));}
          catch(error){journal.clear();die(error.message);}
          if(runs.length){journal.clear();die(`the accepted change touches files that this checkout's Git configuration runs: ${runs.map(r=>r.changed.length===1&&r.changed[0]===r.path?`${r.path}, ${r.setting}`:`${r.changed.join(', ')}, which reach ${r.path}, ${r.setting}`).join('; ')}. Landing it would run them, during the merge or at your next Git command. Nothing was merged; review those files in the accepted change and land it by hand, or have the task's owner submit a revision that leaves them alone`);}
          const result=git(['merge','--no-ff','--no-commit',target],{cwd,allowFail:true});
          if(result.status!==0){git(['merge','--abort'],{cwd,allowFail:true});journal.clear();if(item.kind==='plan')await planConflicted(name,id,item);die(`merge conflicts; nothing was merged and ${id} stays accepted. The project owner can send it back to a runner with atelier dispatch ${id} --job merge-main, or hand it to a builder with atelier handoff ${id} --to H/M. The builder resolves the conflicts, rechecks and submits a new revision for review and acceptance; earlier reviews and acceptance stay in the history`);}
          if (!existsSync(join(gitDir,'MERGE_HEAD'))) { journal.clear(); die('this revision is already in the checkout without this merge record; reconcile its history first'); }
          const receipt=writeReceipt(cwd,{name,id,item,owners,view,reviews,policy:d.policy,branch:p.branch,notesRemote:p.notesRemote,changeClass:d.gate.changeClass});
          if(receipt)git(['add',receipt],{cwd});
          git(['commit','--quiet','-m',`Merge ${id}: ${item.title}\n\n${marker}\nWorked by: ${owners.join(' → ')||item.owner}`],{cwd});
          journal.save({mergeCommit:git(['rev-parse','HEAD'],{cwd}),phase:'committed'});
        }
      }
      const mergeCommit=journal.state.mergeCommit;
      const at=git(['rev-parse','HEAD'],{cwd});
      if(at!==mergeCommit)die(`the checkout moved after the merge: ${p.branch} is at ${short(at)}, not at the merge commit ${short(mergeCommit)}. Put ${p.branch} back on ${short(mergeCommit)}, moving any commits of yours off it, then run atelier merge ${id} again, or cancel the landing with: atelier merge ${id} --cancel`);
      // Take the landing lease: it confirms the acceptance has not moved and
      // stops a push over this revision until the merge is recorded.
      // A refusal ends the command here with the server's reason; the local
      // merge commit is kept for reconciliation.
      await call('POST',`${I(name,id)}/landing`,{head:item.acceptedHead},OWNER);
      // The note goes to the public remote too, so it names reviewers and verdicts but never their text (cli/provenance.mjs).
      const note=provenanceNote({name,id,item,view,reviews,events:d.events});
      // Reconcile provenance independently: a previous push can publish only one ref.
      const remoteNotes=git(['ls-remote',base.remote,'refs/notes/atelier'],{cwd,token:base.token});
      if(remoteNotes){
        git(['fetch','--quiet',base.remote,'refs/notes/atelier'],{cwd,token:base.token});
        if(git(['rev-parse','--verify','refs/notes/atelier'],{cwd,allowFail:true}).status===0)
          git(['notes','--ref=atelier','merge','FETCH_HEAD'],{cwd});
        else git(['update-ref','refs/notes/atelier','FETCH_HEAD'],{cwd});
      }
      // The baseline gets the merge commit itself, or, for a baseline holding
      // part of the history, its twin: the same tree, authors, dates and
      // message on the baseline's head and the accepted head. The same inputs
      // give the same twin, so a retry publishes the same commit.
      const published=fresh?rebuild(git,cwd,mergeCommit,[journal.state.baselineStart??baselineHead,item.acceptedHead]):mergeCommit;
      if(fresh)savePairs(gitDir,name,{...loadPairs(gitDir,name),[published]:mergeCommit});
      for(const c of new Set([mergeCommit,published])){
        const priorNote=git(['notes','--ref=atelier','show',c],{cwd,allowFail:true});
        if(priorNote.status!==0||priorNote.stdout.trim()!==note.trim())git(['notes','--ref=atelier','add','-f','-m',note,c],{cwd});
      }
      const alreadyPublished=git(['merge-base','--is-ancestor',published,baselineHead],{cwd,allowFail:true}).status===0;
      git(['push','--quiet',base.remote,...(alreadyPublished?[]:[`${published}:refs/heads/${p.branch}`]),'refs/notes/atelier:refs/notes/atelier'],{cwd,token:base.token});
      journal.save({phase:'published'});
      await call('POST',`${I(name,id)}/merged`,{mergeCommit:published},OWNER);
      journal.clear();
      const notesPush=p.notesRemote?git(['push','--quiet',p.notesRemote,'refs/notes/atelier:refs/notes/atelier'],{cwd,allowFail:true}):null;
      console.log(`${id} merged as ${short(mergeCommit)} in ${cwd}${published!==mergeCommit?` (on the baseline as ${short(published)})`:""}; baseline and ledger agree.`);
      console.log(`Provenance: git notes --ref=atelier show ${short(mergeCommit)}`);
      if(notesPush?.status===0)console.log(`Provenance notes pushed to ${p.notesRemote}.`);
      else if(notesPush)console.log(`Provenance notes need retry: git push ${p.notesRemote} refs/notes/atelier:refs/notes/atelier`);
      console.log("The project branch was not pushed to its own remotes. Nothing was deployed.");
    } finally { unlock(); }
  },

  // The project owner lands one task whole: the lease on the server, the
  // merge of main into the task's workspace, the project's fixture
  // regeneration, the checks, the independent review, then accept and merge
  // (cli/land.mjs). Steps run as this CLI's own commands where they have one,
  // and each is recorded on the ledger as a land.* event.
  async land() {
    const name = project(), id = itemArg();
    const p = cfg.projects?.[name] ?? die(`${name} is not registered on this Mac`);
    if (!p.path || !existsSync(p.path)) die(`land needs ${name}'s registered checkout; this machine records ${p.path ?? "no folder"}. Run atelier init in that checkout first`);
    const workspace = workspacePath(name, id);
    // A request that throws rather than dies, so a landing that already holds
    // the lease can release it before the command ends. Requests are made as
    // the owner, except the re-claim that refreshes the workspace's write
    // token, which names the task's holder (and its runner) instead (t275).
    const request = async (method, path, body, as = OWNER, extra = {}) => {
      let res, text;
      try {
        res = await fetch(server() + "/api" + path, {
          method,
          headers: { authorization: `Bearer ${apiToken()}`, "x-atelier-actor": as, "content-type": "application/json", ...extra },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        text = await res.text();
      } catch (error) { throw new Error(`server request failed: ${error.message}`); }
      let data;
      try { data = JSON.parse(text); } catch { data = { error: "bad_response", detail: text.slice(0, 300) }; }
      // The status rides on the error, so a landing can tell a refusal
      // (the server answered, and said no) from a failure to reach it.
      if (!res.ok) throw Object.assign(new Error(`${data.error ?? res.status}: ${data.detail ?? text.slice(0, 300)}`), { status: res.status });
      return data;
    };
    // A git runner that throws rather than dies, for the same reason. With
    // allowFail it answers with git's own result, as the die-ing runner does.
    const gitOrThrow = (a, o = {}) => {
      const r = git(a, { ...o, allowFail: true });
      if (o.allowFail) return r;
      if (r.status !== 0) throw new Error(`git ${redactGitArgs(a).join(" ")} failed:\n${(r.stderr || r.stdout || r.error?.message || "").trim()}`);
      return o.raw ? r.stdout : r.stdout.trim();
    };
    try {
      await runLand({
        args, name, id, p, request, git: gitOrThrow, die,
        print: (line) => console.log(line),
        workspacePath, atelier: fileURLToPath(import.meta.url), env: process.env,
        redact, secrets: () => [apiToken(), ...workspaceTokens(workspace)],
        // The token a landing's re-claim minted, kept as claimWorkspace keeps
        // one: the old header replaced before the fetch, the expiry recorded.
        adoptWorkspaceToken: (dir, w) => {
          storeWorkspaceToken(dir, w.remote, w.token);
          recordTokenExpiry(dir, w.expiresAt);
          gitOrThrow(["fetch", "--quiet", "origin"], { cwd: dir });
        },
      });
    } catch (error) { die(error.message); }
  },

  // The project owner approves one protected action at one revision of the
  // main line (src/actions.ts). atelier ship uses it once, at that revision only.
  async approve() {
    const kind = args._[1];
    if (args._.length !== 2 || !kind) die(COMMAND_USAGE.approve);
    const name = project();
    if (!KIND.test(kind)) die(`"${kind}" is not an action name: use lower-case letters, digits and dashes, such as deploy`);
    const head = typeof args.head === "string" ? args.head.trim().toLowerCase() : "";
    if (!REVISION.test(head)) die(`--head needs the full revision of the main line, 40 or 64 hex digits: atelier approve ${kind} --head SHA. In the registered checkout, atelier ship --dry-run prints it`);
    const checkout = cfg.projects?.[name]?.path;
    const known = knownKinds(checkout && existsSync(checkout) ? checkout : null);
    if (!known.has(kind)) die(`${name} has no action called ${kind}. Atelier knows ${ACTION_KINDS.join(", ")}; ${name}'s ship files name ${[...known].filter((k) => !ACTION_KINDS.includes(k)).join(", ") || "no others"}`);
    const expires = args.expires ?? DEFAULT_EXPIRY;
    try { expirySeconds(expires); } catch (error) { die(`--expires: ${error.message}`); }
    const a = await call("POST", `${P(name)}/actions`, { kind, commit: head, note: args.note ?? "", expires }, OWNER);
    console.log(`${a.id}: ${a.kind} approved at ${short(a.commit)} until ${at(a.expiresAt)}. The next atelier ship at that revision uses it, once. To withdraw it: atelier approvals withdraw ${a.id}`);
  },

  async approvals() {
    const [, sub, id] = args._;
    const name = project();
    if (sub === "withdraw") {
      if (!id || args._.length !== 3) die(COMMAND_USAGE.approvals);
      const a = await call("POST", `${P(name)}/actions/${encodeURIComponent(id)}/withdraw`, { note: args.note ?? "" }, OWNER);
      return console.log(`${a.id}: ${a.kind} at ${short(a.commit)} is withdrawn; no ship will use it.`);
    }
    if (sub !== undefined || args.note !== undefined) die(COMMAND_USAGE.approvals);
    const { approvals } = await call("GET", `${P(name)}/actions`, undefined, OWNER);
    const shown = args.all ? approvals : approvals.filter((a) => a.status === "active");
    if (!shown.length) {
      return console.log(args.all || !approvals.length
        ? `No action has been approved for ${name}. The owner approves one with: atelier approve KIND --head SHA`
        : `No approval stands for ${name}; atelier approvals --all lists the used, withdrawn and expired ones.`);
    }
    console.log(formatApprovals(shown));
  },

  // The project owner records a standing decision for the project
  // (src/decisions.ts), with the owner's own words it rests on. The server
  // takes it from the owner's token alone.
  async decide() {
    const text = args._[1];
    if (args._.length !== 2 || !text?.trim()) die(COMMAND_USAGE.decide);
    if (typeof args.quote !== "string" || !args.quote.trim()) die(`a decision needs the owner's words: atelier decide "text" --quote "what the owner said"`);
    const name = project();
    const d = await call("POST", `${P(name)}/decisions`, { text, quote: args.quote }, OWNER);
    console.log(`${d.id}: recorded ${d.at.slice(0, 10)} for ${name}. Every review brief of ${name} and atelier guide --role orchestrate --project ${name} carry it. To withdraw it: atelier decisions withdraw ${d.id} --note "why"`);
  },

  async decisions() {
    const [, sub, id] = args._;
    const name = project();
    if (sub === "withdraw") {
      if (!id || args._.length !== 3) die(COMMAND_USAGE.decisions);
      if (typeof args.note !== "string" || !args.note.trim()) die(`withdrawing a decision needs a note saying why: atelier decisions withdraw ${id} --note "why"`);
      const d = await call("POST", `${P(name)}/decisions/${encodeURIComponent(id)}/withdraw`, { note: args.note }, OWNER);
      return console.log(`${d.id}: withdrawn ${d.withdrawn.at.slice(0, 10)}; it no longer appears in ${name}'s review briefs or its orchestrator's guide. atelier decisions --all still lists it.`);
    }
    if (sub !== undefined || args.note !== undefined) die(COMMAND_USAGE.decisions);
    const { decisions } = await call("GET", `${P(name)}/decisions`, undefined, OWNER);
    const shown = args.all ? decisions : decisions.filter((d) => d.status === "standing");
    if (!shown.length) {
      return console.log(args.all || !decisions.length
        ? `No standing decision is recorded for ${name}. The owner records one with: atelier decide "text" --quote "the owner's words"`
        : `No decision stands for ${name}; atelier decisions --all lists the withdrawn ones.`);
    }
    console.log(formatDecisions(shown));
  },

  // The project owner runs the project's ship order in its registered
  // checkout (cli/ship.mjs): each protected step only with an approval at the
  // revision shipped, each step recorded on the ledger.
  async ship() {
    if (args._.length !== 1) die(COMMAND_USAGE.ship);
    const name = project(), as = await actor(OWNER);
    if (as !== OWNER) die(`only the project owner ships: run ship as ${OWNER}, without --as or ATELIER_ACTOR naming another actor`);
    const p = cfg.projects?.[name];
    if (!p?.path || !existsSync(p.path)) die(`ship runs in ${name}'s registered checkout, and this machine has none; run atelier init in that checkout first`);
    const top = git(["rev-parse", "--show-toplevel"], { allowFail: true });
    if (top.status !== 0 || realpathSync(top.stdout.trim()) !== realpathSync(p.path)) die(`run ship in ${name}'s registered checkout: cd ${JSON.stringify(p.path)}`);
    const cwd = p.path, gitDir = git(["rev-parse", "--absolute-git-dir"], { cwd });
    const { head: baselineHead } = await call("GET", `${P(name)}/baseline-head`, undefined, OWNER);
    // The operations wrap refuses to run beside, read the way wrapReady reads them.
    const inProgress = () => [...new Set(Object.keys(WRAP_MARKERS).filter((marker) => (marker === "landing"
      ? [landingJournalFile(landingHome(gitDir)), oldLandingJournalFile(gitDir)]
      : [resolve(cwd, git(["rev-parse", "--git-path", marker], { cwd }))]).some((file) => existsSync(file))).map((marker) => WRAP_MARKERS[marker]))];
    await runShip({
      name, cwd, branch: p.branch, baselineHead, inProgress,
      paired: (sha) => (p.fresh === true ? loadPairs(gitDir, name)[sha] ?? null : sha),
      git: (a, o = {}) => git(a, o),
      request: (method, path, body) => call(method, path, body, OWNER),
      stage: (text) => { doneStep = text ?? undefined; },
      fail: (message) => die(message),
      print: (line) => console.log(line),
      // The wrap step is atelier wrap itself, run in the checkout as the owner would.
      wrap: (summary) => runCommand([process.execPath, fileURLToPath(import.meta.url), "wrap", summary, "--project", name], { cwd, env: process.env }),
      env: process.env,
      secrets: shipSecrets(process.env, [apiToken(), ...workspaceTokens(cwd)]),
      redact,
      dryRun: args["dry-run"] === true,
      push: args.push === true,
    });
  },

  // One line per live item, for a wrap to copy into STATE.md's Owner section.
  // The project owner: choose a remote that receives refs/notes/atelier on every
  // merge, or --off. Kept per Mac, beside the checkout path, never on the server.
  async "notes-remote"() {
    const name = project();
    const p = cfg.projects?.[name] ?? die(`${name} is not registered on this Mac`);
    if (args.off) {
      delete p.notesRemote;
      saveConfig(cfg);
      return console.log(`${name}: provenance notes stay local and in Artifacts.`);
    }
    const remote = args._[1];
    if (!remote) return console.log(p.notesRemote ? `${name}: notes go to ${p.notesRemote} on each merge.` : `${name}: notes stay local and in Artifacts. Set one with: atelier notes-remote REMOTE`);
    if (!git(["remote"], { cwd: p.path }).split("\n").includes(remote)) die(`${p.path} has no remote called ${remote}`);
    p.notesRemote = remote;
    saveConfig(cfg);
    console.log(`${name}: each merge now pushes refs/notes/atelier to ${remote}. The merged branch is never pushed.`);
  },

  // The project owner queues an open task for a kind of runner. A held task
  // (claimed, or submitted and perhaps rejected) is released and queued in
  // the same step, keeping its workspace and commits for the next builder.
  // --job merge-main sends a task whose landing conflicted with main back to
  // its builder (t243): the runner claims it, merges main at the named head
  // into its workspace and leaves the conflicts for the builder to resolve
  // and commit, where a plain rework would reset the workspace to a head
  // that cannot reach main.
  async dispatch() {
    const name = project(), id = itemArg();
    if (args.job !== undefined && args.job !== "merge-main") die(`--job names the job the runner runs; only merge-main is dispatched by hand: atelier dispatch ${id} --job merge-main`);
    if (args.head !== undefined && args.job === undefined) die(`--head names the main head a merge-main job merges; give it with --job merge-main: atelier dispatch ${id} --job merge-main --head FULL_HASH`);
    const body = { to: args.to, agent: args.agent, model: args.model, note: args.note, ...(args.job !== undefined ? { job: args.job, ...(args.head !== undefined ? { head: args.head } : {}) } : {}), ...(args["overlap-ok"] === true ? { overlapOk: true } : {}) };
    // With no --agent the server chooses the builder from the pool and the
    // models' records (t370), and says which and why.
    const suggest = args.agent === undefined && args.job === undefined;
    if (suggest) body.suggest = true;
    const item = await call("POST", `${I(name, id)}/dispatch`, body, OWNER);
    const d = item.dispatch;
    if (item.suggestion) console.log(`Builder: ${item.suggestion.actor}. ${item.suggestion.reasons.join(" ")}`);
    // A server older than the suggestion ignores the ask and leaves the dispatch open.
    else if (suggest && !d.agent) console.log("Warning: the server chose no builder; deploy the server, then dispatch again, or name one with --agent.");
    // A server older than the override ignores it and answers without it.
    if (args["overlap-ok"] === true && !d.overlapOk) console.log("Warning: the server did not record --overlap-ok; deploy the server, then dispatch again.");
    else if (d.overlapOk) console.log(`${id} is offered to a runner although its scope may overlap a live item's in a core file.`);
    if (d.job === "merge-main") {
      console.log(`${id} goes back to its builder to merge main at ${d.head.slice(0, 8)} into its workspace and resolve the conflicts: a runner that offers the merge-main job claims it, merges main there and leaves the conflicts for the harness to resolve and commit${d.agent ? ` (built by ${d.agent}${d.model ? ` with ${d.model}` : ""})` : ""}. Then run atelier land ${id} again.`);
      return;
    }
    console.log(`${id} is waiting for ${d.to === "any" ? "any runner" : `a ${d.to} runner`}${d.agent ? `, ${d.agent}` : ""}${d.model ? ` with ${d.model}` : ""}.`);
  },

  async undispatch() {
    const name = project(), id = itemArg();
    await call("POST", `${I(name, id)}/undispatch`, {}, OWNER);
    console.log(`${id} is no longer waiting for a runner.`);
  },

  // Everything waiting for a runner, across projects, oldest first.
  async queue() {
    await resolveTokenActor();
    const res = await fetch(server() + "/api/queue", { headers: { authorization: `Bearer ${apiToken()}`, "x-atelier-actor": tokenActor ?? OWNER } });
    if (!res.ok) die(`queue: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const incomplete = res.headers.get("x-atelier-incomplete");
    if (incomplete) console.log(`Could not read: ${incomplete}. Tasks waiting there are not listed.`);
    const queued = await res.json();
    if (!queued.length) return console.log("Nothing is waiting for a runner.");
    for (const { project, item } of queued) {
      const d = item.dispatch;
      console.log(`${project}/${item.id}  for ${d.to}${d.agent ? ` ${d.agent}` : ""}${d.model ? `/${d.model}` : ""}${d.job === "merge-main" ? "  merge-main" : ""}  ${item.title}`);
      if (item.held) console.log(`  held: ${holdText(item.held)}`);
    }
  },

  // The project owner's plans (docs/orchestrator.md, section 6). The word
  // after plan names a subcommand when it is one; otherwise the words are
  // the goal of a new plan. `plan post` is for the holder of the plan item's
  // claim, the planner, and runs as that actor; the rest are the owner's.
  async plan() {
    const words = args._.slice(1);
    const sub = Object.hasOwn(PLAN_FLAGS, words[0]) ? words[0] : null;
    const form = sub ? `plan ${sub}` : "plan";
    for (const flag of Object.keys(args.multi)) {
      if (!["project", "as", ...(PLAN_FLAGS[sub ?? ""] ?? [])].includes(flag)) die(`${form} does not take --${flag}; see atelier plan --help`);
    }
    const name = project(), flag = `--project ${name}`;
    if (!sub) {
      const goal = words.join(" ").trim();
      if (!goal) die(COMMAND_USAGE.plan);
      if (args.planner !== undefined && !/^[^/\s]+\/[^/\s]+$/.test(args.planner)) die("--planner needs harness/model, such as claude-code/opus-5.5");
      const scope = listArg("scope", "plan");
      const r = await call("POST", `${P(name)}/items`, { kind: "plan", goal, scope, ...(args.planner ? { planner: args.planner } : {}) }, OWNER);
      console.log(`${r.item.id} is a plan for: ${flat(goal)}`);
      console.log(`Planner: ${r.planner}. ${flat(r.reasons[0] ?? "")}`);
      console.log(`The plan job waits in the queue for ${r.planner}; a runner that offers plan jobs takes it. To plan by hand, claim ${r.item.id} as ${r.planner} with --runner home:NAME, then atelier plan post ${r.item.id} FILE. When a proposal arrives, read it with atelier plan show ${r.item.id} ${flag}.`);
      return;
    }
    const id = words[1];
    if (!id) die(COMMAND_USAGE.plan);
    if (words.length > (sub === "post" ? 3 : 2)) {
      die(`"${words.join(" ")}" reads as ${form} with too many words; ${form} takes ${sub === "post" ? "an id and a file" : "one id"}. If that phrase is the goal, quote it: atelier plan "${words.join(" ")}"`);
    }
    if (sub === "show") {
      const view = await call("GET", `${I(name, id)}/plan`, undefined, await actor(OWNER));
      return console.log(args.json ? JSON.stringify(view, null, 2) : planText(view, name));
    }
    if (sub === "post") {
      const file = words[2] ?? die("atelier plan post ID FILE: name the file that holds the plan document");
      let document;
      try { document = JSON.parse(readFileSync(file, "utf8")); } catch (error) { die(`${file} is not a JSON plan document: ${error.message}`); }
      const r = await call("POST", `${I(name, id)}/plan`, document, await actor());
      console.log(`Proposed ${r.parts} part${r.parts === 1 ? "" : "s"} for ${id} as ${r.hash}.`);
      console.log(`The owner reads it with atelier plan show ${id} and approves that hash. Release your claim: atelier release ${id} ${flag}`);
      return;
    }
    if (sub === "approve") {
      if (typeof args.hash !== "string" || !/^[a-f0-9]{64}$/.test(args.hash)) die(`--hash needs the full hash atelier plan show ${id} prints: atelier plan approve ${id} --hash HASH`);
      const view = await call("POST", `${I(name, id)}/plan/approve`, { hash: args.hash, allowPaid: args["allow-paid"] === true }, OWNER);
      const queued = view.parts.filter((p) => p.dispatch && p.state === "open");
      console.log(`${id} is approved at ${args.hash.slice(0, 12)}: ${view.parts.map((p) => `${p.id} ${p.key}`).join(", ")}.`);
      console.log(queued.length ? `Queued now: ${queued.map((p) => `${p.id} for ${p.dispatch.agent}/${p.dispatch.model}`).join(", ")}.` : "Nothing could start yet.");
      console.log(`Follow it with atelier plan show ${id} ${flag}`);
      return;
    }
    if (sub === "revise") {
      if (typeof args.note !== "string" || !args.note.trim()) die(`--note needs text: atelier plan revise ${id} --note "what to change"`);
      const view = await call("POST", `${I(name, id)}/plan/revise`, { note: args.note }, OWNER);
      console.log(`${id} is back in the queue for its planner, ${view.planner}, with your note. Its next proposal comes to your inbox.`);
      return;
    }
    if (sub === "reroute") {
      if (typeof args.to !== "string" || !args.to.trim()) die(`--to needs harness/model: atelier plan reroute ${id} --to claude-code/opus-5.5`);
      const view = await call("POST", `${I(name, id)}/plan/reroute`, { to: args.to }, OWNER);
      const part = view.parts.find((p) => p.id === id);
      // Only an open part's builder is rerouted, so a part submitted or
      // blocked now had its reviewer named.
      if (part && (part.state === "submitted" || part.state === "blocked")) {
        console.log(`${id} is reviewed by ${args.to.trim()} from now on; ${part.state === "blocked" ? `it is still blocked: ${flat(part.blocked?.reason ?? "")}` : "the plan asks it for the next review the part needs"}.`);
        return;
      }
      console.log(part ? `${id} is built by ${args.to} from now on; ${part.dispatch && part.state === "open" ? "it is queued for it" : `it is ${part.state}, and the plan dispatches it when it may start`}.` : `${id}'s planner is now ${view.planner}, and the plan job is queued for it.`);
      return;
    }
    if (sub === "retry") {
      const view = await call("POST", `${I(name, id)}/plan/retry`, {}, OWNER);
      const part = view.parts.find((p) => p.id === id);
      console.log(part ? `${id}'s attempts count afresh; ${part.dispatch && part.state === "open" ? `it is queued for ${part.dispatch.agent}/${part.dispatch.model}` : `it is ${part.state}`}.${view.blocked ? ` The plan is still blocked: ${flat(view.blocked)}` : ""}` : `${id}'s planner, ${view.planner}, is asked again; the plan job is queued for it.`);
      return;
    }
    // A plan submitted or accepted is put back to building by a refresh,
    // which withdraws the submission and any acceptance first; the server
    // says so with `reopened`.
    const reopenedLine = (view) => view.reopened ? `${id} was ${view.reopened.from === "accepted" ? `accepted at ${short(view.reopened.acceptedHead)}` : "submitted"}; that is withdrawn, and the plan is building again until its branch holds main. The integrator submits it again once every part is integrated.` : null;
    if (sub === "refresh" && args.resolve === true) {
      if (args.to !== undefined && (typeof args.to !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(args.to.trim()))) die(`--to needs harness/model: atelier plan refresh ${id} --resolve --to claude-code/opus-5.5`);
      const view = await call("POST", `${I(name, id)}/plan/refresh`, { resolve: true, ...(args.to !== undefined ? { to: args.to.trim() } : {}) }, OWNER);
      const main = view.refresh?.main ?? "";
      const part = view.parts.find((p) => p.added?.mainHead === main);
      const who = part?.dispatch && part.state === "open" ? `queued for ${part.dispatch.agent}/${part.dispatch.model}` : part ? `${part.state}, and the plan dispatches it before any other part` : "added";
      if (view.reopened) console.log(reopenedLine(view));
      console.log(`${view.item.id} has part ${part ? `${part.id} (${part.key})` : "merge-main"} to merge main at ${main.slice(0, 8)} into its branch: ${who}. Its builder resolves the conflicts; no other part is dispatched until it is integrated.`);
      console.log(`Follow it with atelier plan show ${view.item.id} ${flag}`);
      return;
    }
    if (sub === "refresh") {
      if (args.to !== undefined) die(`--to names the builder of the part --resolve adds: atelier plan refresh ${id} --resolve --to H/M`);
      const view = await call("POST", `${I(name, id)}/plan/refresh`, {}, OWNER);
      if (view.reopened) console.log(reopenedLine(view));
      const main = view.refresh?.last?.mainHead ?? view.refresh?.main ?? "";
      const taken = view.refresh?.taken;
      console.log(`${view.item.id}'s refresh from main at ${main.slice(0, 8)} is queued for atelier/integrator${taken ? `; the branch last took main at ${taken.slice(0, 8)}` : ""}. A runner started with --integrate merges it; parts wait for it before they are dispatched.`);
      console.log(`Follow it with atelier plan show ${view.item.id} ${flag}`);
      return;
    }
    if (sub === "stop") {
      const view = await call("POST", `${I(name, id)}/plan/stop`, { note: args.note ?? "" }, OWNER);
      const closed = [view.item, ...view.parts].filter((i) => i.state === "abandoned").map((i) => i.id);
      console.log(`${id} is stopped: ${closed.join(", ")} ${closed.length === 1 ? "is" : "are"} abandoned, and their write tokens revoked. History and evidence stay. A new plan may start.`);
    }
  },

  // The model pool. With no subcommand, lists it. `models add ID --harness H
  // --where home|cloud [--provider P] [--endpoint URL] [--keychain NAME]
  // [--alias A]... [--note TEXT]` adds or replaces an entry; `models remove ID`
  // removes one; `models note ID 'text' [--item tN]` keeps a dated note under
  // it, and `models show ID` prints it with its notes. Keys stay in the
  // Keychain; only the entry's name is sent.
  async models() {
    const [sub, id, text] = args._.slice(1);
    const modelLine = (m) => {
      const s = m.status ? `${m.status.state} ${m.status.at.slice(0, 16)}Z${m.status.served && m.status.served !== m.id ? ` as ${m.status.served}` : ""}` : "not checked";
      return `${m.where.padEnd(5)} ${m.harness}/${m.id}  ${m.family}  ${s}${m.keychain ? `  key: ${m.keychain}` : ""}`;
    };
    const taskOf = (n) => (n.project ? `${n.projectName ?? n.project}/${n.item}` : n.item);
    const noteLines = (m) => (m.notes ?? []).map((n) => `  ${n.at.slice(0, 10)} by ${n.by}${n.item ? ` on ${taskOf(n)}` : ""}: ${n.text}`);
    if (sub === "add") {
      if (!id) die("atelier models add ID --harness H --where home|cloud");
      for (const k of ["key", "api-key", "token"]) if (args[k] !== undefined) die("Atelier never stores keys; put the key in your Keychain and give its entry's name with --keychain");
      const entry = await call("PUT", `/models/${encodeURIComponent(id)}`, {
        harness: args.harness, where: args.where, provider: args.provider, endpoint: args.endpoint,
        keychain: args.keychain, aliases: args.multi.alias ?? [], note: args.note,
      }, OWNER);
      return console.log(`${entry.id} is in the pool: ${entry.harness}, ${entry.where}, ${entry.provider}${entry.keychain ? `, key in Keychain ${entry.keychain}` : ""}; family ${entry.family}.`);
    }
    if (sub === "remove") {
      if (!id) die("atelier models remove ID");
      const { removed } = await call("DELETE", `/models/${encodeURIComponent(id)}`, undefined, OWNER);
      return console.log(removed ? `${id} is no longer in the pool.` : `${id} was not in the pool.`);
    }
    if (sub === "note") {
      if (!id || args._.length !== 4) die("atelier models note ID 'text' [--item tN]");
      const body = args.item === undefined ? { text } : { text, item: args.item, project: project() };
      const note = await call("POST", `/models/${encodeURIComponent(id)}/notes`, body, OWNER);
      return console.log(`${id} has a new note, ${note.at.slice(0, 10)} by ${note.by}${note.item ? ` on ${taskOf(note)}` : ""}: ${note.text}`);
    }
    if (sub === "show") {
      if (!id) die("atelier models show ID");
      const m = (await call("GET", "/models", undefined, OWNER)).find((entry) => entry.id === id);
      if (!m) die(`${id} is not in the pool`);
      console.log(modelLine(m));
      const lines = noteLines(m);
      if (!lines.length) return console.log("  No notes yet. Add one: atelier models note ID 'text'");
      for (const line of lines) console.log(line);
      return;
    }
    if (sub) die(`${COMMAND_USAGE.models}\nunknown models command "${sub}"; use add, remove, note, show, or nothing to list`);
    const pool = await call("GET", "/models", undefined, OWNER);
    if (!pool.length) return console.log("The pool is empty. Add a model: atelier models add ID --harness H --where home|cloud");
    for (const m of pool) console.log([modelLine(m), ...noteLines(m)].join("\n"));
  },

  // The public showcase: which projects the owner shows, and whether each is
  // named or anonymised. Nothing is public until this says so.
  async showcase() {
    const [sub, name] = args._.slice(1);
    if (sub === "set") {
      if (!name || args._.length !== 3) die(COMMAND_USAGE.showcase);
      if (args.named === true && args.anonymous === true) die("give either --named or --anonymous, not both");
      const mode = args.named === true ? "named" : "anonymous";
      const r = await call("PUT", `/showcase/${encodeURIComponent(name)}`, { mode }, OWNER);
      return console.log(mode === "named"
        ? `${r.name} is shown on the public showcase at ${server()}/showcase, by name.`
        : `${r.name} is shown on the public showcase at ${server()}/showcase, anonymised: no project name, task title, path, commit message or address is drawn.`);
    }
    if (sub === "remove") {
      if (!name || args._.length !== 3) die(COMMAND_USAGE.showcase);
      const { removed, name: current } = await call("DELETE", `/showcase/${encodeURIComponent(name)}`, undefined, OWNER);
      return console.log(removed ? `${current ?? name} is no longer shown on the public showcase.` : `${name} was not shown on the public showcase.`);
    }
    if (sub) die(`${COMMAND_USAGE.showcase}\nunknown showcase command "${sub}"; use set, remove, or nothing to list`);
    const { showcase } = await call("GET", "/showcase", undefined, OWNER);
    if (!showcase.length) return console.log("Nothing is shown publicly. Add a project: atelier showcase set NAME");
    for (const s of showcase) console.log(`${s.mode.padEnd(10)} ${s.name}`);
  },

  // The project owner renames a project on the server, or removes it.
  async projects() {
    const [, sub, name, to] = args._;
    if (sub === "rename") {
      if (!name || !to || args._.length !== 4) die(COMMAND_USAGE.projects);
      const r = await call("POST", `${P(name)}/rename`, { to }, await actor(OWNER));
      // The server answers the new name for both when the request named it
      // to finish a rename: no entry moves, and the one under it stays.
      if (r.from === r.to) return console.log(`${r.to} is the project's name on ${server()}, and the rename that gave it that name is complete. The local config is unchanged.`);
      // The server says which name the project was registered under; the
      // local entry moves from that name. An entry already under the new
      // name is kept, and the old one dropped, saying what it held.
      let local = `No local config entry was called ${r.from}.`;
      const held = cfg.projects?.[r.from];
      if (held && !cfg.projects[r.to]) {
        cfg.projects[r.to] = held;
        delete cfg.projects[r.from];
        saveConfig(cfg);
        local = `The local config entry ${r.from} is now ${r.to}.`;
      } else if (held) {
        const settings = Object.entries(held).map(([k, v]) => `${k} ${typeof v === "string" ? v : JSON.stringify(v)}`);
        delete cfg.projects[r.from];
        saveConfig(cfg);
        local = `The local config already had an entry ${r.to}, which is kept; the entry ${r.from} was dropped (it held: ${settings.join(", ")}).`;
      }
      console.log(`${r.from} is now ${r.to} on ${server()}. Its Ledger, baseline ${r.project.repo} and every fork stay where they are. ${local}`);
      console.log(`${r.from} still works: the API serves it under that name, old page links redirect, tokens limited to it keep their access, and workspaces under ${join(CACHE, "work", r.from)} need no change.`);
      return;
    }
    if (sub !== "remove" || !name) die(COMMAND_USAGE.projects);
    await call("DELETE", P(name), { force: args.force === true }, await actor(OWNER));
    // The whole local entry goes; say what it held, since some of it (notesRemote) is set by hand.
    let dropped = "";
    if (cfg.projects?.[name]) {
      const held = Object.entries(cfg.projects[name]).map(([k, v]) => `${k} ${typeof v === "string" ? v : JSON.stringify(v)}`);
      dropped = held.length ? ` Local settings dropped: ${held.join(", ")}.` : "";
      delete cfg.projects[name];
      saveConfig(cfg);
    }
    console.log(`${name} removed from the project index and local config.${dropped} The Artifacts repository and project Ledger data are retained. Deleting a repository requires a separate, deliberate action by the owner.`);
  },

  async owners() {
    const name = project();
    const live = await call("GET", `${P(name)}/owners`, undefined, await actor(OWNER));
    if (args.json) return console.log(JSON.stringify({ project: name, source: server(), owners: live }, null, 2));
    if (!live.length) return console.log(`Atelier: no ${name} item is owned.`);
    for (const o of live) console.log(`Atelier: ${o.item} ${o.state}, owned by ${o.owner ?? "nobody"} since ${o.since.slice(0, 16)}Z (${server()}/p/${name}/${o.item}).`);
  },

  async inbox() {
    const entries = await call("GET", "/inbox", undefined, OWNER);
    if (args.json) return console.log(JSON.stringify(entries, null, 2));
    if (!entries.length) return console.log("Nothing needs you.");
    const seen = new Set();
    for (const x of entries) {
      const key = `${x.project}/${x.itemId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const brief = await call("GET", `${I(x.project, x.itemId)}/brief`, undefined, await actor(OWNER));
      console.log(formatBrief(x.project, x.itemId, brief, server()) + "\n");
    }
  },

  // The owner's queue: decisions waiting, tasks in progress, tasks waiting for a runner.
  async status() {
    if (args.brief) {
      const name = args.project ?? wsConfig("project") ?? registeredHere().name;
      if (!name) die("--brief reports on one project: add --project NAME");
      const as = await actor(OWNER);
      // What cannot be read is said in the brief, not fatal to it.
      const soft = (promise) => promise.catch(() => null);
      const [standing, version, queue, usage, lease] = await Promise.all([
        call("GET", `${P(name)}/standing`, undefined, as),
        soft(fetch(server() + "/api/version").then((r) => (r.ok ? r.json() : null))),
        soft(request("GET", "/queue", undefined, as)),
        soft(request("GET", "/usage", undefined, as)),
        landingLease(name, as),
      ]);
      const text = formatStatusBrief({ standing, version, queue, lease, usage });
      if (args.json) return console.log(JSON.stringify({ brief: text.split("\n") }, null, 2));
      console.log(text);
      pointToGuide([name]);
      return;
    }
    if (args.project !== undefined) {
      const name = args.project;
      const as = await actor(OWNER);
      const standing = await call("GET", `${P(name)}/standing`, undefined, as);
      const checkout = await checkoutStatus(name, as);
      const local = await localStanding(name, as);
      if (args.json) return console.log(JSON.stringify({ project: standing, checkout, ...(local ? { local } : {}) }, null, 2));
      console.log(tokenExpiryWarningsText(formatStanding(standing, OWNER_NAME, server()) + "\n\n" + checkout + (local ? "\n\n" + formatLocal(local) : "")));
      pointToGuide([name]);
      return;
    }
    const known = await call("GET", "/projects", undefined, OWNER);
    const chosen = known;
    const inbox = await call("GET", "/inbox", undefined, OWNER);
    // The runner queue and the offers each runner last asked with, so the
    // waiting section can say when a queued job — a review routed to a model
    // no live runner offers, say — can never be claimed, not merely waits
    // (t240), and the Runners section can list what each offers (t246).
    // Either read failing leaves the listing as it was.
    const [queue, offers] = await Promise.all([
      request("GET", "/queue", undefined, OWNER).catch(() => null),
      request("GET", "/runners", undefined, OWNER).catch(() => null),
    ]);
    const views = await Promise.all(chosen.map(async (p) => {
      const { items } = await call("GET", P(p.name), undefined, OWNER);
      return { name: p.name, title: p.title, items, inbox };
    }));
    if (args.json) return console.log(JSON.stringify(statusJson(views, server()), null, 2));
    console.log(tokenExpiryWarningsText(formatStatus(views, { queue, offers, server: server() })));
    pointToGuide(chosen.map((p) => p.name));
  },

  async open() {
    spawnSync("open", [`${server()}/home`]);
  },

  async guide() {
    if (args.full) {
      if (args.role !== "orchestrate") die("--full prints the orchestrate handbook: atelier guide --role orchestrate --full");
      process.stdout.write(readFileSync(new URL("../docs/orchestrating.md", import.meta.url), "utf8"));
      return;
    }
    if (args.role === undefined) { process.stdout.write(guideText()); return; }
    const role = args.role;
    if (!ROLES.includes(role)) die(`--role needs one of ${ROLES.join(", ")}: atelier guide --role build|review|plan|orchestrate`);
    const text = roleOverride(role) ?? rolePrompt(role);
    // The orchestrator's guide for a project ends with the owner's standing
    // decisions (src/decisions.ts), read from the server: the project is the
    // one --project names, else this workspace's or registered checkout's.
    // Outside any project, or for another role, the text stands alone and no
    // server is contacted.
    const name = role === "orchestrate" ? args.project ?? wsConfig("project") ?? registeredHere().name : null;
    if (!name) { process.stdout.write(text); return; }
    const { decisions } = await call("GET", `${P(name)}/decisions`, undefined, OWNER);
    process.stdout.write(`${text}\n${decisionsSection(decisions.filter((d) => d.status === "standing"))}\n`);
  },

  help() {
    console.log(helpText());
  },
};

if (isMain) {
  const cmd = args._[0] ?? "help";
  const fn = commands[cmd];
  if (!fn) die(`unknown command "${cmd}"; try atelier help`);
  // --version anywhere prints the CLI version and route level, the same for
  // every command, and --help/-h anywhere prints the command's usage, or the
  // general help. Both exit before any server contact.
  if (args.version) {
    console.log(VERSION_LINE);
    process.exit(0);
  }
  // --help/-h anywhere prints the command's usage, or the general help, and
  // exits before any server contact.
  if (args.help) {
    if (cmd !== "help" && COMMAND_USAGE[cmd]) console.log(COMMAND_USAGE[cmd]);
    else commands.help();
    process.exit(0);
  }
  checkFlags(cmd);
  await fn();
}
