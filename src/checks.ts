import { RuleError, type ProjectPolicy } from "./rules.ts";

// What a registered check may do. Atelier runs a check in a clean clone of an
// item's head, on an agent's machine or in a Cloudflare container, whenever
// anyone asks, so a check must be read-only: it reads the project and writes
// only in its clone, the caller's caches and temporary files. It builds,
// tests and inspects, and changes nothing anyone else sees. A command that
// deploys, installs onto a device or this machine, publishes, pushes, reaches
// another machine or spends money is never read-only, whatever anyone
// declares, and Atelier refuses to register or run it.
//
// A check is read-only by one of three things: its command is a known build
// or test form, read here word by word (knownReadOnly); the project's
// ControlPlane adapter lists the command as a capability of class
// local-read-only or local-write; or the project owner declares it, with the
// reason, as init records its approval. A check registered before checks had
// classes has none recorded: it is read-only when its command is a known form
// and undeclared otherwise. An undeclared check still runs, so a project's
// existing checks keep working, and the next init that names it must declare it.

export type CheckClass = "read-only" | "undeclared" | "refused";

// How a check is known to be read-only, as recorded on the project.
//   command  its command is a known build or test form
//   adapter  the ControlPlane adapter lists it as a read-only capability; the note says which
//   owner    the project owner declared it; the note is the owner's reason
export interface CheckDeclaration {
  command: string;
  by: "command" | "adapter" | "owner";
  note?: string;
}

export interface CheckClassView {
  command: string;
  class: CheckClass;
  by?: CheckDeclaration["by"];
  note?: string;
  refusal?: string;
}

export const DECLARATION_MAX = 500;

// ── a command line as the commands it runs ─────────────────────────────────

// The simple commands a shell command line runs, each as its words with the
// quoting removed: `a && b | c; d` gives a, b, c and d, and a command inside
// $( ), backticks or <( ) is one more. Redirections and their targets are
// dropped. What a variable or a substitution expands to is not known, so it
// stays as written. Null when the line cannot be read this way: an unclosed
// quote or parenthesis, a here-document, or a substitution inside ${ }.
export function simpleCommands(line: string): string[][] | null {
  const out: string[][] = [];
  return scan(line, out, 0) ? out : null;
}

// The index of the parenthesis that closes the one at `open`, past quotes,
// escapes and nested parentheses; -1 when there is none.
function closing(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") { i++; continue; }
    if (c === "'") { const end = src.indexOf("'", i + 1); if (end === -1) return -1; i = end; continue; }
    if (c === '"') {
      let j = i + 1;
      for (; j < src.length && src[j] !== '"'; j++) if (src[j] === "\\") j++;
      if (j >= src.length) return -1;
      i = j;
      continue;
    }
    if (c === "`") { const end = backtick(src, i); if (end === -1) return -1; i = end; continue; }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return -1;
}

function backtick(src: string, open: number): number {
  for (let i = open + 1; i < src.length; i++) {
    if (src[i] === "\\") { i++; continue; }
    if (src[i] === "`") return i;
  }
  return -1;
}

function braceEnd(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") { i++; continue; }
    if (c === "'") { const end = src.indexOf("'", i + 1); if (end === -1) return -1; i = end; continue; }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

function scan(src: string, out: string[][], depth: number): boolean {
  if (depth > 8) return false;
  let words: string[] = [], word = "", started = false, target = false;
  const endWord = () => {
    if (started) { if (target) target = false; else words.push(word); }
    word = "";
    started = false;
  };
  const endCommand = () => {
    endWord();
    target = false;
    if (words.length) out.push(words);
    words = [];
  };
  // A $( ), $(( )), ${ } or backtick at i, read into the word; the command
  // inside a substitution is read as one more. Returns the index it ends at,
  // or -1 when it cannot be read.
  const dollar = (i: number): number => {
    if (src[i + 1] === "(") {
      const end = closing(src, i + 1);
      if (end === -1) return -1;
      if (src[i + 2] !== "(" && !scan(src.slice(i + 2, end), out, depth + 1)) return -1;
      word += src.slice(i, end + 1);
      return end;
    }
    if (src[i + 1] === "{") {
      const end = braceEnd(src, i + 1);
      if (end === -1 || /\$\(|`/.test(src.slice(i, end))) return -1;
      word += src.slice(i, end + 1);
      return end;
    }
    word += "$";
    return i;
  };
  const tick = (i: number): number => {
    const end = backtick(src, i);
    if (end === -1 || !scan(src.slice(i + 1, end).replace(/\\([$`\\])/g, "$1"), out, depth + 1)) return -1;
    word += src.slice(i, end + 1);
    return end;
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      if (src[i + 1] === "\n") { i++; continue; }
      word += i + 1 < src.length ? src[++i] : "\\";
      started = true;
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end === -1) return false;
      word += src.slice(i + 1, end);
      started = true;
      i = end;
      continue;
    }
    if (c === "$" && src[i + 1] === "'") {
      let j = i + 2;
      for (; j < src.length && src[j] !== "'"; j++) {
        if (src[j] === "\\" && j + 1 < src.length) j++;
        word += src[j];
      }
      if (j >= src.length) return false;
      started = true;
      i = j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      for (; j < src.length && src[j] !== '"'; j++) {
        const d = src[j];
        if (d === "\\" && j + 1 < src.length && '$`"\\\n'.includes(src[j + 1])) {
          if (src[j + 1] !== "\n") word += src[j + 1];
          j++;
        } else if (d === "$") {
          j = dollar(j);
          if (j === -1) return false;
        } else if (d === "`") {
          j = tick(j);
          if (j === -1) return false;
        } else word += d;
      }
      if (j >= src.length) return false;
      started = true;
      i = j;
      continue;
    }
    if (c === "$") {
      i = dollar(i);
      if (i === -1) return false;
      started = true;
      continue;
    }
    if (c === "`") {
      i = tick(i);
      if (i === -1) return false;
      started = true;
      continue;
    }
    if ((c === "<" || c === ">") && src[i + 1] === "(") {
      const end = closing(src, i + 1);
      if (end === -1 || !scan(src.slice(i + 2, end), out, depth + 1)) return false;
      word += src.slice(i, end + 1);
      started = true;
      i = end;
      continue;
    }
    if (c === "<" || c === ">") {
      if (src.startsWith("<<", i) && !src.startsWith("<<<", i)) return false;
      // A file descriptor written against the operator, as in 2>&1, is part of it.
      if (started && /^\d+$/.test(word) && !target) { word = ""; started = false; }
      else endWord();
      let j = i + 1;
      while (j < src.length && "<>&|".includes(src[j])) j++;
      i = j - 1;
      target = true;
      continue;
    }
    if (c === "&") {
      if (src[i + 1] === ">") {
        endWord();
        let j = i + 2;
        while (src[j] === ">") j++;
        i = j - 1;
        target = true;
        continue;
      }
      endCommand();
      if (src[i + 1] === "&") i++;
      continue;
    }
    if (c === "|") {
      endCommand();
      if (src[i + 1] === "|" || src[i + 1] === "&") i++;
      continue;
    }
    if (c === ";" || c === "\n" || c === "(" || c === ")") {
      endCommand();
      if (c === ";" && (src[i + 1] === ";" || src[i + 1] === "&")) i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") { endWord(); continue; }
    if (c === "#" && !started) {
      const nl = src.indexOf("\n", i);
      if (nl === -1) break;
      i = nl - 1;
      continue;
    }
    word += c;
    started = true;
  }
  endCommand();
  return true;
}

