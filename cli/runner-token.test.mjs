import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { runnerCredential, runnerChildEnv, storeRunnerCredential } from "./credentials.mjs";
import { ROUTE_LEVEL } from "../src/route-level.ts";
import { runRunner, planFilePath } from "./runner.mjs";

const root = resolve(".cache/runner-token-tests");
mkdirSync(root, { recursive: true });
function fixture(t) {
  const dir = mkdtempSync(join(root, "test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("runner environment wins, empty/invalid selections cannot fall back, stores bind the server", (t) => {
  const dir = fixture(t);
  const env = { ATELIER_CONFIG_DIR: dir, ATELIER_SECRET_STORE: "file", ATELIER_TOKEN: "owner-secret" };
  storeRunnerCredential("https://one.test/", "Studio", "stored-runner", { env });
  assert.equal(runnerCredential("https://one.test", "HOME:Studio", { env }), "stored-runner");
  assert.equal(runnerCredential("https://one.test", "home:studio", { env: { ...env, ATELIER_RUNNER_TOKEN: "explicit-invalid" } }), "explicit-invalid");
  assert.throws(() => runnerCredential("https://one.test", "home:studio", { env: { ...env, ATELIER_RUNNER_TOKEN: "" } }), /empty/);
  assert.throws(() => runnerCredential("https://two.test", "home:studio", { env }), /not bound/);
  assert.throws(() => runnerCredential("https://one.test", "home:missing", { env }), /no runner credential/);
  const child = runnerChildEnv(env, "home:studio", "stored-runner", "model-review-token");
  assert.equal(runnerCredential("https://one.test", child.ATELIER_RUNNER_NAME, { env: child }), "model-review-token");
});

test("the direct CLI sends an explicit invalid runner credential once and never retries as owner", (t) => {
  const dir = fixture(t), cli = resolve("cli/atelier.mjs");
  const script = `
    process.argv = [process.execPath, ${JSON.stringify(cli)}, "queue"];
    globalThis.fetch = async (_url, options) => {
      if (options.headers.authorization !== "Bearer invalid-runner") throw new Error("owner fallback");
      process.stderr.write("REQUEST_WITH_RUNNER\\n");
      return Response.json({ error: "unauthorised" }, { status: 401 });
    };
    await import(${JSON.stringify(cli)});
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: {
    ...process.env, ATELIER_CONFIG_DIR: dir, ATELIER_SECRET_STORE: "file", ATELIER_SERVER: "https://one.test",
    ATELIER_RUNNER_TOKEN: "invalid-runner", ATELIER_TOKEN: "owner-secret", ATELIER_OWNER: "owner",
  } });
  assert.notEqual(result.status, 0);
  assert.equal(result.stderr.match(/REQUEST_WITH_RUNNER/g)?.length, 1);
  assert.doesNotMatch(result.stderr + result.stdout, /owner-secret|invalid-runner|owner fallback/);
});

for (const job of ["build", "plan"]) test(`the real runner completes ${job} with runner credentials in children and no token in harnesses/logs`, async (t) => {
  const dir = fixture(t), workspace = join(dir, "work");
  mkdirSync(workspace);
  const config = join(dir, "runner.json");
  const token = "runner-flow-secret";
  // Not Codex: a Codex build is refused unless its command grants the checks
  // full access (codexBuildRefusal, 3dc757f), and this stub harness is no such command.
  writeFileSync(config, JSON.stringify({ agents: [{ agent: "claude-code", models: ["gpt-6-astra"], env: ["LEAK_ALIAS"], command: ["stub-harness", "{model}", "{brief_file}", "{workspace}", "{plan_file}"] }], jobs: ["build", "plan"] }));
  const previous = Object.fromEntries(["LEAK_ALIAS", "ATELIER_CONFIG_DIR", "ATELIER_SECRET_STORE"].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { LEAK_ALIAS: token, ATELIER_CONFIG_DIR: dir, ATELIER_SECRET_STORE: "file" });
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const actor = "claude-code/gpt-6-astra";
  const assignment = { project: "demo", actor, agent: "claude-code", model: "gpt-6-astra", item: { id: "t1", title: "Change", scope: ["src/**"], accept: ["works"], ...(job === "plan" ? { kind: "plan", dispatch: { job: "plan" } } : {}) } };
  const calls = [], logs = [];
  let headReads = 0, posted = false, harness = false;
  await runRunner({ _: ["runner"], multi: {}, name: "home:studio", config, once: true }, {
    credential: token, workspacePath: () => workspace, load: () => 0, cores: () => 4,
    queue: async () => [assignment],
    jobBrief: async () => ({ text: "Build the scoped change" }),
    postPlan: async (_project, _id, who, text) => { assert.equal(who, actor); assert.equal(JSON.parse(text).goal, "Change"); posted = true; return { valid: true, hash: "plan-hash" }; },
    taskIO: { log: (line) => logs.push(line), reset: async () => {}, head: async () => ++headReads === 1 ? "before" : "after", dataHome: async () => null },
    executeChild: async (argv, options) => {
      if (argv[1]?.endsWith("atelier.mjs")) {
        assert.equal(options.env.ATELIER_RUNNER_TOKEN, token);
        assert.equal(options.env.ATELIER_RUNNER_NAME, "home:studio");
        calls.push(argv[2]);
      } else {
        harness = true;
        assert.equal(argv[0], "stub-harness");
        assert.ok(!Object.values(options.env).includes(token));
        assert.equal(options.env.LEAK_ALIAS, undefined);
        if (job === "plan") writeFileSync(planFilePath(workspace), JSON.stringify({ goal: "Change" }));
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  assert.ok(harness);
  assert.deepEqual(calls, job === "plan" ? ["claim", "release"] : ["claim", "finish"]);
  assert.equal(posted, job === "plan");
  assert.doesNotMatch(logs.join("\n"), new RegExp(token));
});

test("runner token issue/store have subcommand help and the issue request contains no actor", (t) => {
  const dir = fixture(t), cli = resolve("cli/atelier.mjs");
  for (const action of ["issue", "store"]) {
    const result = spawnSync(process.execPath, [cli, "token", action, "--help"], { encoding: "utf8", env: { ...process.env, ATELIER_CONFIG_DIR: dir } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--runner NAME/);
  }
  const script = `
    process.argv = [process.execPath, ${JSON.stringify(cli)}, "token", "issue", "--runner", "home:Studio", "--project", "demo"];
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.actor !== undefined || body.runner !== "home:Studio" || body.projects[0] !== "demo") throw new Error("wrong issue body");
      return Response.json({ runner: "home:studio", id: "id", token: "issued-value", expiresAt: "later" }, { status: 201 });
    };
    await import(${JSON.stringify(cli)});
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, ATELIER_CONFIG_DIR: dir, ATELIER_SERVER: "https://one.test", ATELIER_TOKEN: "owner-secret" } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ATELIER_RUNNER_TOKEN/);
  assert.equal(result.stdout.match(/issued-value/g)?.length, 1);
});

