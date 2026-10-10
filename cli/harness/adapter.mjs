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

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { readSecret } from "../credentials.mjs";
import { GATEWAY_TOKEN_KEY, GATEWAY_TOKEN_VAR, METADATA_VAR, metadataEscaped } from "./providers.mjs";

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

export function reviewPrompt(brief, diff) {
  const fence = fenceFor(diff);
  return [
    brief.replace(/\n+$/, ""),
    "",
    "The change under review:",
    `${fence}diff`,
    diff.replace(/\n+$/, ""),
    fence,
    "",
    "In the current folder you may read files and run the project's tests. Edit nothing, do not push and run no atelier command; verify a blocking finding before you state it. End with a VERDICT: APPROVE or VERDICT: REJECT line, a SUMMARY: line and one FINDING: blocking|follow-up PATH:LINE text line per finding.",
  ].join("\n");
}

// The prompt for the job, which goes to the harness on standard input.
export function promptFor(harness, args, read = (f) => readFileSync(f, "utf8")) {
  const brief = read(args.brief);
  if (jobKind(args) === "review") return reviewPrompt(brief, args.diff ? read(args.diff) : "");
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
export const AGY_MODELS = { "gemini-3.1-pro": "gemini-3.1-pro-high", "gpt-oss-120b": "gpt-oss-120b-medium" };

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
    command(args, kind) {
      const common = ["exec", "--model", args.model, "--skip-git-repo-check", "--cd", args.workspace, "-c", "mcp_servers={}"];
      if (kind === "review") return { argv: [...common, "--sandbox", "read-only", "--output-last-message", args.verdict, "-"], verdictFrom: "file" };
      // Its workspace-write sandbox keeps .git read-only unless it is named
      // a writable root, and a build has to commit.
      return { argv: [...common, "--sandbox", "workspace-write", "-c", `sandbox_workspace_write.writable_roots=${JSON.stringify([join(args.workspace, ".git")])}`, "-"], verdictFrom: "stdout" };
    },
  },
  opencode: {
    executable: "opencode",
    command(args, kind, setup) {
      return { argv: ["run", "--model", `${setup.provider}/${setup.providerModel}`], verdictFrom: "stdout" };
    },
  },
  antigravity: {
    executable: "agy",
    command(args) {
      return { argv: ["--model", AGY_MODELS[args.model] ?? args.model, "--dangerously-skip-permissions", "--sandbox", "--output-format", "json", "--print-timeout", "2400s"], verdictFrom: "agy-json" };
    },
  },
};

// The executable for a harness: its name on the PATH, or the variable that
// names a stand-in (ATELIER_CLAUDE, ATELIER_CODEX, ATELIER_OPENCODE,
// ATELIER_AGY), which tests use. A runner never passes an ATELIER_ variable to
// a harness, so a runner's adapter always runs the real one.
const OVERRIDE = { "claude-code": "ATELIER_CLAUDE", codex: "ATELIER_CODEX", opencode: "ATELIER_OPENCODE", antigravity: "ATELIER_AGY" };
export function executableFor(harness, env = process.env) {
  return env[OVERRIDE[harness]] || HARNESSES[harness].executable;
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
export function runAdapter(harness, argv, io = {}) {
  const env = io.env ?? process.env;
  const err = io.stderr ?? ((text) => process.stderr.write(text));
  const fail = (message) => { err(`atelier-${harness}: ${message}\n`); return 1; };
  let args;
  try { args = parseArgs(argv); } catch (error) { return fail(error.message); }
  const kind = jobKind(args);
  let childEnv = env, setup, runDir;
  try {
    if (harness === "opencode") {
      setup = opencodeSetup(args.model, args.options.providers ?? defaultProvidersDir(env));
      const secret = io.secret ?? ((name) => readSecret(name, { env: storeEnv(env, args.options) }));
      childEnv = opencodeEnv(env, setup, secret);
      // Outside the workspace, so nothing opencode leaves in it is committed.
      runDir = mkdtempSync(join(tmpdir(), "atelier-opencode-run-"));
      Object.assign(childEnv, runHome(env, runDir));
    }
  } catch (error) {
    if (runDir) rmSync(runDir, { recursive: true, force: true });
    return fail(error.message);
  }
  try {
    return runHarness(harness, args, kind, setup, childEnv, io, fail);
  } finally {
    if (runDir) rmSync(runDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
}

function runHarness(harness, args, kind, setup, childEnv, io, fail) {
  const env = io.env ?? process.env;
  const spawn = io.spawn ?? spawnSync;
  const { argv: harnessArgv, verdictFrom } = HARNESSES[harness].command(args, kind, setup);
  let prompt;
  try { prompt = promptFor(harness, args); } catch (error) { return fail(`could not read the brief or diff: ${error.message}`); }
  const exe = executableFor(harness, env);
  const capture = kind === "review" && verdictFrom !== "file";
  const result = spawn(exe, harnessArgv, {
    cwd: args.workspace, env: childEnv, input: prompt, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    stdio: ["pipe", capture ? "pipe" : "inherit", "inherit"],
  });
  if (result.error) return fail(`could not run ${exe}: ${result.error.message}`);
  if (result.status !== 0) return result.status ?? 1;
  if (!capture) return 0;
  let answer = result.stdout ?? "";
  if (verdictFrom === "agy-json") {
    try { answer = JSON.parse(answer.trim()).response; } catch { return fail(`${exe} printed no JSON`); }
  }
  if (typeof answer !== "string" || !answer.trim()) return fail(`${exe} gave an empty answer`);
  writeFileSync(args.verdict, answer, "utf8");
  return 0;
}