// ── what one command does ──────────────────────────────────────────────────

interface Verdict { refusal: string | null; known: boolean }
const OK: Verdict = { refusal: null, known: true };
const UNKNOWN: Verdict = { refusal: null, known: false };
const refuse = (why: string, words: string[]): Verdict => ({ refusal: `${why} (${words.join(" ")})`, known: false });

function combine(verdicts: Verdict[]): Verdict {
  return { refusal: verdicts.find((v) => v.refusal)?.refusal ?? null, known: verdicts.every((v) => v.known) };
}

const KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "esac", "!", "{", "}"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

// The tool a word names: its file name without the directory, and for a
// package an npx-style runner fetches, without the version.
function toolName(word: string): string {
  const base = word.startsWith("@") ? (word.split("/")[1] ?? word) : word.slice(word.lastIndexOf("/") + 1);
  return base.replace(/@[^@]*$/, (v) => (v === base ? v : "")).toLowerCase().replace(/^(python|pip)\d+(\.\d+)*$/, "$1");
}

// A tool named by a path counts as that tool only where tools live: a
// package's node_modules/.bin, a virtual environment's bin, or an absolute
// or home path, and the Gradle and Maven wrappers, which a project keeps at
// its root. A project's own script named like a tool is not that tool. A
// scoped package name (@scope/tool) is not a path.
function toolPath(word: string): boolean {
  if (!word.includes("/") || word.startsWith("@") || ["./gradlew", "./mvnw"].includes(word)) return true;
  const dir = word.slice(0, word.lastIndexOf("/"));
  return /(^|\/)(node_modules\/\.bin|\.?venv\/bin|env\/bin)$/.test(dir) || /^(\/|~|\$HOME|\$\{HOME\})/.test(dir);
}

// The words that are not options, past the values of the options in `takes`.
function positionals(args: string[], takes: string[] = []): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { out.push(...args.slice(i + 1)); break; }
    if (a.startsWith("-") && a !== "-") { if (takes.includes(a)) i++; continue; }
    out.push(a);
  }
  return out;
}

// Skips options at the front, and the values of those in `takes`; returns the rest.
function afterOptions(args: string[], takes: string[] = []): string[] {
  let i = 0;
  while (i < args.length && args[i].startsWith("-") && args[i] !== "-") {
    if (args[i] === "--") return args.slice(i + 1);
    i += takes.includes(args[i]) ? 2 : 1;
  }
  return args.slice(i);
}

const has = (args: string[], ...words: string[]) => args.some((a) => words.includes(a) || words.some((w) => w.startsWith("--") && a.startsWith(`${w}=`)));

// Package scripts whose name says what they do. A script is a build or test
// when its name, or its first part before a colon, is one of these. One whose
// name ends in a part that deploys or publishes is refused, as `npm run
// deploy` and `db:push` are, and so is one that starts with such a part
// unless it ends in a build or test word, as `release:check` does; so is a
// migration of a remote or production database.
const SCRIPT_WORDS = new Set(["test", "tests", "check", "checks", "build", "lint", "typecheck", "type-check", "types", "tsc", "verify", "validate", "compile", "ci", "e2e", "coverage", "cov", "spec", "unit", "integration", "format", "fmt", "prettier", "eslint", "stylelint", "audit", "smoke", "bench", "benchmark"]);
const SCRIPT_ACTS = new Set(["deploy", "publish", "release", "ship", "upload", "push", "promote"]);
function scriptRefusal(script: string): string | null {
  const parts = script.toLowerCase().split(/[:_.\-/]/);
  const [first, last] = [parts[0], parts[parts.length - 1]];
  if (SCRIPT_ACTS.has(last) || (SCRIPT_ACTS.has(first) && !SCRIPT_WORDS.has(last))) return "runs a script whose name says it deploys or publishes";
  if (parts.some((p) => /^migrat/.test(p)) && parts.some((p) => ["remote", "prod", "production"].includes(p))) return "runs a script whose name says it changes a remote database";
  return null;
}
const knownScript = (script: string | undefined) => !!script && SCRIPT_WORDS.has(script.toLowerCase().split(":")[0]);

