// The deploy gate's warning (t293): the commands a project runs after a
// merge or at ship — its post-merge steps, its ship order's runs, and the
// script package.json names deploy — must pass before anything is delivered,
// but a task lands when only the required checks pass. When such a command is
// not a required check, a task can land without it passing and hold the deploy
// (miqra's wave 1: eight tasks landed failing npm run verify:visual, which no
// check ran). `atelier status` and `atelier init` name each such command and
// the init that adds it as a check.
//
// The commands compared are the npm scripts the gate invokes, expanded through
// the scripts package.json holds: `npm run deploy` runs the deploy script's
// commands, `npm run verify:visual` among them, and a script's commands in
// turn. A required check covers a script when it invokes it, expanded the same
// way, so `npm test` covers a command the test script runs. Commands that
// could never be a check — `npm run deploy` itself, which deploys — are not
// named: the warning suggests adding what it names, and the delivery itself is
// no gap before it. A project whose checkout this Mac does not hold says
// nothing of its deploy script, which cannot be read here; the commands its
// policy holds still name their gaps.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { refusalOf, simpleCommands } from "../src/checks.ts";

// The scripts package.json holds at `top`, or null when it holds none or
// cannot be read: what the gate's and the checks' commands expand through.
export function packageScripts(top) {
  if (!top) return null;
  let doc;
  try { doc = JSON.parse(readFileSync(join(top, "package.json"), "utf8")); }
  catch { return null; }
  const scripts = doc?.scripts;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) return null;
  return Object.fromEntries(Object.entries(scripts).filter(([, text]) => typeof text === "string"));
}

// The npm-family runners, and the options each takes before the script it
// runs, with the value that follows it (NPM_TAKES in src/checks.ts):
// `npm --prefix web run build` still names the build script.
const RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const RUNNER_TAKES = new Set(["--prefix", "-C", "--dir", "--workspace", "-w", "--filter", "-F", "--cwd", "--loglevel", "--registry", "--userconfig", "--cache"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

// The script an npm-family command runs — npm run build, npm test, yarn build
// — or null when the words run none. `words` is one simple command's words,
// past any environment assignments set before it.
function scriptOf(words) {
  if (!RUNNERS.has(words[0])) return null;
  const positional = [];
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if (word === "--") break;  // the words past -- are the script's own arguments
    if (word.startsWith("-") && word !== "-") { i += RUNNER_TAKES.has(word) && !word.includes("=") ? 1 : 0; continue; }
    positional.push(word);
  }
  const [runner, sub, next] = [words[0], positional[0], positional[1]];
  if (sub === "run" || sub === "run-script") return next ?? null;
  // npm's own test shortcut; a bare word before yarn, pnpm or bun names the script.
  if (runner === "npm") return ["test", "t", "tst"].includes(sub) ? "test" : null;
  return sub ?? null;
}

// Every script the lines invoke, as an npm-family command names it, expanded
// through `scripts`: each script name maps to the invocation first seen, in
// the order seen. A script is expanded once, however often it runs, and a line
// that cannot be read as commands (simpleCommands in src/checks.ts) says
// nothing.
function scriptsRun(lines, scripts) {
  const seen = new Map();
  const walkWords = (words) => {
    let at = 0;
    while (at < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at])) at++;
    const shell = typeof words[at] === "string" ? words[at].replace(/^.*\//, "") : "";
    if (SHELLS.has(shell)) {
      // sh -c 'npm run build': the string the shell runs is a line of its own.
      for (let i = at + 1; i < words.length && /^[-+]/.test(words[i]); i++) {
        if (words[i] === "-o" || words[i] === "+o") { i++; continue; }
        if (/^-[a-zA-Z]*c/.test(words[i]) && words[i + 1] !== undefined) { walk(words[i + 1]); return; }
      }
      return;  // a shell with a file runs a project script, whose words are not read here
    }
    const name = scriptOf(words.slice(at));
    if (name === null || seen.has(name)) return;
    seen.set(name, words.slice(at).join(" "));
    const text = scripts?.[name];
    if (typeof text === "string") walk(text);
  };
  const walk = (line) => {
    if (typeof line !== "string" || !line.trim()) return;
    for (const words of simpleCommands(line) ?? []) walkWords(words);
  };
  for (const line of lines) walk(line);
  return seen;
}

// The commands a project's deploy gate runs that no required check runs, in
// the order the gate runs them: the npm scripts its post-merge steps, its ship
// order's runs and the script package.json names deploy invoke, through the
// scripts those hold, that no required check invokes the same way. A command
// that can never be a check is left out, for the warning names what its
// reader can add.
export function uncheckedDeployCommands(policy, scripts) {
  const gate = scriptsRun([
    ...(Array.isArray(policy?.postMerge?.steps) ? policy.postMerge.steps : []).map((s) => s?.command),
    ...(Array.isArray(policy?.shipRuns) ? policy.shipRuns : []),
    ...(typeof scripts?.deploy === "string" ? [scripts.deploy] : []),
  ], scripts);
  if (!gate.size) return [];
  const checked = scriptsRun(Array.isArray(policy?.checks) ? policy.checks : [], scripts);
  return [...gate].filter(([name, command]) => !checked.has(name) && !refusalOf(command)).map(([, command]) => command);
}

// The warning itself, one line per command: what runs unguarded, and the init
// that adds it among the required checks (which --check replaces whole, so
// every check is named). `atelier status` passes the project's name, for it
// runs from anywhere; `atelier init`, run in the checkout, passes none.
export function deployGateLines(policy, scripts, project = null) {
  const checks = Array.isArray(policy?.checks) ? policy.checks : [];
  return uncheckedDeployCommands(policy, scripts).map((command) => {
    const all = [...checks, command].map((c) => JSON.stringify(c)).join(" --check ");
    return `Deploy gate: ${command} runs after a merge or at ship and no required check runs it, so a task can land without it passing; add it with atelier init --check ${all}${project ? ` --project ${project}` : ""}.`;
  });
}
