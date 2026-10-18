import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { runnerCredential, runnerChildEnv, storeRunnerCredential } from "./credentials.mjs";
import { ROUTE_LEVEL, SERVER_CAPABILITIES } from "../src/route-level.ts";
import { runRunner, planFilePath } from "./runner.mjs";
import { readMovedCodeRecords } from "./landing.mjs";

// Scratch lives under the system temp folder and goes with the run (t640).
const root = mkdtempSync(join(tmpdir(), "atelier-runner-token-tests-"));
after(() => rmSync(root, { recursive: true, force: true }));
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
  assert.equal(runnerCredential("https://one.test", "home:missing", { env }), null);
  assert.throws(() => runnerCredential("https://one.test", "home:studio", { env, read: () => "not json" }), /no server binding/);
  assert.throws(() => runnerCredential("https://one.test", "home:studio", { env, read: () => JSON.stringify({ server: "https://one.test" }) }), /not bound/);
  assert.throws(() => runnerCredential("https://one.test", "home:missing", { env: { ...env, ATELIER_RUNNER_TOKEN: "" } }), /empty/);
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

// A build merges current main before it submits (prepareBuildSubmission,
// t435): between the harness and finish the runner's children are the
// baseline-token CLI call, which must carry the runner credential as every
// CLI child does (the server lets a runner token read the project's
// baseline token: runnerRoute in src/tokens.ts, covered by
// test/runner-baseline-token.spec.ts), and the landing's merge of main
// (mergeMainAndRegenerate in cli/land.mjs) as git commands in the
// workspace, whose fetch authenticates with that read token, never the
// runner's, and whose moved-code comparison (t471) reads the trees with
// git's diff output pinned and logs what it compared in the workspace's git
// dir. The plan job merges nothing and keeps its two calls.
for (const job of ["build", "plan"]) test(`the real runner completes ${job} with runner credentials in children and no token in harnesses/logs`, async (t) => {
  const dir = fixture(t), workspace = join(dir, "work"), gitDir = join(dir, "gitdir");
  mkdirSync(workspace);
  mkdirSync(gitDir);
  const config = join(dir, "runner.json");
  const token = "runner-flow-secret", baseToken = "main-read-secret", mainHead = "f".repeat(40), forkPoint = "e".repeat(40);
  // Not Codex: a Codex build is refused unless its command grants the checks
  // full access (codexBuildRefusal, 3dc757f), and this stub harness is no such command.
  writeFileSync(config, JSON.stringify({ agents: [{ agent: "claude-code", models: ["gpt-6-astra"], env: ["LEAK_ALIAS"], command: ["stub-harness", "{model}", "{brief_file}", "{workspace}", "{plan_file}"] }], jobs: ["build", "plan"] }));
  const previous = Object.fromEntries(["LEAK_ALIAS", "ATELIER_CONFIG_DIR", "ATELIER_SECRET_STORE"].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { LEAK_ALIAS: token, ATELIER_CONFIG_DIR: dir, ATELIER_SECRET_STORE: "file" });
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const actor = "claude-code/gpt-6-astra";
  const assignment = { project: "demo", actor, agent: "claude-code", model: "gpt-6-astra", item: { id: "t1", title: "Change", scope: ["src/**"], accept: ["works"], ...(job === "plan" ? { kind: "plan", dispatch: { job: "plan" } } : {}) } };
  const calls = [], gitCalls = [], logs = [], settings = new Map();
  let headReads = 0, posted = false, harness = false, finish = null;
  await runRunner({ _: ["runner"], multi: {}, name: "home:studio", config, once: true }, {
    credential: token, workspacePath: () => workspace, load: () => 0, cores: () => 4,
    queue: async () => [assignment],
    jobBrief: async () => ({ text: "Build the scoped change" }),
    postPlan: async (_project, _id, who, text) => { assert.equal(who, actor); assert.equal(JSON.parse(text).goal, "Change"); posted = true; return { valid: true, hash: "plan-hash" }; },
    // The workspace is a bare folder no claim set up, so the builder
    // identity check (t451) is stubbed to allow it.
    taskIO: { log: (line) => logs.push(line), reset: async () => {}, head: async () => ++headReads === 1 ? "before" : "after", dataHome: async () => null, identityRefusals: async () => [] },
    executeChild: async (argv, options) => {
      if (argv[1]?.endsWith("atelier.mjs")) {
        assert.equal(options.env.ATELIER_RUNNER_TOKEN, token);
        assert.equal(options.env.ATELIER_RUNNER_NAME, "home:studio");
        calls.push(argv[2]);
        if (argv[2] === "baseline-token") {
          assert.deepEqual(argv.slice(2), ["baseline-token", "--project", "demo", "--as", actor]);
          return { code: 0, output: JSON.stringify({ remote: "https://git.test/demo.git", token: baseToken, defaultBranch: "main", regenerate: null }), stderr: "" };
        }
        if (argv[2] === "finish") finish = argv.slice(2);
      } else if (argv[0] === "git") {
        gitCalls.push(argv[1]);
        assert.equal(options.cwd, workspace);
        assert.equal(options.signal?.aborted, false, "git runs under the runner's stop signal");
        const headers = Object.entries(options.env ?? {}).filter(([key]) => /^GIT_CONFIG_VALUE_/.test(key)).map(([, value]) => value);
        if (argv[1] === "fetch") {
          assert.deepEqual(argv.slice(2), ["--quiet", "https://git.test/demo.git", "main"]);
          // The fetch is bounded by Git's low-speed floor (t763), after the header.
          assert.deepEqual(headers, [`Authorization: Bearer ${baseToken}`, "1000", "120"]);
        } else assert.deepEqual(headers, [], "only the fetch carries the read token");
        assert.ok(!argv.includes(token) && !argv.includes(baseToken), "no credential is a git argument");
        // A workspace whose fork predates main's head: main is not yet in
        // HEAD, so the landing's merge runs; everything else holds.
        if (argv[1] === "merge-base" && argv[2] === "--is-ancestor") return { code: argv[3] === "FETCH_HEAD" ? 1 : 0, output: "", stderr: "" };
        if (argv[1] === "merge-base") return { code: 0, output: `${forkPoint}\n`, stderr: "" };
        if (argv[1] === "rev-list") return { code: 0, output: argv.includes("--first-parent") ? `${mainHead}\n` : "", stderr: "" };
        if (argv[1] === "diff-tree") assert.equal(options.env.GIT_CONFIG_COUNT, "0", "the comparison reads the trees with git's diff output pinned (DETECTOR_ENV)");
        if (argv[1] === "rev-parse" && argv.includes("--absolute-git-dir")) return { code: 0, output: `${gitDir}\n`, stderr: "" };
        // The merge pipeline (t463) installs the clone's merge drivers
        // through the same git: the common dir holds the driver's copy, and
        // the settings it writes are read back.
        if (argv[1] === "rev-parse" && argv.includes("--git-common-dir")) return { code: 0, output: `${gitDir}\n`, stderr: "" };
        if (argv[1] === "config" && argv[3] === "--get") return settings.has(argv[4]) ? { code: 0, output: `${settings.get(argv[4])}\n`, stderr: "" } : { code: 1, output: "", stderr: "" };
        if (argv[1] === "config") { settings.set(argv[3], argv[4]); return { code: 0, output: "", stderr: "" }; }
        if (argv[1] === "rev-parse" && argv.includes("MERGE_HEAD")) return { code: 1, output: "", stderr: "" };
        if (argv[1] === "rev-parse") return { code: 0, output: `${mainHead}\n`, stderr: "" };
        if (argv[1] === "merge") assert.deepEqual(argv.slice(2), ["--no-ff", "--no-commit", "--no-edit", "-m", `Merge main at ${mainHead.slice(0, 8)} into t1\n\nAgent: ${actor}`, "FETCH_HEAD"]);
      } else {
        harness = true;
        assert.equal(argv[0], "stub-harness");
        assert.ok(!Object.values(options.env).includes(token));
        assert.equal(options.env.LEAK_ALIAS, undefined);
        if (job === "plan") writeFileSync(planFilePath(workspace), JSON.stringify({ goal: "Change" }));
      }
      return { code: 0, output: "", stderr: "" };
    },
  });
  assert.ok(harness);
  assert.deepEqual(calls, job === "plan" ? ["claim", "release"] : ["claim", "baseline-token", "finish"], logs.join("\n"));
  // The read of the head's message (t557: whether it is work in progress a
  // validation_blocked run committed), then the leftover-files check after the harness (t365: unstaged and staged
  // changes, untracked files), then the landing.s merge (fetch, main.s head, whether HEAD holds it; the
  // moved-code comparison: the build's head, the merge base, main's and the
  // build's trees, the git dir its log goes to; the fork point and the
  // commits from main; the merge pipeline's (t463): its drivers' settings
  // read, written and read back in the common Git dir, the two heads, the
  // no-ff merge and the Git dir it looks for a merge in; the route-level comparison, the
  // merged head), then the runner's own checks of the result (no conflict,
  // no merge pending, main's head and the build's head both in HEAD's history).
  assert.deepEqual(gitCalls, job === "plan" ? [] : ["log", "diff", "diff", "ls-files", "fetch", "rev-parse", "merge-base", "rev-parse", "merge-base", "diff-tree", "diff-tree", "rev-parse", "merge-base", "rev-list", "rev-parse", ...Array(12).fill("config"), "rev-parse", "rev-parse", "merge", "rev-parse", "rev-list", "merge-base", "rev-parse", "diff", "rev-parse", "merge-base", "merge-base"]);
  assert.deepEqual(readMovedCodeRecords(gitDir).map((r) => r.kind), job === "plan" ? [] : ["compared"], "the comparison is logged in the workspace, as a landing's is");
  assert.deepEqual(finish, job === "plan" ? null : ["finish", "t1", "--project", "demo", "--as", actor, "--summary", `Built t1 with main at ${mainHead} merged`]);
  assert.equal(posted, job === "plan");
  assert.doesNotMatch(logs.join("\n"), new RegExp(`${token}|${baseToken}`));
});