const NPM_TAKES = ["--prefix", "-C", "--dir", "--workspace", "-w", "--filter", "-F", "--cwd", "--loglevel", "--registry", "--userconfig", "--cache"];
const GIT_TAKES = ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--exec-path"];
const WRANGLER_TAKES = ["--config", "-c", "--env", "-e", "--cwd", "--env-file", "--name", "--outdir", "--compatibility-date"];
const READ_GIT = new Set(["diff", "status", "log", "show", "ls-files", "ls-tree", "rev-parse", "rev-list", "cat-file", "describe", "grep", "check-ignore", "check-attr", "merge-base", "blame", "shortlog", "diff-tree", "diff-index", "diff-files", "for-each-ref", "name-rev", "count-objects", "fsck", "verify-commit", "verify-tag", "show-ref", "whatchanged", "var", "version", "help", "--version"]);
const UTILITIES = new Set([":", "true", "false", "cd", "pushd", "popd", "set", "unset", "shift", "test", "[", "[[", "echo", "printf", "exit", "return", "wait", "export", "local", "readonly", "declare", "typeset", "shopt", "ls", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "diff", "cmp", "comm", "sort", "uniq", "tr", "cut", "paste", "column", "fold", "nl", "jq", "shasum", "sha1sum", "sha256sum", "sha512sum", "md5", "md5sum", "cksum", "which", "whereis", "type", "pwd", "basename", "dirname", "realpath", "readlink", "sleep", "date", "uname", "whoami", "file", "stat", "du", "df", "printenv", "mktemp", "mkdir", "touch", "tee", "expr", "seq", "xxd", "od", "hexdump", "strings", "xmllint", "sw_vers"]);
// Tools whose every use is a build, a test or a lint.
const BUILD_TOOLS = new Set(["tsc", "vitest", "jest", "mocha", "ava", "tap", "eslint", "prettier", "stylelint", "oxlint", "knip", "publint", "attw", "svelte-check", "vue-tsc", "esbuild", "tsup", "rollup", "pytest", "py.test", "mypy", "ruff", "black", "flake8", "pylint", "pyright", "isort", "bandit", "pycodestyle", "pydocstyle", "tox", "swiftlint", "swift-format", "xcodegen", "shellcheck", "shfmt", "markdownlint", "markdownlint-cli2", "codespell", "actionlint", "hadolint", "yamllint", "typos", "cspell", "editorconfig-checker", "vale", "rspec", "rubocop", "gofmt", "staticcheck", "govulncheck", "ctest", "golangci-lint"]);
// Tools that are builds or tests with one of these first words.
const BUILD_SUBCOMMANDS: Record<string, string[]> = {
  playwright: ["test"], cypress: ["run"], biome: ["check", "lint", "ci", "format"], astro: ["check", "build", "sync"],
  vite: ["build"], next: ["build", "lint"], nuxt: ["build", "typecheck"], nuxi: ["build", "typecheck"], "svelte-kit": ["sync"],
  webpack: ["build"], rspack: ["build"], parcel: ["build"], deno: ["test", "check", "lint", "fmt", "bench"],
  swift: ["build", "test", "package"], tuist: ["generate", "build", "test"],
  cargo: ["build", "test", "check", "clippy", "fmt", "doc", "bench", "nextest", "metadata", "tree", "audit", "deny", "llvm-cov"],
  go: ["build", "test", "vet", "fmt", "list", "mod", "version", "env"], dotnet: ["build", "test", "restore", "format"],
  bazel: ["build", "test", "query"], bazelisk: ["build", "test", "query"], rake: ["test", "spec"],
  uv: ["sync", "lock", "build"], poetry: ["install", "check", "lock", "build"], bundle: ["install", "check"],
  coverage: ["run", "report", "xml", "html", "json", "erase", "combine"], simctl: ["list"], plutil: ["-lint", "-p", "-help"],
  wrangler: ["types", "--version", "-v"], docker: ["build"], pip: ["check", "list", "freeze", "show", "--version"],
};
const PY_MODULES = new Set(["pytest", "unittest", "py_compile", "compileall", "mypy", "ruff", "black", "flake8", "pylint", "pyflakes", "pyright", "doctest", "tox", "coverage", "isort", "pycodestyle", "pydocstyle", "bandit", "venv", "build", "json.tool", "tabnanny"]);
const PAID_MODELS = new Set(["claude", "codex", "gemini", "aider", "cursor-agent", "amp", "opencode", "qwen", "goose", "crush", "droid", "llm", "openai", "anthropic"]);

// GitHub CLI subcommands that write to GitHub.
const GH_WRITES: Record<string, string[]> = {
  release: ["create", "upload", "edit", "delete", "delete-asset"],
  pr: ["create", "merge", "close", "reopen", "comment", "edit", "review", "ready", "lock", "unlock"],
  issue: ["create", "comment", "close", "reopen", "edit", "delete", "transfer", "lock", "unlock", "pin", "unpin", "develop"],
  repo: ["create", "delete", "edit", "fork", "rename", "archive", "unarchive", "sync", "deploy-key"],
  workflow: ["run", "enable", "disable"], run: ["rerun", "cancel", "delete"], secret: ["set", "delete"], variable: ["set", "delete"],
  gist: ["create", "edit", "delete"], label: ["create", "edit", "delete", "clone"], cache: ["delete"], auth: ["login", "logout", "refresh", "setup-git"],
};

