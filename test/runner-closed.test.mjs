import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { checked, runTask, runPlanTask, runRunner, failureCount, infrastructureFailureCount, runOutcome } from "../cli/runner.mjs";
import { runnerDenied, runnerTaskTerminal, terminalTaskExit, TERMINAL_TASK_EXITS } from "../src/tokens.ts";
import { parseRuleError, RuleError } from "../src/rules.ts";
import { SERVER_CAPABILITIES } from "../src/route-level.ts";

const assignment = { project: "demo", actor: "claude-code/model", agent: "claude-code", model: "model",
  item: { id: "t1", title: "Build", accept: ["works"], scope: [] } };
const config = { agents: [{ agent: "claude-code", models: ["model"], command: ["harness", "{model}", "{brief_file}", "{plan_file}"] }] };

for (const state of ["merged", "abandoned"]) {
  test(`terminal contract preserves ${state} and its display label`, () => {
    const error = parseRuleError(runnerTaskTerminal("t1", state));
    assert.equal(error.code, "task_terminal");
    assert.equal(error.status, 409);
    assert.match(error.detail, new RegExp(`state: ${state}`));
    assert.match(error.detail, new RegExp(`is ${state === "abandoned" ? "closed" : "merged"}`));
  });
  for (const step of ["claim", "finish"]) test(`${state} at ${step} preserves work and charges neither failure count`, async () => {
    const calls = [], logs = [];
    let head = "before", resets = 0;
    const result = await runTask(assignment, config, "home:studio", {
      workspacePath: () => "/unused", stopped: () => false, log: (line) => logs.push(line),
      cli: async (argv) => {
        calls.push(argv[0]);
        await checked([process.execPath, resolve("cli/atelier.mjs"), ...argv], { claim: argv[0] === "claim" }, async () => ({
          code: argv[0] === step ? TERMINAL_TASK_EXITS[state] : 0,
          stderr: argv[0] === step ? parseRuleError(runnerTaskTerminal("t1", state)).detail : "",
        }));
      },
      head: async () => head, reset: async () => { resets++; },
      brief: async () => ({ file: "/unused/brief" }), removeBrief: async () => {},
      identityRefusals: async () => [], env: {}, ownerTokens: () => [], harness: async () => { head = "committed"; return { code: 0 }; },
    });
    assert.equal(result.phase, "terminal");
    assert.equal(result.terminalState, state);
    assert.equal(head, step === "claim" ? "before" : "committed");
    assert.equal(resets, step === "claim" ? 0 : 1);
    assert.deepEqual(calls, step === "claim" ? ["claim"] : ["claim", "finish"]);
    assert.equal(failureCount(1, result), 1);
    assert.equal(infrastructureFailureCount(2, result), 2);
    assert.equal(runOutcome(result), null);
    assert.match(logs.join("\n"), new RegExp(`state: ${state}`));
  });
}

test("ordinary authorization and infrastructure exits are not terminal", async () => {
  for (const code of [1, 2, 3, 4]) await assert.rejects(
    checked(["claim"], { claim: true }, async () => ({ code, stderr: "refused" })),
    (error) => error.terminalState === undefined && error.claimRefused === (code === 3),
  );
});

for (const terminalState of ["merged", "abandoned"]) test(`runner continues other jobs and never retries ${terminalState}`, async (t) => {
  const root = resolve(".cache/runner-closed");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, "loop-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify(config));
  const calls = [], reports = [], logs = [];
  let polls = 0;
  const other = { ...assignment, item: { ...assignment.item, id: "t2" } };
  await runRunner({ _: ["runner"], multi: {}, name: "home:studio", config: configPath }, {
    credential: "test", workspacePath: () => dir,
    queue: async () => {
      if (++polls === 3) { process.emit("SIGINT"); return []; }
      // Both a duplicate in the current poll and a changed revision in the
      // next poll must stay stopped once the server reported closure.
      const offered = { ...assignment, item: { ...assignment.item, head: `head-${polls}`, updatedAt: `poll-${polls}` } };
      return [offered, offered, other];
    },
    wait: async () => {}, reportRun: async (report) => reports.push(report),
    executeChild: async (argv) => {
      calls.push([argv[2], argv[3]]);
      return { code: argv[3] === "t1" ? TERMINAL_TASK_EXITS[terminalState] : 3, stderr: "refused" };
    },
    taskIO: { log: (line) => logs.push(line) },
  });
  assert.deepEqual(calls, [["claim", "t1"], ["claim", "t2"]]);
  assert.deepEqual(reports, []);
  assert.match(logs.join("\n"), new RegExp(`state: ${terminalState}`));
  assert.doesNotMatch(logs.join("\n"), /after [23].*failures/);
});

test("non-CLI child exit codes cannot masquerade as terminal tasks", async () => {
  for (const code of Object.values(TERMINAL_TASK_EXITS)) await assert.rejects(
    checked(["git", "push"], { step: "push" }, async () => ({ code })),
    (error) => error.terminalState === undefined,
  );
});

