#!/usr/bin/env node
// atelier — the command agents and the project owner run. No dependencies: Node and git.
//
// Agents work in a workspace clone under ~/Library/Caches, never in the iCloud
// checkout. Checks run in a second, clean clone of exactly the head Atelier
// sees in Artifacts. Session checks run in the registered checkout and are
// Reported; one that fails stops wrap before it stages anything, unless
// --allow-failing is given. Wrap commits and updates the baseline; checkout
// remote pushes are opt-in.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { constants as osConstants, homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import { stateFile, sessionText, WRAP_MARKERS, unmergedPaths, wrapRefusal } from "../src/sessions.ts";

import { contextBudget, evaluateCeilings, policyNotice, CONTEXT_BUDGET_PATH } from "../src/context-budget.ts";

import { redactGitArgs } from "./runner.mjs";
import { controlPlaneChanges, mergePolicyDecision, shipChanges } from "../src/control-plane.ts";
import { cleanSummary } from "../src/brief.ts";
import { recordedText } from "../src/rules.ts";
import { ROUTE_LEVEL } from "../src/route-level.ts";
export { controlPlaneChanges, mergePolicyDecision } from "../src/control-plane.ts";

import { hooksOff, landingDir, landingJournalFile, oldLandingJournalFile, RECEIPT_TEMPLATE, RECEIPTS_DIR } from "./landing.mjs";
import { loadPairs } from "./fresh.mjs";
import { applyIdentity } from "./identity.mjs";
import { markerPath } from "./gc.mjs";
import { taskLink } from "./status.mjs";
import { findStrays } from "./strays.mjs";
import { formatTokenExpiryWarnings, parseExpiryDay, readTokenExpiries, recordTokenExpiryDay, TOKEN_EXPIRY_WARN_DAYS } from "./token-expiry.mjs";
import { runnerCredential, readSecret } from "./credentials.mjs";
import { checkEnv } from "./check-env.mjs";
import { runGroup } from "./group.mjs";
export { checkEnv } from "./check-env.mjs";
import { COMMANDS, COMMAND_USAGE, commandFor } from "./help.mjs";
import { HANDLER_MODULES } from "./commands/index.mjs";
import { decisionLines } from "../src/decisions.ts";
import { shipPolicy } from "./ship.mjs";

const HOME = homedir();
const CONFIG_DIR = process.env.ATELIER_CONFIG_DIR ?? join(HOME, ".config", "atelier");
const CONFIG = join(CONFIG_DIR, "config.json");
export const CACHE = process.env.ATELIER_CACHE ?? join(HOME, "Library", "Caches", "ai-projects", "cloudflare-git");
const CHECK_TIMEOUT_MS = Number(process.env.ATELIER_CHECK_TIMEOUT ?? 20 * 60_000);
const CLI_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
// The one line --version prints, wherever it stands, ops included.
const VERSION_LINE = `atelier ${CLI_VERSION} (route level ${ROUTE_LEVEL})`;

// ── plumbing ───────────────────────────────────────────────────────────────

// What the commands change as they run: doneStep, the step done or ship is
// in, which die names; loginToken and loginServer, the token and the server
// `login` is checking, before either is saved. One object, since the command
// modules (cli/commands/) cannot assign this module's bindings.
export const cliState = { doneStep: undefined, loginToken: null, loginServer: null };
// Each check the run recorded: { claim, result, where }, read into done's outcome.
export const doneChecks = [];
export const CLEAN_CLONE = "in a clean clone on this machine", CONTAINER = "in a Cloudflare container";

export function die(msg, code = 1) {
  if (cliState.doneStep) msg = `${cliState.doneStep} failed: ${msg}`;
  process.stderr.write(`atelier: ${msg}\n`);
  process.exit(code);
}

function loadConfig() {
  try { return JSON.parse(readFileSync(CONFIG, "utf8")); } catch { return { server: null, projects: {} }; }
}
export function saveConfig(c) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
}

export const trimSlash = (url) => String(url).replace(/\/$/, "");