// Why a command, with its tool's name and arguments, is never read-only; null when it is not one of these.
function refusalFor(name: string, args: string[], words: string[]): Verdict | null {
  const dry = has(args, "--dry-run", "--dryrun");
  const pos = positionals(args);
  const [first, second] = pos;
  switch (name) {
    case "wrangler": {
      const [sub, next] = positionals(args, WRANGLER_TAKES);
      if (["deploy", "publish"].includes(sub)) return dry ? null : refuse("deploys", words);
      if (sub === "versions" && next === "deploy") return refuse("deploys", words);
      if (sub === "versions" && next === "upload") return dry ? null : refuse("deploys", words);
      if (sub === "pages" && ["deploy", "publish"].includes(next)) return refuse("deploys", words);
      if (sub === "triggers" && next === "deploy") return refuse("deploys", words);
      if (["rollback", "delete"].includes(sub)) return refuse("changes a deployed Worker", words);
      if (["secret", "secrets-store"].includes(sub) && ["put", "delete", "bulk", "create", "update"].includes(next)) return refuse("changes a deployed Worker's secrets", words);
      if (["d1", "kv", "kv:key", "kv:namespace", "kv:bulk", "r2", "queues", "vectorize", "hyperdrive", "workflows", "pipelines"].includes(sub)
        && (has(args, "--remote") || (!has(args, "--local") && args.some((a) => ["put", "delete", "create", "update", "bulk", "apply", "execute", "purge", "import"].includes(a))))) {
        return refuse("changes Cloudflare resources", words);
      }
      return null;
    }
    case "vercel":
      if (has(args, "--version", "-v", "--help", "-h")) return null;
      return ["build", "dev", "pull", "inspect", "ls", "list", "logs", "whoami", "help"].includes(first) ? null : refuse("deploys", words);
    case "netlify":
      return ["deploy", "sites:create", "sites:delete", "env:set", "env:unset", "env:import"].includes(first) ? refuse("deploys", words) : null;
    case "firebase":
      return ["deploy", "hosting:channel:deploy", "functions:delete", "database:set", "database:push", "database:update", "database:remove", "firestore:delete", "appdistribution:distribute"].includes(first) ? refuse("deploys", words) : null;
    case "fly": case "flyctl":
      if (["deploy", "launch", "destroy"].includes(first) || (first === "secrets" && ["set", "unset", "import"].includes(second))) return refuse("deploys", words);
      return null;
    case "gh-pages": case "surge": case "semantic-release":
      return refuse(name === "semantic-release" ? "publishes a release" : "deploys", words);
    case "npm": case "pnpm": case "yarn": case "bun": {
      const [sub, next] = positionals(args, NPM_TAKES);
      if (sub === "publish" || (name === "yarn" && sub === "npm" && next === "publish")) return dry ? null : refuse("publishes a package", words);
      if (name === "npm" && ["unpublish", "deprecate", "dist-tag", "owner", "access", "team", "org", "token", "login", "adduser", "logout", "star", "unstar", "hook", "profile"].includes(sub)) return refuse("changes the npm registry or its credentials", words);
      if (["link", "ln"].includes(sub) || (name === "yarn" && sub === "global")) return refuse("installs onto this machine", words);
      if (["install", "i", "in", "add", "update", "up", "upgrade", "remove", "rm", "uninstall", "un"].includes(sub) && has(args, "-g", "--global", "--location")) return refuse("installs onto this machine", words);
      const script = ["run", "run-script", "rum", "urn"].includes(sub) ? next : name !== "npm" ? sub : undefined;
      const why = script ? scriptRefusal(script) : null;
      return why ? refuse(why, words) : null;
    }
    case "git": {
      const [sub, next] = positionals(args, GIT_TAKES);
      if (["push", "send-email", "send-pack"].includes(sub) || (sub === "lfs" && next === "push") || (sub === "svn" && next === "dcommit")) return refuse("pushes", words);
      return null;
    }
    case "gh": {
      if (first === "api") {
        const method = args.find((a, i) => /^-X.+/.test(a) || /^--method=/.test(a) || ((args[i - 1] === "-X" || args[i - 1] === "--method") && !a.startsWith("-")));
        const verb = method?.replace(/^-X|^--method=/, "").toUpperCase();
        if ((verb && !["GET", "HEAD"].includes(verb)) || has(args, "-f", "-F", "--field", "--raw-field", "--input")) return refuse("sends a write request to GitHub", words);
        return null;
      }
      return GH_WRITES[first]?.includes(second) ? refuse("writes to GitHub", words) : null;
    }
    case "docker": case "podman":
      if (["push", "login"].includes(first) || has(args, "--push")) return refuse(first === "login" ? "signs in to a registry" : "pushes an image", words);
      return null;
    case "altool": case "notarytool": case "itmstransporter": case "transporter":
      return refuse("contacts Apple with the developer account to upload or notarise", words);
    case "devicectl":
      return args.some((a) => ["install", "uninstall"].includes(a)) ? refuse("installs on a device", words) : null;
    case "ios-deploy": case "ideviceinstaller":
      return refuse("installs on a device", words);
    case "adb":
      return ["install", "install-multiple", "uninstall", "push"].includes(first) ? refuse("installs on a device", words) : null;
    case "cfgutil":
      return args.includes("install-app") ? refuse("installs on a device", words) : null;
    case "xcodebuild":
      return has(args, "-allowProvisioningUpdates", "-allowProvisioningDeviceRegistration") ? refuse("changes the Apple developer account's provisioning", words) : null;
    case "fastlane":
      return refuse("runs a fastlane lane, which signs, uploads or releases", words);
    case "ssh": case "scp": case "sftp": case "mosh": case "rsh": case "telnet":
      return refuse("reaches another machine", words);
    case "rsync":
      return pos.some((a) => /^[^/]*[^/\\]:/.test(a) || a.startsWith("rsync://")) || has(args, "-e", "--rsh") ? refuse("copies to or from another machine", words) : null;
    case "curl": {
      const method = args.find((a, i) => /^-X.+/.test(a) || /^--request=/.test(a) || ((args[i - 1] === "-X" || args[i - 1] === "--request") && !a.startsWith("-")));
      const verb = method?.replace(/^-X|^--request=/, "").toUpperCase();
      const data = args.some((a) => /^--(data|data-raw|data-binary|data-urlencode|data-ascii|json|form|form-string|upload-file)(=|$)/.test(a) || /^-[a-zA-Z]*[dFT]/.test(a));
      return (verb && !["GET", "HEAD", "OPTIONS"].includes(verb)) || data ? refuse("sends a write request", words) : null;
    }
    case "wget": {
      const verb = args.find((a) => a.startsWith("--method="))?.slice(9).toUpperCase();
      return (verb && !["GET", "HEAD", "OPTIONS"].includes(verb)) || args.some((a) => /^--(post|body)-(data|file)(=|$)/.test(a)) ? refuse("sends a write request", words) : null;
    }
    case "http": case "https": case "xh":
      return ["POST", "PUT", "PATCH", "DELETE"].includes((first ?? "").toUpperCase()) ? refuse("sends a write request", words) : null;
    case "terraform": case "tofu":
      return ["apply", "destroy", "import", "taint", "untaint", "force-unlock"].includes(first) || (first === "state" && ["rm", "mv", "push", "replace-provider"].includes(second)) ? refuse("changes infrastructure", words) : null;
    case "pulumi":
      return ["up", "update", "destroy", "refresh", "import"].includes(first) ? refuse("changes infrastructure", words) : null;
    case "cdk": case "sam": case "serverless": case "sls":
      return ["deploy", "destroy", "bootstrap", "delete", "sync", "publish", "remove"].includes(first) ? refuse("deploys", words) : null;
    case "kubectl": case "oc":
      return ["apply", "create", "delete", "replace", "patch", "scale", "rollout", "set", "edit", "label", "annotate", "expose", "run", "cordon", "drain", "taint", "autoscale"].includes(first) ? refuse("changes a cluster", words) : null;
    case "helm":
      return ["install", "upgrade", "uninstall", "delete", "rollback", "push"].includes(first) ? refuse("changes a cluster", words) : null;
    case "aws":
      return pos.some((a) => a === "deploy" || /^(put|create|delete|update|publish|run|start|stop|terminate|invoke|send|upload|attach|detach|modify|register|deregister|tag|untag|reboot|restore|execute|import|copy)-/.test(a))
        || (first === "s3" && ["cp", "mv", "rm", "sync", "mb", "rb", "website"].includes(second)) ? refuse("changes cloud resources", words) : null;
    case "gcloud": case "az":
      return pos.some((a) => ["deploy", "create", "delete", "update", "ssh", "add-iam-policy-binding", "remove-iam-policy-binding"].includes(a)) ? refuse("changes cloud resources", words) : null;
    case "gsutil":
      return ["cp", "mv", "rm", "rsync", "mb", "rb", "setmeta", "acl"].includes(first) ? refuse("changes cloud storage", words) : null;
    case "cargo":
      if (first === "publish") return dry ? null : refuse("publishes a crate", words);
      if (["yank", "owner", "login"].includes(first)) return refuse("changes the crate registry", words);
      if (["install", "uninstall"].includes(first)) return refuse("installs onto this machine", words);
      return null;
    case "twine": case "flit": case "hatch": case "pdm": case "uv": case "poetry": case "deno": case "jsr": case "vsce": case "ovsx": case "changeset": case "lerna": case "goreleaser":
      if (["upload", "publish", "release"].includes(first)) return dry ? null : refuse("publishes a package", words);
      return null;
    case "gem":
      return ["push", "yank", "owner"].includes(first) ? refuse("publishes a gem", words) : ["install", "uninstall", "update"].includes(first) ? refuse("installs onto this machine", words) : null;
    case "pod":
      return first === "trunk" && ["push", "register", "add-owner", "delete", "deprecate"].includes(second) ? refuse("publishes a pod", words) : null;
    case "nuget":
      return first === "push" || first === "delete" ? refuse("publishes a package", words) : null;
    case "dotnet":
      return first === "nuget" && ["push", "delete"].includes(second) ? refuse("publishes a package", words) : null;
    case "mvn": case "mvnw":
      return pos.some((a) => a === "deploy" || /^release:(perform|prepare)$/.test(a)) ? refuse("publishes a package", words) : null;
    case "gradle": case "gradlew":
      return pos.some((a) => /^(publish|upload|deploy)/i.test(a)) ? refuse("publishes a package", words) : pos.some((a) => /^install/i.test(a)) ? refuse("installs on a device", words) : null;
    case "make": case "gmake": case "rake": {
      const target = pos.filter((a) => !ASSIGNMENT.test(a)).find((a) => ["deploy", "publish", "release", "install", "upload", "push", "ship"].includes(a.toLowerCase()));
      return target ? refuse(`runs the ${name} target ${target}`, words) : null;
    }
    case "swift":
      return first === "package-registry" && second === "publish" ? refuse("publishes a package", words) : null;
    case "brew":
      return ["install", "reinstall", "upgrade", "uninstall", "remove", "rm", "tap", "untap", "link", "unlink", "services"].includes(first) ? refuse("installs onto this machine", words) : null;
    case "port": case "apt": case "apt-get": case "yum": case "dnf": case "apk": case "pacman": case "zypper":
      return pos.some((a) => ["install", "remove", "upgrade", "uninstall", "purge", "update", "-S", "-R"].includes(a)) || has(args, "-S", "-R", "-U") ? refuse("installs onto this machine", words) : null;
    case "pipx":
      return ["install", "uninstall", "upgrade", "inject", "reinstall"].includes(first) ? refuse("installs onto this machine", words) : null;
    case "mas":
      return ["install", "upgrade", "purchase", "lucky"].includes(first) ? refuse("installs onto this machine", words) : null;
    case "softwareupdate":
      return has(args, "-i", "--install", "-a", "--all") ? refuse("installs onto this machine", words) : null;
    case "installer":
      return refuse("installs onto this machine", words);
    case "launchctl":
      return ["load", "unload", "bootstrap", "bootout", "enable", "disable", "kickstart", "submit", "remove", "start", "stop"].includes(first) ? refuse("installs or changes a service on this machine", words) : null;
    case "defaults":
      return ["write", "delete", "import", "rename"].includes(first) ? refuse("changes this machine's settings", words) : null;
    case "xcode-select":
      return has(args, "-s", "--switch", "--install", "-r", "--reset") ? refuse("changes this machine's settings", words) : null;
    case "sendmail": case "mail": case "mailx": case "msmtp":
      return refuse("sends mail", words);
    case "ntfy":
      return ["publish", "pub", "send", "trigger"].includes(first) ? refuse("sends a notification", words) : null;
    case "atelier":
      return refuse("acts on Atelier itself", words);
    case "python": case "py": {
      const m = args.indexOf("-m");
      return m !== -1 && args[m + 1] === "twine" && args[m + 2] === "upload" ? refuse("publishes a package", words) : null;
    }
  }
  if (PAID_MODELS.has(name)) return args.length && args.every((a) => ["--version", "-v", "--help", "-h"].includes(a)) ? null : refuse("runs a paid model", words);
  return null;
}

