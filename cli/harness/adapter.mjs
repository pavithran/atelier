// The harness adapters Atelier ships (bin/harness/atelier-*.mjs): the
// programs a runner config's command names for each harness, and the ones the
// runner runs when an entry gives no command (defaultCommand in
// runner-config.mjs). Each takes the runner's six arguments,
//
//   ADAPTER [--providers DIR] [--secret-store NAME] [--secrets-dir DIR] MODEL BRIEF WORKSPACE PLAN DIFF VERDICT
//
// (docs/runners.md, "The wrapper contract"), puts the agent rules in front of
// the brief, and gives the prompt to the harness on standard input, never as
// an argument: the operating system caps arguments near 1 MB, and a review of
// t241 lost its verdict twice to that cap. A review's answer goes to VERDICT.
// No adapter holds a key: the opencode adapter reads its provider's key and
// the gateway token from the credential store at run time (credentials.mjs)
// and gives them to opencode alone; the others use their harness's own login.

import { execFile, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

import { NO_VERDICT, VERIFY_BASE_LINE, VERIFY_HEADING, criteriaAsked, parseVerdict } from "../../src/review/verdict.ts";
import { readSecret } from "../credentials.mjs";
import { GATEWAY_TOKEN_KEY, GATEWAY_TOKEN_VAR, METADATA_VAR, OPENCODE2_CONFIG_CONTENT, RUN_LIMITS, TRANSPORT_ERROR, metadataEscaped, openRouterRefusal } from "./providers.mjs";

const UNSET = "undefined";

// The arguments, with the runner's "undefined" for a placeholder the job does
// not use made null.
export function parseArgs(argv) {
  const options = {};
  const rest = [...argv];
  while (rest[0]?.startsWith("--")) {
    const name = rest.shift().slice(2);
    if (!rest.length) throw new Error(`--${name} needs a value`);
    options[name] = rest.shift();
  }
  if (rest.length !== 6) throw new Error("usage: ADAPTER [--providers DIR] [--secret-store NAME] [--secrets-dir DIR] MODEL BRIEF WORKSPACE PLAN DIFF VERDICT");
  const [model, brief, workspace, plan, diff, verdict] = rest.map((v) => (v === UNSET || v === "" ? null : v));
  if (!model || !brief || !workspace) throw new Error("MODEL, BRIEF and WORKSPACE are required");
  return { options, model, brief, workspace: resolve(workspace), plan, diff, verdict };
}

export function jobKind(args) {
  return args.verdict ? "review" : args.plan ? "plan" : "build";
}

// The agent rules every build and plan prompt begins with, before the brief.
export function agentRules(harness, model, workspace, plan) {
  const rules = [
    "Agent rules (from Atelier's harness adapter):",
    `- Only this workspace, ${workspace}, may be read or written. Every path outside it is refused and may end the run; what you need is inside it.`,
    "- Do not push. Run no atelier command. Do not change Git remotes or configuration.",
  ];
  if (plan) {
    rules.push(`- This is a plan job: write the plan document, as JSON, to ${relative(workspace, plan) || plan} and commit nothing.`);
  } else {
    rules.push(
      "- Run the project's required checks before you finish, and fix what fails.",
      `- Commit your work before you end, with plain single commands: git add FILES, then git commit -m "subject" -m "Agent: ${harness}/${model}". No heredoc, no -F -, no && chain, no redirection: the harness refuses them, and a run that ends without a commit loses its work.`,
    );
  }
  return rules.join("\n");
}

// A fence longer than any run of backticks in the text (at least four), so
// nothing in a diff can close it.
function fenceFor(text) {
  let longest = 3;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return "`".repeat(longest + 1);
}

// Where the reviewer may look: the current folder, or for a Codex review,
// whose current folder is an empty scratch one (t140), the clone it reads.
function lookFor(clone) {
  return clone
    ? `The clone under review is ${clone}: read it there and run the project's tests against it, but your current folder is an empty scratch folder, where you may write, as you may the system temp folder; the clone is read-only to you.`
    : "In the current folder you may read files and run the project's tests.";
}

export function reviewPrompt(brief, diff, clone) {
  const fence = fenceFor(diff);
  return [
    brief.replace(/\n+$/, ""),
    "",
    "The change under review:",
    `${fence}diff`,
    diff.replace(/\n+$/, ""),
    fence,
    "",
    `${lookFor(clone)} Edit nothing, do not push and run no atelier command; verify a blocking finding before you state it.`,
    VERDICT_DEMAND,
  ].join("\n");
}

// A verification job (t717, src/review/verify.ts) runs as a review job: the
// same six arguments, the answer in VERDICT. Its brief opens with
// VERIFY_HEADING, which is how the adapter knows to end the prompt with the
// verification format and not the review's VERDICT and FINDING lines: a
// verifier that followed those would answer in a shape parseVerification
// cannot read, and the request would be released.
export const isVerification = (brief) => brief.startsWith(VERIFY_HEADING);

export const VERIFY_DEMAND = "Your reply MUST end with one line for each finding in the brief, the findings numbered as the brief numbers them: FINDING n: CONFIRMED because ..., or FINDING n: NOT CONFIRMED because ... . Write no VERDICT line, no SUMMARY line and no FINDING: blocking or FINDING: follow-up line: this is not a review of the change.";

// The same demand when the brief offers PRE-EXISTING (the check was given a
// base commit): the last instruction of a prompt wins over the brief, so it
// must allow every answer the brief does (t717, round 4).
export const VERIFY_DEMAND_BASE = "Your reply MUST end with one line for each finding in the brief, the findings numbered as the brief numbers them: FINDING n: CONFIRMED because ..., or FINDING n: NOT CONFIRMED because ..., or FINDING n: PRE-EXISTING because ... for a defect already present at the base commit the brief names. Write no VERDICT line, no SUMMARY line and no FINDING: blocking or FINDING: follow-up line: this is not a review of the change.";

// The last instruction of a review job's prompt, whichever adapter composes it.
export function demandFor(brief) {
  if (!isVerification(brief)) return VERDICT_DEMAND;
  return brief.includes(VERIFY_BASE_LINE) ? VERIFY_DEMAND_BASE : VERIFY_DEMAND;
}

export function verificationPrompt(brief, diff, clone) {
  const fence = fenceFor(diff);
  return [
    brief.replace(/\n+$/, ""),
    "",
    "The whole change under review:",
    `${fence}diff`,
    diff.replace(/\n+$/, ""),
    fence,
    "",
    `${lookFor(clone)} Edit nothing, do not push and run no atelier command; confirm a finding only when you have shown it yourself.`,
    demandFor(brief),
  ].join("\n");
}

// What every review prompt ends with. GLM 5.3 under opencode answered
// review after review in prose with no VERDICT line, 48 replies released
// overnight on 2026-10-13 ("the reply states no verdict"), yet answered at
// once when the brief ended by demanding the line as the reply's last (t576).
export const VERDICT_DEMAND = "Your reply MUST end with exactly one line, the last line of your reply, either VERDICT: APPROVE or VERDICT: REJECT, preceded by a SUMMARY: line on what you checked, a BLOCKING: N line with the number of blocking findings (0 for none) and one FINDING: blocking|follow-up PATH:LINE text line per finding.";

// The second ask, in the same opencode session, when the first reply states
// no verdict: the lines alone, no new review (t576). A change with
// acceptance criteria is asked for one CRITERION line per criterion as well,
// as many as the brief's reply format asks for (criteriaAsked): an approval
// without them is refused by parseVerdict, given the task's criterion count
// by the runner, and the review released (Astra's review of t576,
// 2026-10-13). The ask ends with the lines themselves, one per criterion, so
// a reviewer who copies them and fills them in gives a complete reply.
export function verdictFollowUp(criteria) {
  const count = Number.isSafeInteger(criteria) && criteria > 0 ? criteria : 0;
  if (!count) return VERDICT_FOLLOW_UP;
  return [
    VERDICT_FOLLOW_UP_HEAD,
    `Reply with only these lines: a SUMMARY: line on what you checked, a BLOCKING: N line with the number of blocking findings (0 for none), one FINDING: blocking|follow-up PATH:LINE text line per finding (REJECT needs at least one blocking finding, APPROVE allows none), one CRITERION line for each of the ${count} acceptance criteria, numbered as the brief's reply format numbers them, saying met or unmet (or deferred, only where the brief allows it) and then how you proved it: what you did and what you saw, from your review above (an approval needs every criterion met), and last exactly one line, either VERDICT: APPROVE or VERDICT: REJECT.`,
    "In this shape, with your own words after each colon and dash:",
    "SUMMARY: What you checked, in one sentence.",
    ...Array.from({ length: count }, (_, i) => `CRITERION ${i + 1}: met — What you did to prove criterion ${i + 1} met, and what you saw.`),
    "VERDICT: APPROVE",
  ].join("\n");
}

const VERDICT_FOLLOW_UP_HEAD = "Your reply above states no verdict, so Atelier cannot read it. Do not review again and run nothing.";
export const VERDICT_FOLLOW_UP = [
  VERDICT_FOLLOW_UP_HEAD,
  "Reply with only these lines: a SUMMARY: line on what you checked, a BLOCKING: N line with the number of blocking findings (0 for none), one FINDING: blocking|follow-up PATH:LINE text line per finding (REJECT needs at least one blocking finding, APPROVE allows none), and last exactly one line, either VERDICT: APPROVE or VERDICT: REJECT.",
].join("\n");

// The prompt for the job, which goes to the harness on standard input.
export function promptFor(harness, args, read = (f) => readFileSync(f, "utf8")) {
  const brief = read(args.brief);
  if (jobKind(args) === "review") {
    const diff = args.diff ? read(args.diff) : "";
    // A Codex review runs in a scratch folder, so its prompt names the clone.
    const clone = harness === "codex" ? args.workspace : undefined;
    return isVerification(brief) ? verificationPrompt(brief, diff, clone) : reviewPrompt(brief, diff, clone);
  }
  return `${agentRules(harness, args.model, args.workspace, args.plan)}\n\n${brief}`;
}

// ── the four harnesses ──────────────────────────────────────────────────────

// Claude Code's model ids for Atelier's: opus-5.5 is claude-opus-5-5.
export function claudeModel(model) {
  return model.startsWith("claude-") ? model : `claude-${model.replace(/\./g, "-")}`;
}

// Claude Code sees no MCP server (--strict-mcp-config with an empty list), so
// nothing outside the workspace reaches it, and may use only the tools named.
const CLAUDE_BUILD_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep", "TodoWrite",
  "Bash(git add:*)", "Bash(git commit:*)", "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)", "Bash(git rm:*)", "Bash(git mv:*)",
  "Bash(npm test:*)", "Bash(npm run:*)", "Bash(npm ci:*)", "Bash(npx:*)", "Bash(node:*)", "Bash(ls:*)", "Bash(mkdir:*)"];