// ATELIER_TOKEN wins, for whichever server is in use: the environment is the
// user's own setting, for an agent's session or as an override. Otherwise the
// store for this system (see credentials.mjs) holds the token `login` stored
// once the server config.json names accepted it. Login writes the two
// together, so that server is the one the stored token belongs to, and the
// token goes nowhere else: with ATELIER_SERVER naming another server it is
// not sent, and the command says what to do instead.
export function apiToken() {
  if (cliState.loginToken) return cliState.loginToken;
  try {
    let name = process.env.ATELIER_RUNNER_NAME;
    if (!name && args._[0] === "runner" && !args.integrate && !args.discover && !args.usage && args._[1] !== "setup") name = args.name;
    if (!name && ["claim", "start"].includes(args._[0])) name = args.runner;
    const runner = runnerCredential(server(), name);
    if (runner) return runner;
  } catch (error) { die(error.message); }
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
export function storedToken() {
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
export function git(args, opts = {}) {
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
export const landingGit = (args, opts = {}) => git(args, { ...opts, hooks: false });

// A workspace keeps its write token in a file of its own,
// .git/atelier-credentials, which only this user can read (0600) and which
// .git/config includes. The CLI writes that file itself, so the token is
// never an argument to git: git config only adds the include and removes any
// header .git/config holds directly. The file is replaced whole, through a
// rename, so a reader sees the old token or the new one, never part of
// either. A newline in the remote or the token would start a new setting in
// the file, so either is refused.
const CREDENTIALS = "atelier-credentials";
export function storeWorkspaceToken(dir, remote, token) {
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
export function recordTokenExpiry(dir, expiresAt) {
  if (typeof expiresAt === "string" && expiresAt) git(["config", "--local", "atelier.write-token-expires-at", expiresAt], { cwd: dir });
}

// Every flag each command takes, and what it takes, as the command declares
// it in src/usage/commands/NAME.ts. `true` marks a switch: it never takes the
// word after it, so `review --approve t2` reviews t2 and `merge --cancel t1`
// cancels t1; the only values a switch accepts are the words true and false,
// as --flag=false or --flag false. Any other entry marks a flag that needs a
// value: a bare one is refused, so a forgotten value is never sent as the
// text "true" (a required check named true, a handoff to the actor true, the
// project true). `false` refuses it with the general message; a string is the
// message for that flag. A flag outside the command's row, or its
// subcommand's, is refused before the command runs. --project and --as belong
// to every row, since project() and actor() read them, and --help and
// --version anywhere print usage and the version. The commands that declare
// `rest` take `--` and the words after it. test/command-help.test.mjs holds
// this table to each command's help.
export const COMMON = { project: false, as: false };
export const FLAGS = Object.fromEntries(Object.values(COMMANDS).map((c) => [c.name, c.flags]));
const REST = new Set(Object.values(COMMANDS).filter((c) => c.rest).map((c) => c.name));
// version is a switch too, so --version=… is refused as a value it does not
// take, instead of slipping through as a string that answers anyway.
const ROWS = Object.values(COMMANDS).flatMap((c) => [c.flags, ...Object.values(c.subcommands ?? {}).map((sub) => sub.flags ?? {})]);
const SWITCHES = new Set(["version", ...ROWS.flatMap((row) => Object.keys(row).filter((flag) => row[flag] === true))]);
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
const switchesFor = (argv) => (commandFor(commandOf(argv) ?? "") === "status" ? SWITCHES : new Set([...SWITCHES].filter((flag) => flag !== "brief")));

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
// the command runs or contacts the server. A subcommand adds the flags it
// declares to its command's row.
const subcommandOf = (cmd, word) => (Object.hasOwn(COMMANDS[cmd].subcommands ?? {}, word ?? "") ? COMMANDS[cmd].subcommands[word] : null);
function checkFlags(cmd) {
  const subcommand = subcommandOf(cmd, args._[1]);
  const row = { ...COMMON, ...FLAGS[cmd], ...subcommand?.flags };
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

export const args = parseArgs(process.argv.slice(2));
export const cfg = isMain ? loadConfig() : {};

// The server says which actor stands for the project owner; `login` records it.
export const OWNER = process.env.ATELIER_OWNER ?? cfg.owner ?? "owner";
export const OWNER_NAME = cfg.ownerName ?? "the project owner";

// The server in use: the one `login` is checking, else ATELIER_SERVER, else
// the one config.json names. Every request goes through here, so an address
// the token must not travel to ends the command before any request is made.
export function server() {
  const s = cliState.loginServer ?? process.env.ATELIER_SERVER ?? cfg.server;
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

export function pointToGuide(names) {
  if (args.json) return;
  const line = guidePointer(cfg.projects, names, Boolean(wsConfig("item")));
  if (line) console.log(`\n${line}`);
}

export function wsConfig(key, cwd = process.cwd()) {
  const r = spawnSync("git", ["config", "--local", `atelier.${key}`], { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

export let tokenActor;
export let tokenRunner;
let resolvedCredential;

export async function actor(fallback) {
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
export function registeredHere() {
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  const here = top.status === 0 ? top.stdout.trim() : process.cwd();
  const real = (path) => { try { return realpathSync(path); } catch { return resolve(path); } };
  const name = top.status === 0 ? Object.entries(cfg.projects ?? {}).find(([, p]) => real(p.path) === real(here))?.[0] ?? null : null;
  return { here, name };
}

export function project() {
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
export function roleOverride(role) {
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
export function summaryArg(cmd) {
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
export function listArg(flag, cmd) {
  const values = args.multi[flag] ?? [];
  if (values.some((v) => typeof v !== "string" || !v.trim())) die(`--${flag} needs text: atelier ${cmd} --${flag} "TEXT", once per entry`);
  return values.map((v) => v.trim());
}

// --core, as init sends it: the globs given, once per use, or [] for one
// --core "" alone, which clears them; null when --core is not given, so the
// server keeps the recorded ones. Any other empty value is refused as a bare
// flag is, with the flag table's wording.
export function coreArg() {
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
export function fieldsArg(cmd) {
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
export function overrideArg(form) {
  const reason = args["override-review"];
  if (reason === undefined) return undefined;
  if (typeof reason !== "string" || !reason.trim()) die(`--override-review needs a reason: atelier ${form} --override-review "why no independent review is possible"`);
  return reason.trim();
}

export function itemArg(i = 1) {
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
export function requireWorkspace(cmd, name, id, as) {
  const held = { project: wsConfig("project"), item: wsConfig("item"), actor: wsConfig("actor") };
  if (held.project === name && held.item === id && held.actor === as) return;
  if (held.project !== name || held.item !== id) {
    const here = held.item ? `this directory is ${held.project}/${held.item}'s workspace` : "this directory is not a task workspace";
    die(`${cmd} must run in ${id}'s claimed workspace; ${here}. Run: cd ${JSON.stringify(workspacePath(name, id))} && atelier ${cmd} (after atelier claim ${id} --project ${name} if that workspace does not exist yet)`);
  }
  die(`${cmd} must run as the actor that claimed ${id} in this workspace, ${held.actor ?? "which is not recorded here"}, not ${as}; if ${id} is yours now, run atelier claim ${id} --as ${as} first`);
}

export async function resolveTokenActor() {
  if (resolvedCredential === apiToken() || !apiToken().startsWith("atl_")) return;
  const config = await call("GET", "/config");
  tokenActor = config.actor;
  tokenRunner = config.runner;
  resolvedCredential = apiToken();
  const declared = args.as ?? process.env.ATELIER_ACTOR;
  if (tokenActor && args._[0] !== "token" && declared !== undefined && declared !== tokenActor) die("--as and ATELIER_ACTOR must match the agent token actor");
}

export async function call(method, path, body, as, extra = {}) {
  try { return await request(method, path, body, as, extra); } catch (error) { if (error instanceof RequestError) die(error.message, error.code); throw error; }
}

// A request the server refused or could not answer: the message `call`
// prints and the exit code it ends with.
export class RequestError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

// `call` without ending the command: a failure throws a RequestError, so a
// caller can retry it or name the step that failed.
export async function request(method, path, body, as, extra = {}) {
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

export const P = (name) => `/projects/${encodeURIComponent(name)}`;
export const I = (name, id) => `${P(name)}/items/${encodeURIComponent(id)}`;
export const short = (s) => (s ? s.slice(0, 8) : "—");

// The owner's approval recorded on the project, or null when the project is
// not registered yet or records none. Asked with a plain request rather than
// `call`, because a project not yet registered answers 404, and here that is
// an answer, not a failure.
export async function recordedApproval(name) {
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

export function workspacePath(name, id) {
  return join(CACHE, "work", name, id);
}

// Test processes over an hour old left from a workspace on this machine
// (cli/strays.mjs), read under the cache's real path, the one ps and lsof
// report. ATELIER_STRAY_AGE_S, in seconds, replaces the hour, so a test can
// name a process it has just started.
export function localStrays() {
  let cache = CACHE;
  try { cache = realpathSync(CACHE); } catch { /* No cache yet: nothing ran from it. */ }
  const minAge = process.env.ATELIER_STRAY_AGE_S ? Number(process.env.ATELIER_STRAY_AGE_S) : NaN;
  return findStrays(cache, minAge >= 0 ? { minAge } : {});
}

// Where a checkout's landing lock and journal live (cli/landing.mjs): under
// the cache, outside the iCloud checkout.
export const landingHome = (gitDir) => landingDir(CACHE, gitDir);

// Take an item and prepare its workspace clone. The claim mints the write
// token for this actor alone, and the clone is reused when it already exists.
export async function claimWorkspace(name, id, as, runner) {
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
  if (!fresh) {
    git(["remote", "set-url", "origin", r.workspace.remote], { cwd: dir });
    git(["fetch", "--quiet", "origin"], { cwd: dir });
  }
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
export function forkBranch(cwd) {
  const r = git(["ls-remote", "--symref", "origin", "HEAD"], { cwd, allowFail: true });
  if (r.status !== 0) return null;
  return /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(r.stdout)?.[1] ?? null;
}

// Whether `commit` holds `ancestor` in its history, and whether the
// repository holds a commit at all, as git answers in the given directory.
export const holds = (ancestor, commit, cwd) => git(["merge-base", "--is-ancestor", ancestor, commit], { cwd, allowFail: true }).status === 0;
export const hasCommit = (sha, cwd) => git(["cat-file", "-e", `${sha}^{commit}`], { cwd, allowFail: true }).status === 0;
export const count = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;

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
export function workspaceTokens(dir) {
  if (!existsSync(join(dir, ".git"))) return [];
  const r = spawnSync("git", ["config", "--local", "--includes", "--get-regexp", "^http\\..*\\.extraheader$"], { cwd: dir, encoding: "utf8" });
  return r.status === 0 ? [...r.stdout.matchAll(/Bearer (\S+)/g)].map((m) => m[1]) : [];
}

export function cleanClone(remote, token, head, baseline, name) {
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
export function mergeWithMain(dir, id) {
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
// The check leads a process group of its own (runGroup in cli/group.mjs):
// when its shell exits, when its time limit passes or when its output
// overruns, every process left in the group is ended, and the result comes
// back only once the group is gone, so nothing the check started still
// writes in the clone when it is removed.
export async function runCheck(cmd, dir, secrets, graceMs = 5000) {
  process.stderr.write(`atelier: running \`${cmd}\` in a clean clone…\n`);
  const record = JSON.parse(readFileSync(markerPath(dir), "utf8"));
  const r = await runGroupedCheck(cmd, { cwd: dir, graceMs, onSpawn: (pid) => writeFileSync(markerPath(dir), JSON.stringify({ ...record, childPid: pid })) });
  writeFileSync(markerPath(dir), JSON.stringify(record));
  const output = redact(`${r.stdout}${r.stderr}${r.error ? `\n[atelier] check ${r.error.message}` : ""}`, secrets);
  return { passed: r.status === 0 && !r.error, output, sha: createHash("sha256").update(output).digest("hex") };
}

// One registered check through runGroup, bounded by CHECK_TIMEOUT_MS. An
// interrupt, a terminal hang-up or a SIGTERM of this command does not reach
// the check's group, so each ends this process, and runGroup ends the group
// on the way out.
export async function runGroupedCheck(cmd, { cwd, env = checkEnv(), graceMs, onSpawn, maxBytes }) {
  const onInt = interrupted("SIGINT"), onTerm = interrupted("SIGTERM"), onHup = interrupted("SIGHUP");
  process.once("SIGINT", onInt).once("SIGTERM", onTerm).once("SIGHUP", onHup);
  try { return await runGroup(["/bin/sh", "-c", cmd], { cwd, env, timeoutMs: CHECK_TIMEOUT_MS, graceMs, maxBytes, onSpawn }); }
  finally { process.off("SIGINT", onInt).off("SIGTERM", onTerm).off("SIGHUP", onHup); }
}

const interrupted = (sig) => () => process.exit(128 + osConstants.signals[sig]);

// Posts one check's result. A server that cannot answer (no connection, a
// 5xx, 408 or 429) is asked once more; a failure then ends the command with
// the step named, and the clone is removed on the way out.
export async function postEvidence(path, body, as) {
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
export function removeClone(dir) {
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

export function readJson(path) {
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
export function writeReceipt(cwd, { name, id, item, owners, view, reviews, policy, branch, notesRemote, changeClass }) {
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
export async function checkInSandbox() {
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
  if (!cliState.doneStep && state.results.some((r) => r.passed === false)) process.exit(2);
}

// What an agent relays is one line per field: text a person or an agent
// wrote (a review note, a title, a dispatch note) is flattened, so a newline
// inside it can never pose as a line of the verdict, and terminal control
// codes are dropped. Atelier's own wording is what the lines start with.
export const flat = (value) => stripVTControlCharacters(String(value)).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").trim();

// Where a project stands, as plain text an agent can paste into a chat: one
// line per item, and any text a person or agent wrote flattened.
export const at = (iso) => `${String(iso).slice(0, 16).replace("T", " ")} UTC`;
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
export function progressToStderr() {
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
export const newestReviews = (reviews) => [...reviews].sort((a, b) => b.at.localeCompare(a.at));

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
export async function checkoutStatus(name, as) {
  return flat(await checkoutStatusLine(name, as));
}

export async function checkoutStatusLine(name, as) {
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
export async function landingLease(name, as) {
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
export async function localStanding(name, as) {
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
export function remoteStatusLines(name, cwd) {
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

export function sessionCheckout(name, requireHere = false) {
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

export function sessionFiles(cwd) {
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

export function sessionTree(cwd) {
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
export function wrapReady(name, cwd, report) {
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
export async function postAsRunner(path, body, runner, signal) {
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
export async function discoverModels() {
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
export async function setupRunner() {
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
export async function reportUsage() {
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
export function tokenExpiryWarningsText(text) {
  const warnings = formatTokenExpiryWarnings(readTokenExpiries());
  return warnings.length ? `${warnings.join("\n")}\n\n${text}` : text;
}

// Each command's handler, the default export of cli/commands/NAME.mjs, by
// the command's name. cli/commands/index.mjs lists the modules (node
// cli/regenerate.mjs writes it). A handler for a command no module in
// src/usage/commands declares, a second handler for one, and a declared
// command without a handler fail here, naming the modules. A handler imports
// from this module; it never imports, dynamically, a module that imports this
// one, since that import would wait on the top-level await below, which waits
// on the handler.
export function registerHandlers(modules, commands = COMMANDS) {
  const handlers = new Map();
  for (const { path, run } of modules) {
    const name = path.slice(path.lastIndexOf("/") + 1).replace(/\.mjs$/, "");
    if (!Object.hasOwn(commands, name)) throw new Error(`${path}: handles atelier ${name}, which no module in src/usage/commands declares`);
    if (handlers.has(name)) throw new Error(`atelier ${name} has two handlers: ${handlers.get(name).path} and ${path}`);
    if (typeof run !== "function") throw new Error(`${path}: its default export is not the command's handler`);
    handlers.set(name, { path, run });
  }
  for (const name of Object.keys(commands)) if (!handlers.has(name)) throw new Error(`atelier ${name} has no handler: cli/commands/${name}.mjs`);
  return new Map([...handlers].map(([name, h]) => [name, h.run]));
}
export const HANDLERS = registerHandlers(HANDLER_MODULES);

if (isMain) {
  // The command a word names, by its name or one of its aliases.
  const word = args._[0] ?? "help", cmd = commandFor(word);
  const fn = cmd && HANDLERS.get(cmd);
  if (!fn) die(`unknown command "${word}"; try atelier help`);
  // --version anywhere prints the CLI version and route level, the same for
  // every command, and --help/-h anywhere prints the command's usage, or the
  // general help. Both exit before any server contact.
  if (args.version) {
    console.log(VERSION_LINE);
    process.exit(0);
  }
  // --help/-h anywhere prints the command's usage, a subcommand's own where
  // it declares one, or the general help, and exits before any server contact.
  if (args.help) {
    const subcommand = subcommandOf(cmd, args._[1]);
    if (subcommand?.usage) console.log(subcommand.usage);
    else if (cmd !== "help" && COMMAND_USAGE[cmd]) console.log(COMMAND_USAGE[cmd]);
    else HANDLERS.get("help")();
    process.exit(0);
  }
  checkFlags(cmd);
  await fn();
}