// Whether a command, with its tool's name and arguments, is a known build,
// test or inspection form. Only forms that change nothing outside the clone,
// the caller's caches and temporary files are listed.
function readOnlyFor(name: string, args: string[]): boolean {
  if (UTILITIES.has(name)) return true;
  if (name === "sed") return !args.some((a) => /^(-i|--in-place)/.test(a));
  if (name === "find") return !args.some((a) => ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"].includes(a));
  if (BUILD_TOOLS.has(name)) return true;
  const first = positionals(args)[0];
  switch (name) {
    case "git": {
      const [sub, next] = positionals(args, GIT_TAKES);
      if (READ_GIT.has(sub)) return true;
      if (sub === "config") return has(args, "--get", "--get-all", "--get-regexp", "-l", "--list");
      if (sub === "branch") return has(args, "--show-current", "--list", "-l", "-a", "-r", "-v", "-vv") || next === undefined;
      if (sub === "tag") return has(args, "-l", "--list") || next === undefined;
      if (sub === "submodule") return next === "status";
      if (sub === "lfs") return ["ls-files", "status", "env", "version"].includes(next);
      return !sub && has(args, "--version");
    }
    case "npm": case "pnpm": case "yarn": case "bun": {
      if (has(args, "-g", "--global")) return false;
      const [sub, next] = positionals(args, NPM_TAKES);
      if (sub === undefined) return name === "yarn" || has(args, "--version", "-v");
      if (["run", "run-script", "rum", "urn"].includes(sub)) return knownScript(next);
      const own: Record<string, string[]> = {
        npm: ["test", "t", "tst", "ci", "install", "i", "in", "isntall", "install-ci-test", "cit", "install-test", "it", "audit", "ls", "list", "ll", "la", "outdated", "pack", "explain", "why", "query"],
        pnpm: ["test", "t", "install", "i", "audit", "ls", "list", "outdated", "why"],
        yarn: ["test", "install", "audit", "why", "list"],
        bun: ["test", "install", "i", "build"],
      };
      if (own[name].includes(sub)) return true;
      return name !== "npm" && knownScript(sub);
    }
    case "node":
      if (has(args, "--test", "--check", "-c", "--version", "-v")) return true;
      { const run = args.indexOf("--run"); return run !== -1 && knownScript(args[run + 1]); }
    case "tsx":
      return has(args, "--test");
    case "turbo": {
      const tasks = positionals(args).filter((a) => a !== "run");
      return tasks.length > 0 && tasks.every((t) => knownScript(t));
    }
    case "deno":
      return BUILD_SUBCOMMANDS.deno.includes(first) || (first === "task" && knownScript(positionals(args)[1]));
    case "python": case "py": {
      const rest = afterOptions(args, ["-W", "-X"]);
      const m = args.indexOf("-m");
      if (m !== -1) {
        const mod = args[m + 1] ?? "";
        if (mod === "pip") return BUILD_SUBCOMMANDS.pip.includes(args[m + 2]);
        return PY_MODULES.has(mod);
      }
      return rest.length === 0 && has(args, "--version", "-V");
    }
    case "xcodebuild":
      return !args.some((a) => ["archive", "install", "installsrc", "-exportArchive", "-exportNotarizedApp"].includes(a));
    case "make": case "gmake": {
      const targets = positionals(afterOptions(args, ["-C", "-f", "--file", "--directory", "-j", "-l", "-o", "-W"]), ["-C", "-f", "-j", "-l", "-o", "-W"]).filter((a) => !ASSIGNMENT.test(a));
      return targets.length > 0 && targets.every((t) => knownScript(t) || ["all", "clean"].includes(t));
    }
    case "gradle": case "gradlew": {
      const tasks = positionals(args);
      return tasks.length > 0 && tasks.every((t) => /^(build|test|check|assemble|lint|clean|compile|javadoc|dokka|detekt|ktlint|spotless)/i.test(t));
    }
    case "mvn": case "mvnw": {
      const phases = positionals(args, ["-f", "-pl", "-P", "-s", "-D"]).filter((a) => !a.startsWith("-D"));
      return phases.length > 0 && phases.every((p) => ["validate", "compile", "test", "test-compile", "package", "verify", "clean"].includes(p) || p.endsWith(":check"));
    }
    case "cmake":
      return !args.some((a) => a === "--install" || a === "install");
    case "docker":
      return first === "build" && !has(args, "--push");
    case "plutil":
      return args.length > 0 && BUILD_SUBCOMMANDS.plutil.includes(args[0]);
    case "wrangler": {
      const [sub, next] = positionals(args, WRANGLER_TAKES);
      if (has(args, "--dry-run") && (["deploy", "publish"].includes(sub) || (sub === "versions" && next === "upload"))) return true;
      return BUILD_SUBCOMMANDS.wrangler.includes(sub ?? args[0]);
    }
    case "dotnet":
      return BUILD_SUBCOMMANDS.dotnet.includes(first) && (first !== "format" || has(args, "--verify-no-changes"));
    case "go":
      return BUILD_SUBCOMMANDS.go.includes(first) && first !== "generate";
  }
  const subs = BUILD_SUBCOMMANDS[name];
  return !!subs && subs.includes(first ?? "");
}

// Classes one simple command: whether it is refused, and whether it is a
// known read-only form. A wrapper (env, timeout, xargs, npx, sh -c, trap,
// eval and the like) is classed by the command it runs.
function classify(argv: string[], depth: number): Verdict {
  const words = [...argv];
  while (words.length && (KEYWORDS.has(words[0]) || ASSIGNMENT.test(words[0]))) words.shift();
  if (!words.length) return OK;
  if (depth > 8) return UNKNOWN;
  const [head, ...args] = words;
  // The words of a loop or case header are data; the commands in its body are read on their own.
  if (["for", "case", "select", "function"].includes(head)) return OK;
  const name = toolName(head);
  const inner = (rest: string[], known = true): Verdict => {
    const v = classify(rest, depth + 1);
    return { refusal: v.refusal, known: v.known && known && toolPath(head) };
  };
  const line = (text: string): Verdict => classifyLine(text, depth + 1);
  switch (name) {
    case "env": {
      const rest = afterOptions(args, ["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]);
      while (rest.length && ASSIGNMENT.test(rest[0])) rest.shift();
      return rest.length ? inner(rest) : OK;
    }
    case "command":
      if (has(args, "-v", "-V")) return OK;
      return inner(afterOptions(args));
    case "exec": case "builtin": case "nohup":
      return args.length ? inner(afterOptions(args, ["-a"])) : OK;
    case "nice":
      return inner(afterOptions(args, ["-n", "--adjustment"]));
    case "time":
      return inner(afterOptions(args));
    case "timeout": case "gtimeout": {
      const rest = afterOptions(args, ["-s", "--signal", "-k", "--kill-after"]);
      return inner(rest.slice(1));
    }
    case "xargs": {
      const rest = afterOptions(args, ["-n", "-I", "-L", "-P", "-s", "-E", "-d", "-a", "-J", "-R", "-S"]);
      return rest.length ? inner(rest) : OK;
    }
    case "sudo": case "doas":
      return inner(afterOptions(args, ["-u", "-g", "-U", "-C", "-h", "-p"]), false);
    case "cross-env": {
      const rest = [...args];
      while (rest.length && ASSIGNMENT.test(rest[0])) rest.shift();
      return inner(rest);
    }
    case "c8": case "nyc":
      return inner(afterOptions(args));
    case "npx": case "bunx": case "pnpx": case "uvx": {
      const call = args.findIndex((a) => a === "-c" || a === "--call");
      if (call !== -1) return line(args[call + 1] ?? "");
      return inner(afterOptions(args, ["-p", "--package", "--from", "--with", "--python"]));
    }
    case "uv": case "poetry": case "pipenv": case "hatch": case "pdm": case "rye": case "bundle": case "npm": case "pnpm": case "yarn": case "bun": {
      const [sub] = positionals(args, NPM_TAKES);
      const runs = name === "npm" ? ["exec", "x"] : name === "pnpm" || name === "yarn" ? ["exec", "dlx"] : name === "bun" ? ["x"] : name === "bundle" ? ["exec"] : ["run"];
      if (sub && runs.includes(sub)) {
        const at = args.indexOf(sub);
        const rest = afterOptions(args.slice(at + 1), ["--with", "--python", "-p", "--project", "--directory", "--extra", "--group", "--package", "--env-file", "--with-requirements", "--index", "--index-url", "-c", "--call"]);
        const m = rest[0] === "-m" ? ["python", ...rest] : rest;
        return m.length ? inner(m) : UNKNOWN;
      }
      break;
    }
    case "xcrun": {
      // xcrun's own options come before the tool it runs.
      const rest = afterOptions(args, ["--sdk", "-sdk", "--toolchain", "-toolchain"]);
      const own = args.slice(0, args.length - rest.length);
      if (has(own, "-f", "--find", "--show-sdk-path", "--show-sdk-version", "--show-sdk-build-version", "--show-sdk-platform-path", "--show-sdk-platform-version", "--version")) return OK;
      return inner(rest);
    }
    case "eval":
      return line(args.join(" "));
    case "trap":
      if (!args.length || ["-l", "-p"].includes(args[0]) || ["", "-"].includes(args[0])) return OK;
      return line(args[0]);
  }
  if (SHELLS.has(name)) {
    // sh -c 'script' runs the script; sh with a file runs a project script.
    let i = 0;
    for (; i < args.length && /^[-+]/.test(args[i]); i++) {
      if (args[i] === "-o" || args[i] === "+o") { i++; continue; }
      if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(args[i])) return args[i + 1] === undefined ? UNKNOWN : line(args[i + 1]);
    }
    return UNKNOWN;
  }
  const refused = refusalFor(name, args, words);
  if (refused) return refused;
  return { refusal: null, known: toolPath(head) && readOnlyFor(name, args) };
}

function classifyLine(line: string, depth: number): Verdict & { parsed: boolean } {
  const commands = simpleCommands(line);
  if (!commands) return { refusal: null, known: false, parsed: false };
  return { ...combine(commands.map((c) => classify(c, depth))), parsed: true };
}

// A command line's class from its words alone: refused when any command it
// runs is never read-only, and known read-only when every one is a known form.
export function classifyCommand(command: string): { refusal: string | null; known: boolean; parsed: boolean } {
  return classifyLine(command, 0);
}

// Why a command can never be a check, as a phrase ("deploys (wrangler deploy)"); null when it can.
export function refusalOf(command: string): string | null {
  return classifyCommand(command).refusal;
}

export function knownReadOnly(command: string): boolean {
  const c = classifyCommand(command);
  return c.parsed && c.known && !c.refusal;
}

// The sentence that refuses a check, naming the command and what it does.
export function refusalText(command: string, why: string): string {
  return `\`${command}\` is not a check: it ${why}. A check runs in a clean clone, and Atelier never runs one that deploys, installs, publishes, pushes or spends money; register a command that builds or tests instead`;
}

// ── a project's checks ─────────────────────────────────────────────────────

// The class of one registered check, from what is recorded and its command.
// A command that is never read-only is refused whatever is recorded.
export function checkClassOf(policy: Pick<ProjectPolicy, "checkClasses">, command: string): CheckClassView {
  const refusal = refusalOf(command);
  if (refusal) return { command, class: "refused", refusal };
  const recorded = policy.checkClasses?.find((d) => d.command === command);
  if (recorded) return { command, class: "read-only", by: recorded.by, ...(recorded.note ? { note: recorded.note } : {}) };
  if (knownReadOnly(command)) return { command, class: "read-only", by: "command" };
  return { command, class: "undeclared" };
}

export function checkClasses(policy: Pick<ProjectPolicy, "checks" | "checkClasses">): CheckClassView[] {
  return policy.checks.map((command) => checkClassOf(policy, command));
}

// A check's class in words, for the project page, init's summary and `atelier status`.
export function classText(view: CheckClassView): string {
  if (view.class === "refused") return `refused, because it ${view.refusal}; Atelier will not run it until the project owner replaces it`;
  if (view.class === "undeclared") return "undeclared: registered before checks had classes, and still run; the project owner declares it with atelier init --declare-read-only \"reason\"";
  if (view.by === "adapter") return `read-only, from ControlPlane: ${view.note}`;
  if (view.by === "owner") return `read-only, declared by the project owner: ${view.note}`;
  return "read-only, a known build or test command";
}

// What an owner's declaration records: text, control characters as spaces,
// trimmed. A missing, blank or over-long reason is refused, not cut.
export function declarationNote(value: unknown): string {
  const note = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "";
  if (!note) throw new RuleError("bad_declaration", "a check declared read-only needs a reason", 400);
  if (note.length > DECLARATION_MAX) throw new RuleError("bad_declaration", `a declaration's reason is at most ${DECLARATION_MAX} characters`, 400);
  return note;
}

// The declarations a request carries, checked at the boundary: a list of
// { command, by: "adapter" or "owner", note }. Atelier records "command"
// itself, from the command's words, and takes it from no request.
export function parseDeclarations(value: unknown): CheckDeclaration[] {
  if (!Array.isArray(value)) throw new RuleError("bad_declaration", "checkClasses must be a list of { command, by, note }", 400);
  return value.map((d) => {
    if (!d || typeof d !== "object" || typeof d.command !== "string" || !d.command.trim() || !["adapter", "owner"].includes(d.by)) {
      throw new RuleError("bad_declaration", "each declaration names a command and is by \"adapter\" or \"owner\"", 400);
    }
    return { command: d.command.trim(), by: d.by, note: declarationNote(d.note) };
  });
}

// The classes recorded for a project's checks after an init. With `strict`,
// as when the init names the checks, each one must be read-only: one whose
// command is never read-only is refused whatever is declared, and one that is
// neither declared now, a known form, nor declared before is refused as
// undeclared. Otherwise the given declarations must name registered checks,
// and the records of checks still registered are kept.
export function settleCheckClasses(
  checks: string[], given: CheckDeclaration[] | undefined, current: CheckDeclaration[] | undefined, strict: boolean,
): CheckDeclaration[] {
  const declared = given ?? [];
  const stray = declared.filter((d) => !checks.includes(d.command));
  if (stray.length) {
    throw new RuleError("bad_declaration", `${stray.map((d) => `\`${d.command}\``).join(", ")} ${stray.length === 1 ? "is" : "are"} not a registered check; declare a check in the same init that names it with --check`, 400);
  }
  // A command that is never read-only cannot be declared, and an init that
  // names the checks cannot register one.
  const refused = (strict ? checks : declared.map((d) => d.command)).flatMap((command) => { const why = refusalOf(command); return why ? [refusalText(command, why)] : []; });
  if (refused.length) throw new RuleError("not_read_only", `${refused.join(". ")}.`, 400);
  const out: CheckDeclaration[] = [];
  const undeclared: string[] = [];
  for (const command of checks) {
    if (refusalOf(command)) continue;
    const record = declared.find((d) => d.command === command)
      ?? (knownReadOnly(command) ? { command, by: "command" as const } : current?.find((d) => d.command === command));
    if (record) out.push(record);
    else undeclared.push(command);
  }
  if (strict && undeclared.length) {
    const list = undeclared.map((c) => `\`${c}\``).join(", ");
    throw new RuleError("undeclared_check", `${list} ${undeclared.length === 1 ? "is not a command" : "are not commands"} Atelier knows to be read-only. A check must deploy, install, publish, push and spend nothing; if ${undeclared.length === 1 ? "it does" : "they do"} none of these, run init again with --declare-read-only "why ${undeclared.length === 1 ? "it changes" : "they change"} nothing outside the clone", which the project records as your declaration`, 400);
  }
  return out;
}