const CLAUDE_REVIEW_TOOLS = ["Read", "Glob", "Grep", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)", "Bash(git status:*)", "Bash(npm test:*)", "Bash(npm run:*)", "Bash(npx:*)", "Bash(node:*)", "Bash(ls:*)"];
const CLAUDE_DENIED = ["Bash(git push:*)", "Bash(atelier:*)", "WebFetch", "WebSearch"];

// Antigravity's model ids for Atelier's; any other id passes through.
// The review adapter (cli/agy-review.mjs) reads this table too (t573).
export const AGY_MODELS = { "gemini-4-argon": "gemini-4-argon-high", "gemini-3.1-pro": "gemini-3.1-pro-high", "gemini-3.8-flash": "gemini-3.8-flash-high", "claude-opus-5.5": "claude-opus-5-5-high", "claude-sonnet-5.5": "claude-sonnet-5-5-high", "gpt-oss-120b": "gpt-oss-120b-medium" };

// For each harness, the command for a job: { argv, verdictFrom } where
// verdictFrom says how the review's answer is read: "stdout", "file" (the
// harness writes it to VERDICT itself) or "agy-json" (agy's JSON response).
export const HARNESSES = {
  "claude-code": {
    executable: "claude",
    command(args, kind) {
      const tools = kind === "review" ? CLAUDE_REVIEW_TOOLS : CLAUDE_BUILD_TOOLS;
      const denied = kind === "review" ? [...CLAUDE_DENIED, "Edit", "Write"] : CLAUDE_DENIED;
      return {
        argv: ["-p", "--model", claudeModel(args.model), "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
          "--permission-mode", kind === "review" ? "default" : "acceptEdits",
          "--allowedTools", tools.join(","), "--disallowedTools", denied.join(","), "--output-format", "text"],
        verdictFrom: "stdout",
      };
    },
  },
  codex: {
    executable: "codex",
    command(args, kind, setup) {
      // A review starts in setup.scratch, a fresh empty folder made outside
      // the clone (t140): read-only refuses mkdtemp under the system temp
      // folder, so gpt-6-astra could not run a test that makes a scratch
      // folder. Under workspace-write it can write that folder and the system
      // temp folder; the clone, its .git and the network stay closed to it, and
      // the two overrides keep a config.toml from opening them again.
      if (kind === "review") return { argv: [...setup.noMcp, "exec", "--model", args.model, "--skip-git-repo-check", "--cd", setup.scratch, "--sandbox", "workspace-write", "-c", "sandbox_workspace_write.writable_roots=[]", "-c", "sandbox_workspace_write.network_access=false", "--output-last-message", args.verdict, "-"], verdictFrom: "file" };
      const common = [...setup.noMcp, "exec", "--model", args.model, "--skip-git-repo-check", "--cd", args.workspace];
      // Its workspace-write sandbox keeps .git read-only unless it is named
      // a writable root, and a build has to commit.
      return { argv: [...common, "--sandbox", "workspace-write", "-c", `sandbox_workspace_write.writable_roots=${JSON.stringify([join(args.workspace, ".git")])}`, "-"], verdictFrom: "stdout" };
    },
  },
  opencode: {
    executable: "opencode",
    command(args, kind, setup) {
      return { argv: ["run", ...standalone(setup), "--model", `${setup.provider}/${setup.providerModel}`], verdictFrom: "stdout" };
    },
    // The same session again: the run's own data folder (runHome) holds this
    // job's session alone, so --continue resumes the review just answered.
    followUp(args, kind, setup) {
      return ["run", ...standalone(setup), "--model", `${setup.provider}/${setup.providerModel}`, "--continue"];
    },
  },
  antigravity: {
    executable: "agy",
    // Reviews keep the terminal sandbox; builds run without it (d14, PAVI
    // 2026-10-13: with skip-permissions the sandbox only blocked the build's
    // own installs, tests and commit, then let them through outside it).
    command(args, kind) {
      return { argv: ["--model", AGY_MODELS[args.model] ?? args.model, "--dangerously-skip-permissions", ...(kind === "review" ? ["--sandbox"] : []), "--output-format", "json", "--print-timeout", "2400s"], verdictFrom: "agy-json" };
    },
  },
};