for (const terminalState of ["merged", "abandoned"]) test(`a plan closed as ${terminalState} skips its finally release`, async () => {
  const calls = [];
  const result = await runPlanTask({ ...assignment, item: { ...assignment.item, kind: "plan" } }, config, "home:studio", {
    workspacePath: () => "/unused", stopped: () => false, log: () => {},
    cli: async (argv) => {
      calls.push(argv[0]);
      await checked([process.execPath, resolve("cli/atelier.mjs"), ...argv], { claim: true }, async () => ({ code: TERMINAL_TASK_EXITS[terminalState] }));
    },
    jobBrief: async () => ({ text: "Plan" }), postPlan: async () => {},
  });
  assert.equal(result.terminalState, terminalState);
  assert.deepEqual(calls, ["claim"]);
  assert.equal(failureCount(1, result), 1);
  assert.equal(infrastructureFailureCount(2, result), 2);
});

// The CLI's side of the contract (t476): a task_terminal answer ends claim,
// and every call finish makes, with the state's exit, where any other
// refusal keeps its own: 3 for a refused claim, 1 otherwise.
test("terminalTaskExit reads the state's exit from the server's answer alone", () => {
  for (const state of Object.keys(TERMINAL_TASK_EXITS)) {
    const rule = parseRuleError(runnerTaskTerminal("t1", state));
    assert.equal(terminalTaskExit({ error: rule.code, detail: rule.detail }), TERMINAL_TASK_EXITS[state]);
  }
  const denied = parseRuleError(runnerDenied({ runner: "home:studio", id: "tok" }));
  assert.equal(terminalTaskExit({ error: denied.code, detail: denied.detail }), null);
  assert.equal(terminalTaskExit({ error: "closed", detail: "t1 is merged (state: merged)" }), null);
  assert.equal(terminalTaskExit({ error: "task_terminal", detail: "t1 is blocked (state: blocked)" }), null);
  assert.equal(terminalTaskExit({ error: "task_terminal" }), null);
});

function cliExit(t, argv, answer) {
  const dir = mkdtempSync(join(resolve(".cache/runner-closed"), "cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cli = resolve("cli/atelier.mjs");
  const script = `
    process.argv = [process.execPath, ${JSON.stringify(cli)}, ...${JSON.stringify(argv)}];
    // The server declares every capability (t458), so claim's preflight passes and the answer under test decides the exit.
    globalThis.fetch = async (url) => String(url).endsWith("/api/version") ? Response.json({ capabilities: ${JSON.stringify(SERVER_CAPABILITIES)} }) :
      Response.json(${JSON.stringify(answer.body)}, { status: ${answer.status} });
    await import(${JSON.stringify(cli)});
  `;
  return spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: {
    ...process.env, ATELIER_CONFIG_DIR: dir, ATELIER_SECRET_STORE: "file", ATELIER_SERVER: "https://one.test",
    ATELIER_RUNNER_TOKEN: "runner-secret", ATELIER_RUNNER_NAME: "home:studio", ATELIER_TOKEN: "", ATELIER_ACTOR: "",
  } });
}

const asAnswer = (error) => { const rule = parseRuleError(error); return { status: rule.status, body: { error: rule.code, detail: rule.detail } }; };

for (const state of Object.keys(TERMINAL_TASK_EXITS)) test(`the CLI ends claim and finish's calls with the ${state} exit on a task_terminal answer`, (t) => {
  const answer = asAnswer(runnerTaskTerminal("t1", state));
  for (const argv of [["claim", "t1", "--project", "demo", "--as", "claude-code/model", "--runner", "home:studio"], ["show", "t1", "--project", "demo", "--as", "claude-code/model"]]) {
    const r = cliExit(t, argv, answer);
    assert.equal(r.status, TERMINAL_TASK_EXITS[state], r.stderr);
    assert.match(r.stderr, new RegExp(`task_terminal: t1 is ${state === "abandoned" ? "closed" : "merged"} \\(state: ${state}\\)`));
  }
});

test("other refusals keep their exits: 3 for a refused claim, 1 for a nonterminal refusal", (t) => {
  const claim = ["claim", "t1", "--project", "demo", "--as", "claude-code/model", "--runner", "home:studio"];
  const forbidden = cliExit(t, claim, asAnswer(runnerDenied({ runner: "home:studio", id: "tok" })));
  assert.equal(forbidden.status, 3, forbidden.stderr);
  assert.match(forbidden.stderr, /runner_forbidden/);
  const blocked = cliExit(t, ["show", "t1", "--project", "demo", "--as", "claude-code/model"], asAnswer(new RuleError("blocked", "t1 is blocked", 409)));
  assert.equal(blocked.status, 1, blocked.stderr);
  const closed = cliExit(t, claim, asAnswer(new RuleError("closed", "t1 is merged", 409)));
  assert.equal(closed.status, 3, closed.stderr);
});