// ── a ControlPlane adapter ─────────────────────────────────────────────────

export interface Capability { name: string; command: string[]; actionClass: string }

// The capabilities a ControlPlane adapter lists, as an object from name to
// capability or as a list; entries without an argv command are skipped.
export function adapterCapabilities(adapter: unknown): Capability[] {
  const list = (adapter as { capabilities?: unknown } | null)?.capabilities;
  const entries: [string, unknown][] = Array.isArray(list)
    ? list.map((c, i) => [String((c as { name?: unknown })?.name ?? i), c])
    : list && typeof list === "object" ? Object.entries(list) : [];
  return entries.flatMap(([name, c]) => {
    const cap = c as { command?: unknown; action_class?: unknown } | null;
    return Array.isArray(cap?.command) && cap.command.length && cap.command.every((w) => typeof w === "string")
      ? [{ name, command: cap.command as string[], actionClass: typeof cap.action_class === "string" ? cap.action_class : "" }]
      : [];
  });
}

// ControlPlane's classes for a capability that changes nothing beyond the
// machine running it. local-write is a build's: it writes build products and
// caches, which in a clean clone are thrown away.
const ADAPTER_READ_ONLY = new Set(["none", "local-read-only", "local-write"]);

// The capability whose command is the check's, word for word, if any.
export function capabilityOf(caps: Capability[], command: string): Capability | null {
  const commands = simpleCommands(command);
  if (!commands || commands.length !== 1) return null;
  const words = commands[0];
  return caps.find((c) => c.command.length === words.length && c.command.every((w, i) => w === words[i])) ?? null;
}

// What a ControlPlane adapter says of each check: a declaration for one it
// lists as a read-only capability, a refusal for one it lists under another
// class (deploy, device, network and the rest), nothing for one it does not list.
export function adapterClasses(adapter: unknown, checks: string[]): { declarations: CheckDeclaration[]; refusals: { command: string; text: string }[] } {
  const caps = adapterCapabilities(adapter);
  const declarations: CheckDeclaration[] = [];
  const refusals: { command: string; text: string }[] = [];
  for (const command of checks) {
    const cap = capabilityOf(caps, command);
    if (!cap) continue;
    if (ADAPTER_READ_ONLY.has(cap.actionClass)) declarations.push({ command, by: "adapter", note: `capability ${cap.name} is ${cap.actionClass}` });
    else refusals.push({ command, text: refusalText(command, `is ControlPlane capability ${cap.name}, of class ${cap.actionClass || "none given"}`) });
  }
  return { declarations, refusals };
}