test("the CLI stores and polls with server-bound runner credentials on an owner-free machine", (t) => {
  const dir = fixture(t), cli = resolve("cli/atelier.mjs"), config = join(dir, "runner.json");
  writeFileSync(config, JSON.stringify({ agents: [{ agent: "codex", models: ["gpt-6-astra"], command: ["unused", "{model}", "{brief_file}", "{workspace}"] }], jobs: ["build"] }));
  const env = { ...process.env, ATELIER_CONFIG_DIR: dir, ATELIER_SECRET_STORE: "file", ATELIER_SERVER: "https://one.test", ATELIER_LOAD: "0" };
  for (const key of ["ATELIER_TOKEN", "ATELIER_RUNNER_TOKEN", "ATELIER_RUNNER_NAME"]) delete env[key];
  const secret = "atl_stored_runner";
  const store = `
    process.argv = [process.execPath, ${JSON.stringify(cli)}, "token", "store", "--runner", "HOME:Studio"];
    globalThis.fetch = async (url, options) => {
      if (url !== "https://one.test/api/config" || options.headers.authorization !== "Bearer ${secret}") throw new Error("wrong credential");
      return Response.json({ runner: "home:studio", tokenId: "id" });
    };
    await import(${JSON.stringify(cli)});
  `;
  const stored = spawnSync(process.execPath, ["--input-type=module", "-e", store], { encoding: "utf8", env, input: `${secret}\n` });
  assert.equal(stored.status, 0, stored.stderr);
  assert.doesNotMatch(stored.stdout + stored.stderr, new RegExp(secret));
  const record = JSON.parse(JSON.parse(readFileSync(join(dir, "secrets.json"), "utf8"))["runner.home:studio"]);
  assert.deepEqual(record, { server: "https://one.test", token: secret });
  const poll = `
    process.argv = [process.execPath, ${JSON.stringify(cli)}, "runner", "--name", "home:studio", "--once", "--config", ${JSON.stringify(config)}];
    globalThis.fetch = async (url, options = {}) => {
      if (url.endsWith("/version")) return Response.json({ routeLevel: ${ROUTE_LEVEL} });
      if (options.headers.authorization !== "Bearer ${secret}") throw new Error("wrong polling credential");
      if (url.endsWith("/config")) return Response.json({ runner: "home:studio", tokenId: "id" });
      if (url.endsWith("/queue")) {
        if (JSON.parse(options.body).runner !== "home:studio") throw new Error("wrong runner");
        process.stderr.write("POLLED\\n");
        return Response.json([]);
      }
      throw new Error("unexpected route");
    };
    await import(${JSON.stringify(cli)});
  `;
  const polled = spawnSync(process.execPath, ["--input-type=module", "-e", poll], { encoding: "utf8", env });
  assert.equal(polled.status, 0, polled.stderr);
  assert.match(polled.stderr, /POLLED/);
  assert.doesNotMatch(polled.stdout + polled.stderr, new RegExp(secret));
});
