// What the parts of runner.test.mjs share (t771); the tests were split across files so none runs for more than about a minute.
import { execFileSync } from "node:child_process";
import { after } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { removeBrief, removeDataHome } from "../cli/runner.mjs";

// The tests name fake workspaces, and a harness failure marker is a file in
// the cache keyed by the workspace's path (harnessFailureFiles in
// cli/runner.mjs), so every test process has a cache of its own. In the
// machine's cache, the two parts of this file and every other run of it shared
// the markers of workspace /cache/work/atelier/t13, and tests failed on each
// other's (t771).
// It is always a new folder, whatever ATELIER_CACHE the run inherited (that
// one may be the developer's, with workspaces in it), and the exit removes
// that folder alone.
const testCache = mkdtempSync(join(tmpdir(), "atelier-runner-test-cache-"));
process.env.ATELIER_CACHE = testCache;
process.once("exit", () => rmSync(testCache, { recursive: true, force: true }));

// A runner that gives a task up sets the process's exit code (1), as the
// command does. Some tests reset it when they end and some do not; in one
// file a later test always had, but a part that ends on one that does not
// would exit 1 with every test passing (t771). A failed test still fails the
// file: the runner sets the code after this hook.
after(() => { process.exitCode = 0; });
export const entry = { agent: "opencode", models: ["GLM-5.3-Flash-4_8bit", "glm:fast"], command: ["opencode", "run", "--model", "{model}", "--file", "{brief_file}", "{workspace}"] };
export const config = { agents: [entry] };
export const assignment = { project: "atelier", item: { id: "t13", title: "Home runner", scope: ["cli/runner.mjs", "test/runner*"] }, agent: entry.agent, model: entry.models[0], actor: `${entry.agent}/${entry.models[0]}` };
export const untilExits = (pid) => `setInterval(() => { try { process.kill(${pid}, 0); } catch { process.exit(); } }, 200); setTimeout(() => process.exit(3), 120000);`;
export const UNTIL_TEST_EXITS = untilExits(process.pid);
export function fixture(options = {}) {
  const calls = [], logs = [], homes = [];
  let reads = 0;
  const io = {
    // This lifecycle fixture has fake HEADs and no Git repository. Real Git
    // submission preparation is covered by gitWorkspace and current-main tests.
    prepareSubmission: undefined,
    log: (s) => logs.push(s), stopped: () => options.stopped ?? false,
    env: options.env ?? {}, ownerTokens: () => { calls.push({ ownerTokens: true }); return options.ownerTokens ?? []; },
    workspacePath: (project, id) => `/cache/work/${project}/${id}`,
    async cli(argv, cwd) {
      calls.push({ argv, cwd });
      if (argv[0] === options.failCommand) throw new Error(`${argv[0]} refused`);
    },
    async reset() {},
    async head() {
      reads++;
      if (options.unknownHead && reads > 1) throw new Error("unreadable HEAD");
      return reads === 1 ? "before" : options.head ?? "after";
    },
    // Whether the base is an ancestor of the head (alreadyComplete); the
    // record is ahead unless the test says otherwise (ancestor: false, or an
    // error to throw).
    async isAncestor(cwd, base, head) {
      calls.push({ isAncestor: [base, head], cwd });
      if (options.ancestor instanceof Error) throw options.ancestor;
      return options.ancestor ?? true;
    },
    async brief(workspace, text) {
      calls.push({ brief: text, workspace });
      if (options.failBrief) throw new Error("cannot write brief");
      return { file: "/cache/work/atelier/brief.txt" };
    },
    async harness(argv, cwd, env) {
      calls.push({ harness: argv, cwd, env });
      homes.push({ ran: env?.XDG_DATA_HOME });
      if (options.throwHarness) throw new Error("ENOENT");
      return { code: "code" in options ? options.code : 0, timedOut: options.timedOut };
    },
    // The failed harness's marker (t363), kept in memory when a test asks.
    ...(options.marker !== undefined ? {
      async readHarnessFailure() { return options.marker; },
      async writeHarnessFailure(cwd, failure) { calls.push({ wrote: failure, cwd }); options.marker = failure; },
      async clearHarnessFailure() { calls.push({ cleared: true }); options.marker = null; },
    } : {}),
    async removeBrief(brief) { calls.push({ removed: brief.file }); },
    // The builder's commit identity (t451): allowed unless the test says otherwise.
    async identityRefusals() { return options.identityRefusals ?? []; },
    async dataHome(workspace) {
      const dir = `${dirname(workspace)}/.atelier-${basename(workspace)}-opencode-data-x`;
      homes.push({ made: dir });
      return { dir };
    },
    async removeDataHome({ dir }) {
      homes.push({ removed: dir });
      if (options.failRemoval) throw new Error("busy");
    },
  };
  return { io, calls, logs, homes };
}
export const heldItem = (item = {}) => ({ ...assignment.item, state: "claimed", owner: assignment.actor, ...item });
export function gitWorkspace(t) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-wiring-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const workspace = join(dir, "t13");
  mkdirSync(workspace);
  const git = (...args) => execFileSync("git", args, { cwd: workspace, encoding: "utf8" }).trim();
  git("init", "--quiet");
  git("config", "user.name", "Runner test");
  git("config", "user.email", "runner@example.test");
  // The policy a claim keeps beside that identity (t451), which the runner
  // checks the builder's identity against.
  writeFileSync(join(workspace, ".git", "atelier-identity.json"), JSON.stringify({ name: "Runner test", email: "runner@example.test", agentEmails: [] }));
  writeFileSync(join(workspace, "tracked"), "original");
  git("add", ".");
  git("commit", "--quiet", "-m", "initial");
  // A stable baseline lets wiring tests exercise the real submission fetch.
  git("branch", "test-main");
  const path = join(dir, "runner.json");
  writeFileSync(path, JSON.stringify(config));
  return { dir, workspace, git, path, args: { _: ["runner"], multi: {}, name: "home:studio", config: path } };
}
export const KILL_GRACE_MS = 300;