// The CLI half of the step above, as the runner's child runs it: with
// ATELIER_RUNNER_TOKEN and ATELIER_RUNNER_NAME set and no owner token,
// `atelier baseline-token` sends the runner credential, asks the project's
// baseline-token route for read scope and reads the project's policy, and
// prints the token the server minted with the regenerate command beside
// it, so the runner can fetch main with the one and regenerate with the
// other. No item route is called: the item's base-token answers a runner
// only for the job it holds, which a part's plan never is.
test("the direct CLI reads the baseline token and the regenerate command with the runner credential and no owner token", (t) => {
  const dir = fixture(t), cli = resolve("cli/atelier.mjs"), secret = "atl_runner_flow";
  const env = { ...process.env, ATELIER_CONFIG_DIR: dir, ATELIER_SECRET_STORE: "file", ATELIER_SERVER: "https://one.test", ATELIER_RUNNER_TOKEN: secret, ATELIER_RUNNER_NAME: "home:studio" };
  for (const key of ["ATELIER_TOKEN", "ATELIER_ACTOR"]) delete env[key];
  const script = `
    process.argv = [process.execPath, ${JSON.stringify(cli)}, "baseline-token", "--project", "demo", "--as", "claude-code/gpt-6-astra"];
    globalThis.fetch = async (url, options = {}) => {
      if (options.headers.authorization !== "Bearer ${secret}") throw new Error("wrong credential");
      if (url === "https://one.test/api/config") return Response.json({ runner: "home:studio", tokenId: "id" });
      if (options.headers["x-atelier-actor"] !== "claude-code/gpt-6-astra") throw new Error("wrong actor");
      if (url === "https://one.test/api/projects/demo" && options.method === "GET") return Response.json({ project: { name: "demo", policy: { checks: [], regenerate: "node cli/regenerate.mjs" } }, items: [], events: [] });
      if (url !== "https://one.test/api/projects/demo/baseline-token" || options.method !== "POST") throw new Error("unexpected route " + url);
      if (JSON.parse(options.body).scope !== "read") throw new Error("wrong baseline-token request");
      return Response.json({ remote: "https://git.test/demo.git", token: "main-read-secret", tokenId: "up-1", expiresAt: "2026-10-11T00:00:00.000Z", defaultBranch: "main" });
    };
    await import(${JSON.stringify(cli)});
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { remote: "https://git.test/demo.git", token: "main-read-secret", defaultBranch: "main", regenerate: "node cli/regenerate.mjs" });
  assert.doesNotMatch(result.stderr, new RegExp(secret));
});

// t353: a runner token cannot act as the owner, so the runner's report of a
// review it will not serve goes as the review job's actor, which the poll
// was offered the job for, under the runner's name; a report as the owner is
// what the server refused, leaving the landing to wait out the hour.
test("the runner reports a review it will not serve as the review's actor under a runner token, never as the owner", (t) => {
  const dir = fixture(t), cli = resolve("cli/atelier.mjs"), config = join(dir, "runner.json");
  // No tokens entry for the model: the review is refused before any claim
  // (reviewToken), and the refusal is reported as a skip.
  writeFileSync(config, JSON.stringify({ agents: [{ agent: "codex", models: ["gpt-6-astra"], command: ["unused", "{model}", "{brief_file}", "{workspace}", "{verdict_file}"] }], jobs: ["review"] }));
  const secret = "atl_runner_review_secret";
  const env = { ...process.env, ATELIER_CONFIG_DIR: dir, ATELIER_SECRET_STORE: "file", ATELIER_SERVER: "https://one.test", ATELIER_LOAD: "0", ATELIER_RUNNER_TOKEN: secret };
  for (const key of ["ATELIER_TOKEN", "ATELIER_RUNNER_NAME", "ATELIER_OWNER"]) delete env[key];
  const head = "a".repeat(40);
  const script = `
    process.argv = [process.execPath, ${JSON.stringify(cli)}, "runner", "--name", "home:studio", "--once", "--config", ${JSON.stringify(config)}];
    const review = { project: "demo", actor: "codex/gpt-6-astra", agent: "codex", model: "gpt-6-astra", item: { id: "t21", title: "Review", head: ${JSON.stringify(head)}, request: 3, dispatch: { job: "review", to: "home", agent: "codex", model: "gpt-6-astra" } } };
    globalThis.fetch = async (url, options = {}) => {
      if (url.endsWith("/version")) return Response.json({ routeLevel: ${ROUTE_LEVEL}, capabilities: ${JSON.stringify(SERVER_CAPABILITIES)} });
      if (options.headers.authorization !== "Bearer ${secret}") throw new Error("wrong credential");
      if (url.endsWith("/config")) return Response.json({ runner: "home:studio", tokenId: "id" });
      if (url.endsWith("/queue")) return Response.json([review]);
      if (url.endsWith("/runs")) return Response.json({}, { status: 201 });
      if (url === "https://one.test/api/projects/demo/items/t21/review-skip") {
        const body = JSON.parse(options.body);
        process.stderr.write("SKIP_REPORTED actor=" + options.headers["x-atelier-actor"] + " runner=" + options.headers["x-atelier-runner"] + " request=" + body.request + " head=" + body.head + "\\n");
        return Response.json({ skipped: true });
      }
      throw new Error("unexpected route " + url);
    };
    await import(${JSON.stringify(cli)});
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env });
  const out = result.stdout + result.stderr;
  assert.match(out, /SKIP_REPORTED actor=codex\/gpt-6-astra runner=home:studio request=3 head=a{40}/, out);
  assert.doesNotMatch(out, /actor=owner/);
  assert.match(out, /reported the review skip for demo\/t21/);
  assert.doesNotMatch(out, new RegExp(secret));
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
    globalThis.fetch = async (url, options) => {
      // token issue checks the server's capabilities first (t458).
      if (url === "https://one.test/api/version") return Response.json({ routeLevel: ${ROUTE_LEVEL}, capabilities: ${JSON.stringify(SERVER_CAPABILITIES)} });
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
      // token store checks the server's capabilities first (t458); the version needs no credential.
      if (url === "https://one.test/api/version") return Response.json({ routeLevel: ${ROUTE_LEVEL}, capabilities: ${JSON.stringify(SERVER_CAPABILITIES)} });
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
      if (url.endsWith("/version")) return Response.json({ routeLevel: ${ROUTE_LEVEL}, capabilities: ${JSON.stringify(SERVER_CAPABILITIES)} });
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

for (const backend of ["keychain", "secret-service"]) {
  test(`${backend}: only a missing entry allows owner fallback`, () => {
    const env = { ATELIER_SECRET_STORE: backend, ATELIER_TOKEN: "owner-secret" };
    const read = (answer) => runnerCredential("https://one.test", "studio", { env, spawn: () => answer });
    assert.equal(read({ status: backend === "keychain" ? 44 : 1, stdout: "", stderr: "" }), null);
    for (const stdout of ["", "\n", "  \n", "null", "42", "not json"]) {
      assert.throws(() => read({ status: 0, stdout }), /one line of text|not bound|no server binding/);
    }
    assert.throws(() => read({ status: 1, stdout: "", stderr: "store unavailable" }), /could not read/);
    assert.throws(() => read({ status: null, error: new Error("unavailable") }), /could not read/);
    assert.equal(read({ status: 0, stdout: JSON.stringify({ server: "https://one.test", token: "runner-secret" }) + "\n" }), "runner-secret");
  });
}

test("a malformed explicit runner environment value cannot read a store or select owner", () => {
  for (const value of ["", "  ", null, 42, false, {}]) {
    assert.throws(() => runnerCredential("https://one.test", "studio", {
      env: { ATELIER_RUNNER_TOKEN: value, ATELIER_TOKEN: "owner-secret" },
      read: () => assert.fail("explicit token must not read a store"),
    }), /ATELIER_RUNNER_TOKEN is (empty|malformed)/);
  }
  for (const value of ["a\nb", "a\u0000b", "a\tb", "a\u007fb"]) {
    assert.throws(() => runnerCredential("https://one.test", "studio", {
      env: { ATELIER_RUNNER_TOKEN: value, ATELIER_TOKEN: "owner-secret" },
      read: () => assert.fail("explicit token must not read a store"),
    }), /one line of text/);
  }
});