// opencode 2's `run` connects to a background service shared by every run
// unless it is given --standalone, and the service keeps its own data folder,
// which undoes the run's (runHome, XDG_DATA_HOME); opencode 1 has no such
// service and may reject the flag (t683). So the flag follows the major
// version, which runAdapter reads into setup.major.
function standalone(setup) {
  return setup.major >= 2 ? ["--standalone"] : [];
}

// The major version of the opencode at `exe`, from `exe --version` ("1.18.34",
// "opencode v2.0.29"), asked once per executable and kept. null when it
// cannot be read; runAdapter then refuses the run.
const majors = new Map();
export function opencodeMajor(exe, env, spawn = spawnSync) {
  if (majors.has(exe)) return majors.get(exe);
  const r = spawn(exe, ["--version"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
  const found = r.error || r.status !== 0 ? null : /(\d+)\.\d+\.\d+/.exec(String(r.stdout ?? ""));
  const major = found ? Number(found[1]) : null;
  if (major !== null) majors.set(exe, major);
  return major;
}

// The executable for a harness: its name on the PATH, or the variable that
// names a stand-in (ATELIER_CLAUDE, ATELIER_CODEX, ATELIER_OPENCODE,
// ATELIER_AGY), which tests use. A runner never passes an ATELIER_ variable to
// a harness, so a runner's adapter always runs the real one.
const OVERRIDE = { "claude-code": "ATELIER_CLAUDE", codex: "ATELIER_CODEX", opencode: "ATELIER_OPENCODE", antigravity: "ATELIER_AGY" };
export function executableFor(harness, env = process.env) {
  return env[OVERRIDE[harness]] || HARNESSES[harness].executable;
}

// Whether a harness can run a job at all, asked before a runner offers it
// (the finding on ourai/t63, 2026-10-14, and on every claude-code job of
// 2026-10-16: the build was claimed, then the CLI exited "Not logged in").
// Claude Code and Codex have a probe; the other harnesses are taken as ready.
// A probe that cannot run, times out, or prints anything but a clear
// "signed in" counts as not signed in, so the harness is dropped, never
// offered on a guess.
export const SIGN_IN_TIMEOUT_MS = 15_000;
const CLAUDE_TOKEN_FILE = ".config/api-keys/claude-code-auth.key";
export const SIGN_IN_FIX = {
  "claude-code": `run \`claude auth login\` as this user, or put a \`claude setup-token\` token in ~/${CLAUDE_TOKEN_FILE}`,
  codex: "run `codex login` as this user",
};

// The environment the job gives Claude Code, which `env` is (harnessEnv in
// runner.mjs: no variable whose name says it holds a secret unless the entry
// names it). The key file's token is added only when the job's own command
// loads it: a wrapper script that mentions the file, as ~/.local/bin/atelier-
// claude does. The shipped Node adapter does not, so a probe must not either.
// The token goes to the probe's environment alone and is never printed.
function claudeProbeEnv(env, command, home) {
  const out = { ...env };
  try {
    const wrapper = command?.[0];
    if (typeof wrapper !== "string" || !readFileSync(wrapper, "utf8").includes(CLAUDE_TOKEN_FILE)) return out;
    const token = readFileSync(join(home, CLAUDE_TOKEN_FILE), "utf8").replace(/\n/g, "");
    if (token) out.CLAUDE_CODE_OAUTH_TOKEN = token;
  } catch { /* no wrapper script or key file: the CLI's own sign-in is what counts */ }
  return out;
}

// { ready, why }: `why` names the fix when the harness is not ready.
// `run(exe, args, options)` resolves { code, stdout } and is replaceable.
export async function harnessReady(harness, { env = process.env, command, home = homedir(), timeoutMs = SIGN_IN_TIMEOUT_MS, run = runProbe } = {}) {
  const fix = SIGN_IN_FIX[harness];
  // Codex (t558): `codex login status` exits 0 only when signed in. A non-zero
  // exit, a missing binary or a timeout is not ready.
  if (harness === "codex") {
    try {
      const result = await run(executableFor(harness, process.env), ["login", "status"], { env: { ...env }, timeout: timeoutMs });
      return result.code === 0 ? { ready: true } : { ready: false, why: `Codex is not signed in; ${fix}` };
    } catch (error) {
      return { ready: false, why: `could not check whether Codex is signed in (${String(error?.message ?? error).split("\n")[0].slice(0, 120)}); ${fix}` };
    }
  }
  if (harness !== "claude-code") return { ready: true };
  try {
    const result = await run(executableFor(harness, process.env), ["auth", "status"], { env: claudeProbeEnv(env, command, home), timeout: timeoutMs });
    let signedIn = false;
    try { signedIn = result.code === 0 && JSON.parse(result.stdout)?.loggedIn === true; } catch { /* not JSON: not signed in */ }
    return signedIn ? { ready: true } : { ready: false, why: `the Claude CLI is not signed in; ${fix}` };
  } catch (error) {
    return { ready: false, why: `could not check whether the Claude CLI is signed in (${String(error?.message ?? error).split("\n")[0].slice(0, 120)}); ${fix}` };
  }
}

function runProbe(exe, args, { env, timeout }) {
  return new Promise((resolve, reject) => {
    execFile(exe, args, { env, timeout, encoding: "utf8", maxBuffer: 1 << 20 }, (error, stdout) => {
      if (error && typeof error.code !== "number") reject(error);
      else resolve({ code: error ? error.code : 0, stdout });
    });
  });
}

// Codex's features that bring their own MCP servers (plugins, apps, browser
// and computer use), switched off as features: enabled=false on a server one
// of them provides breaks codex's configuration load ("invalid transport in
// mcp_servers.code-review", gpt-6-astra on b8d81cf3, codex-cli 0.160.0).
export const CODEX_FEATURES_OFF = ["plugins", "apps", "browser_use", "browser_use_external", "computer_use", "in_app_browser"]
  .flatMap((feature) => ["--disable", feature]);

// The servers `codex mcp list --json` prints with `flags` before the
// subcommand, from the folder the job starts in: a
// list of { name, enabled, ... } or, in older releases, an object keyed by name.
function codexMcpList(exe, flags, workspace, env, spawn) {
  const shown = `codex ${[...flags, "mcp", "list", "--json"].join(" ")}`;
  const r = spawn(exe, [...flags, "mcp", "list", "--json"], { cwd: workspace, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (r.error || r.status !== 0) {
    const why = r.error ? r.error.message : `exited ${r.status}${r.stderr?.trim() ? `: ${r.stderr.trim().split("\n").at(-1)}` : ""}`;
    throw new Error(`codex could not list its MCP servers (${shown} ${why}), so the job does not run`);
  }
  let listed;
  try { listed = JSON.parse(r.stdout || "[]"); } catch { throw new Error(`${shown} printed no JSON, so no MCP server could be switched off`); }
  if (listed && !Array.isArray(listed) && listed.servers) listed = listed.servers;
  if (!listed || typeof listed !== "object") throw new Error(`${shown} printed no list of MCP servers`);
  return Array.isArray(listed) ? listed.map((s) => ({ name: s?.name, enabled: s?.enabled }))
    : Object.entries(listed).map(([name, s]) => ({ name, enabled: s?.enabled }));
}

// The flags, before codex's subcommand, that leave a run in `workspace` no MCP
// server: the features above off, then each server still listed (those
// defined in a config.toml, the user's or the project's) switched off by name,
// since `-c mcp_servers={}` leaves them on (the finding on 71346e21). The
// flags are then checked against codex itself: listed with them, codex must
// load its configuration and show no server enabled. Any failure, or a name a
// -c key path cannot carry, stops the job rather than run it with a server on.
const MCP_NAME = /^[A-Za-z0-9_-]+$/;
export function codexNoMcpFlags(exe, workspace, env, spawn = spawnSync) {
  const configured = codexMcpList(exe, CODEX_FEATURES_OFF, workspace, env, spawn);
  for (const { name } of configured) {
    if (typeof name !== "string" || !MCP_NAME.test(name)) throw new Error(`the MCP server ${JSON.stringify(name)} cannot be switched off by name; rename it in codex's configuration`);
  }
  const flags = [...CODEX_FEATURES_OFF, ...configured.flatMap(({ name }) => ["-c", `mcp_servers.${name}.enabled=false`])];
  const left = codexMcpList(exe, flags, workspace, env, spawn).filter((s) => s.enabled !== false);
  if (left.length) throw new Error(`codex still has the MCP server${left.length > 1 ? "s" : ""} ${left.map((s) => s.name).join(", ")} enabled with every switch off, so the job does not run`);
  return flags;
}

// The default folder of the provider configs `atelier runner setup` writes,
// for the default runner config, runner.json (providersDir in runner-config.mjs).
export function defaultProvidersDir(env = process.env, home = env.HOME ?? "") {
  return join(env.ATELIER_CONFIG_DIR ?? join(home, ".config", "atelier"), "opencode", "runner.json");
}

// What the opencode adapter needs for one model, from the index setup wrote
// beside the configs: the provider, its model id, the config file, the key's
// credential store entry and its variable.
export function opencodeSetup(model, dir) {
  const index = join(dir, "models.json");
  if (!existsSync(index)) throw new Error(`no provider configs in ${dir}; run atelier runner setup`);
  const entry = JSON.parse(readFileSync(index, "utf8")).models?.[model];
  if (!entry) throw new Error(`${model} is not in ${index}; run atelier runner setup after adding it to the pool`);
  const claude = entry.provider === "openrouter-api" ? openRouterRefusal(entry.providerModel) : null;
  if (claude) throw new Error(`${model} is refused: ${claude}`);
  return { ...entry, config: join(dir, entry.config) };
}

// The variables through which opencode would read a config other than the
// generated one; none reaches it.
export const OPENCODE_CONFIG_VARS = ["OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT", "OPENCODE_PERMISSION"];

// The environment opencode runs with: the runner's (already filtered of every
// secret), the config, the gateway metadata escaped for the config's raw text,
// and the two secrets read from the credential store by name.
//
// The generated config is the only one. opencode merges OPENCODE_CONFIG with
// the global config ($XDG_CONFIG_HOME/opencode), the project's (opencode.json
// and .opencode in the workspace) and ~/.claude, so their MCP servers and
// permissions would reach the run (the finding on 84358a17). So project
// config and Claude Code's files are turned off, the variables that name more
// config are dropped, and runAdapter gives each run a folder of its own
// (runHome). opencode also reads ~/.opencode whatever
// OPENCODE_DISABLE_PROJECT_CONFIG says (the finding on 84644528), so the
// folder is HOME as well as every XDG folder.
export function opencodeEnv(env, setup, secret = (name) => readSecret(name, { env })) {
  const out = { ...env };
  for (const name of OPENCODE_CONFIG_VARS) delete out[name];
  Object.assign(out, {
    OPENCODE_CONFIG: setup.config, [METADATA_VAR]: metadataEscaped(env.CF_AIG_METADATA),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1",
  });
  if (setup.key) {
    const key = secret(setup.key);
    if (!key) throw new Error(`no key for ${setup.provider}: store it in the credential store as ${setup.key} (on macOS: security add-generic-password -U -T /usr/bin/security -s atelier.${setup.key} -a "$USER" -w)`);
    out[setup.keyVar] = key;
  }
  if (setup.gateway) {
    const token = secret(GATEWAY_TOKEN_KEY);
    if (!token) throw new Error(`no AI Gateway token: store it in the credential store as ${GATEWAY_TOKEN_KEY}`);
    out[GATEWAY_TOKEN_VAR] = token;
  }
  return out;
}

// The environment the credential store is read with: the adapter's, with the
// store the runner reads (--secret-store, --secrets-dir; defaultCommand in
// runner-config.mjs) named again, since the runner gives a harness no
// ATELIER_ variable. These reach the store alone, never opencode.
export function storeEnv(env, options = {}) {
  return {
    ...env,
    ...(options["secret-store"] ? { ATELIER_SECRET_STORE: options["secret-store"] } : {}),
    ...(options["secrets-dir"] ? { ATELIER_CONFIG_DIR: options["secrets-dir"] } : {}),
  };
}

// The variables that place an opencode run in `dir`, the run's own folder:
// HOME and each XDG folder a subfolder of it, so no config of the owner's
// (~/.opencode, ~/.config/opencode) is found and nothing opencode writes
// outlives the run. git, which the agent commits with, would lose the
// owner's identity with HOME, so it is given the owner's global git config
// by name, unless the runner already names one.
const XDG = { XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data", XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "state" };
export function runHome(env, dir) {
  const out = { HOME: join(dir, "home") };
  for (const [name, sub] of Object.entries(XDG)) out[name] = join(dir, sub);
  for (const path of Object.values(out)) mkdirSync(path);
  if (env.GIT_CONFIG_GLOBAL) return out;
  const home = env.HOME ?? "";
  const global = [join(home, ".gitconfig"), join(env.XDG_CONFIG_HOME || join(home, ".config"), "git", "config")].find((p) => home && existsSync(p));
  return global ? { ...out, GIT_CONFIG_GLOBAL: global } : out;
}

// Runs one job; returns the exit status. `io` replaces the process's own
// spawn, environment, output and secret reads in tests.
// The fresh empty folder a Codex review starts in, made under the system temp
// folder `tmp`. Codex's workspace-write sandbox also writes the system temp
// folder, so a clone at or inside it, or a scratch folder inside the clone
// (TMPDIR naming the clone), would be writable to the review: both refuse the
// review (t140, Astra on 9a9228b5). Real paths are compared.
function within(path, root) {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}
// Every folder the sandbox may write without being told: the system temp
// folder, $TMPDIR, and the fixed ones macOS and Linux share (Astra on
// f0fa13da: /tmp is writable though TMPDIR is /var/folders/.../T). Real paths;
// a folder that does not exist is skipped. `extra` adds roots (tests).
export const IMPLICIT_TEMP_ROOTS = ["/tmp", "/private/tmp", "/var/tmp"];
function tempRoots(tmp, env, extra) {
  const roots = new Set();
  for (const dir of [tmp, env.TMPDIR, ...IMPLICIT_TEMP_ROOTS, ...extra]) {
    if (!dir) continue;
    try { roots.add(realpathSync(dir)); } catch { /* not there: nothing to write */ }
  }
  return [...roots];
}
export function codexScratch(workspace, tmp, { env = process.env, extra = [] } = {}) {
  const clone = realpathSync(workspace), root = realpathSync(tmp);
  const hit = tempRoots(tmp, env, extra).find((r) => within(clone, r));
  if (hit) throw new Error(`the clone ${clone} is inside the temp folder ${hit}, which a Codex review may write, so the review does not run`);
  const scratch = mkdtempSync(join(root, "atelier-codex-review-"));
  if (within(realpathSync(scratch), clone)) {
    rmSync(scratch, { recursive: true, force: true });
    throw new Error(`the system temp folder ${root} is inside the clone ${clone}, so the review's scratch folder would be inside the clone, which it must not write; the review does not run`);
  }
  return scratch;
}

export function runAdapter(harness, argv, io = {}) {
  const env = io.env ?? process.env;
  const err = io.stderr ?? ((text) => process.stderr.write(text));
  const fail = (message) => { err(`atelier-${harness}: ${message}\n`); return 1; };
  let args;
  try { args = parseArgs(argv); } catch (error) { return fail(error.message); }
  const kind = jobKind(args);
  let childEnv = env, setup, runDir, scratchDir;
  try {
    if (harness === "opencode") {
      setup = opencodeSetup(args.model, args.options.providers ?? defaultProvidersDir(env));
      const secret = io.secret ?? ((name) => readSecret(name, { env: storeEnv(env, args.options) }));
      childEnv = opencodeEnv(env, setup, secret);
      // Outside the workspace, so nothing opencode leaves in it is committed.
      runDir = mkdtempSync(join(tmpdir(), "atelier-opencode-run-"));
      Object.assign(childEnv, runHome(env, runDir));
      const major = opencodeMajor(executableFor(harness, env), childEnv, io.spawn);
      // Fail closed: an opencode whose version cannot be read might be
      // opencode 2, which needs --standalone and the deny rule, and opencode 1
      // rejects both, so no run starts on a guess (the finding on t683).
      if (major === null) throw new Error(`could not read the version of ${executableFor(harness, env)} (\`--version\` failed or printed no version), so it is not known whether it needs --standalone and the external_directory deny; no run was started`);
      setup.major = major;
      // opencode 2 gets the deny at every run, over whatever config was stored.
      if (major >= 2) childEnv.OPENCODE_CONFIG_CONTENT = OPENCODE2_CONFIG_CONTENT;
    }
    if (harness === "codex") {
      // A review starts in its scratch folder, so the MCP servers are
      // discovered and checked from there: from the clone, a project-only
      // server would get a switch-off override into a run that never sees it.
      if (kind === "review") scratchDir = codexScratch(args.workspace, io.tmp ?? tmpdir(), { env, extra: io.tempRoots });
      setup = { noMcp: codexNoMcpFlags(executableFor(harness, env), scratchDir ?? args.workspace, childEnv, io.spawn) };
      if (scratchDir) setup.scratch = scratchDir;
    }
  } catch (error) {
    if (runDir) rmSync(runDir, { recursive: true, force: true });
    if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
    return fail(error.message);
  }
  try {
    return runHarness(harness, args, kind, setup, childEnv, io, fail);
  } finally {
    if (runDir) rmSync(runDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    if (scratchDir) rmSync(scratchDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
}

function runHarness(harness, args, kind, setup, childEnv, io, fail) {
  const env = io.env ?? process.env;
  const spawn = io.spawn ?? spawnSync;
  const { argv: harnessArgv, verdictFrom } = HARNESSES[harness].command(args, kind, setup);
  let prompt, brief = "";
  try {
    prompt = promptFor(harness, args);
    if (kind === "review") brief = readFileSync(args.brief, "utf8");
  } catch (error) { return fail(`could not read the brief or diff: ${error.message}`); }
  const exe = executableFor(harness, env);
  const capture = kind === "review" && verdictFrom !== "file";
  const options = {
    cwd: setup?.scratch ?? args.workspace, env: childEnv, input: prompt, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    stdio: ["pipe", capture ? "pipe" : "inherit", "inherit"],
  };
  const limit = harness === "opencode" && kind === "build" ? RUN_LIMITS[setup.providerModel] : null;
  const err = io.stderr ?? ((text) => process.stderr.write(text));
  const result = limit ? runLimited(spawn, exe, harnessArgv, options, { ms: io.limitMs ?? limit.ms, err, harness }) : spawn(exe, harnessArgv, options);
  if (result.error) return fail(result.error.code === "ETIMEDOUT" && limit ? `${exe} was stopped after its time limit of ${Math.round((io.limitMs ?? limit.ms) / 1000)} s` : `could not run ${exe}: ${result.error.message}`);
  if (result.status !== 0) return result.status ?? 1;
  if (!capture) return 0;
  let answer = result.stdout ?? "";
  if (verdictFrom === "agy-json") {
    try { answer = JSON.parse(answer.trim()).response; } catch { return fail(`${exe} printed no JSON`); }
  }
  if (typeof answer !== "string" || !answer.trim()) return fail(`${exe} gave an empty answer`);
  // A reply with no verdict at all is asked once more, in the same session,
  // for the verdict lines alone (t576); the kept reply is both answers, so
  // findings the first gave as lines still count. Any failure of the second
  // ask leaves the first reply, which the runner records as unparsable.
  const followUp = isVerification(brief) ? null : HARNESSES[harness].followUp;
  if (followUp && noVerdict(answer)) {
    const again = spawn(exe, followUp(args, kind, setup), {
      cwd: args.workspace, env: childEnv, input: verdictFollowUp(criteriaAsked(brief)), encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
      stdio: ["pipe", "pipe", "inherit"],
    });
    const more = !again.error && again.status === 0 && typeof again.stdout === "string" ? again.stdout.trim() : "";
    if (more) answer = `${answer.replace(/\n+$/, "")}\n\n${more}\n`;
    else (io.stderr ?? ((text) => process.stderr.write(text)))(`atelier-${harness}: the reply states no verdict and asking again for it failed${again.error ? `: ${again.error.message}` : ` (exit ${again.status})`}\n`);
  }
  writeFileSync(args.verdict, answer, "utf8");
  return 0;
}

// A run with a time limit (RUN_LIMITS). It is run once more when it ends with
// no new commit and a transport error: the limit passing, or its exit non-zero
// with a TRANSPORT_ERROR line on stderr. Each attempt runs in its own process
// group, and the whole group is ended and confirmed gone before anything else
// happens, so a shell or test the first attempt started cannot run on into the
// second in the same workspace. The stderr is read from what the spawn returns
// (the shipped spawn, limitSpawn, captures it on a pipe) or, when the spawn
// leaves it to the file given here, from that file, and passed on.
function runLimited(spawn, exe, argv, options, { ms, err, harness }) {
  const head = () => String(spawn("git", ["rev-parse", "HEAD"], { cwd: options.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).stdout ?? "").trim();
  for (let attempt = 1; ; attempt++) {
    const before = head();
    const dir = mkdtempSync(join(tmpdir(), "atelier-opencode-stderr-"));
    const log = join(dir, "stderr"), fd = openSync(log, "w");
    let result, filed = "";
    try {
      result = spawn(exe, argv, { ...options, detached: true, timeout: ms, killSignal: "SIGKILL", stdio: [options.stdio[0], options.stdio[1], fd] });
    } finally {
      closeSync(fd);
      try { filed = readFileSync(log, "utf8"); } catch { /* nothing was written */ }
      rmSync(dir, { recursive: true, force: true });
    }
    if (filed) err(filed);
    const text = filed || String(result.stderr ?? "");
    const survivors = endGroup(result.pid);
    if (survivors) {
      err(`atelier-${harness}: processes the run started would not end; not running it again\n`);
      return { ...result, error: result.error ?? new Error("processes the run started would not end") };
    }
    const transport = result.error?.code === "ETIMEDOUT" || (result.status !== 0 && TRANSPORT_ERROR.test(text));
    if (attempt === 2 || !transport || head() !== before) return result;
    err(`atelier-${harness}: the run ended with no commit and a transport error (${result.error?.code === "ETIMEDOUT" ? "time limit" : "stderr"}); running it once more\n`);
  }
}

// Ends every process left in the group led by pid (the run's own pid, which
// detached made a group leader) and waits up to 5 s for them to be gone.
// Returns true when some remain.
function endGroup(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  const alive = () => { try { process.kill(-pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };
  for (let waited = 0; alive() && waited <= 5000; waited += 50) {
    try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return alive();
}

function noVerdict(answer) {
  const parsed = parseVerdict(answer);
  return !parsed.ok && parsed.error === NO_VERDICT;
}
