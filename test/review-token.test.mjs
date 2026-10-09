import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execute, readAgentToken, reviewToken, runReview, runRunner, tokenFile } from "../cli/runner.mjs";
import { parseConfig } from "../cli/runner-config.mjs";

// t346: a runner records each review with the reviewing model's own agent
// token, never the owner token it holds for its builds, so the ledger shows
// the reviewer itself as the recorder. The runner config's `tokens` names,
// per model, where that token is stored; a model without one is refused,
// naming the token to store, unless the config opts into the owner-recorded
// path for the migration. The token goes only into the environment of the
// CLI calls of that review job: never into the harness's, a log or an argument.

const H0 = "0".repeat(40), H1 = "a".repeat(40);
const model = "glm-5.3", actor = `opencode/${model}`;
const FAKE = "atl_" + "f".repeat(64);
const command = ["opencode", "run", "--model", "{model}", "--file", "{brief_file}", "--diff", "{diff_file}", "--verdict", "{verdict_file}"];
const agents = [{ agent: "opencode", models: [model], command, env: ["ZAI_API_KEY"] }];
const assignment = { project: "atelier", item: { id: "t21", dispatch: { job: "review" } }, agent: "opencode", model, actor };
const claimed = {
  item: { id: "t21", title: "Review rules", base: H0, scope: ["src/review/**"], fork: "p--t21", head: H1 },
  head: H1,
  need: { needed: true, reason: "every part is reviewed", head: H1, kind: "review", basis: "part", changeClass: "coordinated", changedPaths: ["src/review/needed.ts"], outOfScope: [], checks: [], round: 1, previous: [], previousReviewer: null, lapsed: [] },
  plan: null, events: [], owner: "owner",
  readToken: { remote: "https://artifacts.example/p--t21", token: "read-token", defaultBranch: "main" },
  target: { remote: "https://artifacts.example/p", token: "base-token", branch: "main" },
};

function fixture(options = {}) {
  const calls = [], logs = [];
  const io = {
    log: (s) => logs.push(s), stopped: () => false,
    env: { ZAI_API_KEY: "provider-key" }, ownerTokens: () => ["atl_owner"],
    readSecret: (name) => { calls.push({ readSecret: name }); return options.stored === undefined ? FAKE : options.stored; },
    workspacePath: (project, id) => `/cache/work/${project}/${id}`,
    async cli(argv, cwd, opts) {
      calls.push({ argv, cwd, opts });
      if (argv[0] === "review-claim") return JSON.stringify(claimed);
      if (argv[0] === "base-token") return JSON.stringify({ remote: "https://artifacts.example/p", token: "base-token" });
      return "{}";
    },
    async clone(remote, t, dir) { calls.push({ clone: [remote, t, dir] }); },
    async fetch(dir, remote, t, head) { calls.push({ fetch: [dir, remote, t, head] }); },
    async mergeBase() { return H0; },
    async parents() { return `${H1} ${H0}`; },
    async diff() { return "diff --git a/src/review/needed.ts b/src/review/needed.ts\n+export const x = 1;\n"; },
    async brief(workspace, text) { calls.push({ brief: text, workspace }); return { file: "/cache/work/atelier/brief.txt" }; },
    async writeDiff(workspace, text) { calls.push({ writeDiff: text }); return { file: "/cache/work/atelier/diff.txt" }; },
    verdictPath: () => "/cache/work/atelier/verdict.txt",
    readVerdict: () => "VERDICT: APPROVE\nSUMMARY: Checked the diff.",
    async harness(argv, cwd, env) { calls.push({ harness: argv, cwd, env }); return { code: 0, timedOut: false }; },
    async removeBrief() {}, removeDiff: () => {},
    async dataHome(workspace) { return { dir: `${workspace}-opencode-data` }; },
    async removeDataHome() {},
  };
  return { io, calls, logs };
}

const cliCalls = (calls) => calls.filter((c) => c.argv);
// Everything the runner could have shown: its log lines, every argument of
// every call, and the harness's environment.
const everything = (calls, logs) => JSON.stringify({ calls, logs });

test("parseConfig takes tokens as a Keychain entry name or a file under the config directory, never the token itself", () => {
  const ok = parseConfig({ agents, jobs: ["review"], tokens: { [model]: "agent.glm-5.3", "gpt-6-astra": "tokens/gpt-6-astra", "gemini-3.1-pro": "~/.config/atelier/tokens/gemini" } });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.tokens, { [model]: "agent.glm-5.3", "gpt-6-astra": "tokens/gpt-6-astra", "gemini-3.1-pro": "~/.config/atelier/tokens/gemini" });
  assert.equal("tokens" in parseConfig({ agents }), false);
  for (const tokens of [[], "agent.glm", { "bad model": "agent.glm" }, { [model]: FAKE }, { [model]: "atl_abc" }, { [model]: "" }, { [model]: "/etc/passwd" }, { [model]: "../outside" }, { [model]: "~/.ssh/id_ed25519" }, { [model]: 7 }]) {
    const result = parseConfig({ agents, tokens });
    assert.ok(result.errors.length, JSON.stringify(tokens));
    assert.ok(!result.errors.join(" ").includes(FAKE), "a refused value is not echoed");
  }
  // The owner-recorded fallback is gone: a config that still opts in is
  // refused, whatever the value, and the refusal says where the tokens go.
  for (const value of [true, false, "yes"]) {
    const stale = parseConfig({ agents, jobs: ["review"], tokens: { [model]: "agent.glm-5.3" }, ownerRecordsReviews: value });
    assert.match(stale.errors.join(" "), /ownerRecordsReviews was removed: a review is recorded only by the reviewer's own agent token.*tokens.*docs\/runners\.md.*take the option out/, JSON.stringify(value));
    assert.equal("ownerRecordsReviews" in stale, false);
  }
});

test("a token file resolves under the Atelier config directory, is read by its first line, and must be the user's alone", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-token-file-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ATELIER_CONFIG_DIR: dir };
  assert.equal(tokenFile("tokens/glm", env), resolve(dir, "tokens/glm"));
  assert.equal(tokenFile("~/.config/atelier/tokens/glm", env), resolve(dir, "tokens/glm"));
  assert.equal(tokenFile("tokens/glm", {}, "/home/u"), resolve("/home/u/.config/atelier/tokens/glm"));
  assert.equal(readAgentToken("tokens/glm", { env }), null, "no file yet");
  mkdirSync(join(dir, "tokens"), { recursive: true });
  writeFileSync(join(dir, "tokens/glm"), `${FAKE}\nsecond line ignored\n`, { mode: 0o600 });
  assert.equal(readAgentToken("tokens/glm", { env }), FAKE);
  assert.equal(readAgentToken("~/.config/atelier/tokens/glm", { env }), FAKE);
  if (process.platform !== "win32") {
    chmodSync(join(dir, "tokens/glm"), 0o644);
    assert.throws(() => readAgentToken("tokens/glm", { env }), /readable by other users/);
  }
  // A Keychain entry is read by its exact name through the credentials store.
  const names = [];
  assert.equal(readAgentToken("agent.glm", { env, readSecret: (name) => { names.push(name); return FAKE; } }), FAKE);
  assert.deepEqual(names, ["agent.glm"]);
});

test("reviewToken refuses a model the config names no token for, naming the entry to add, and never answers with the owner token", () => {
  const refused = reviewToken({ agents }, model, actor);
  assert.match(refused.refused, /no agent token for opencode\/glm-5\.3/);
  assert.match(refused.refused, /tokens\["glm-5\.3"\]/);
  assert.match(refused.refused, /atelier token issue --as opencode\/glm-5\.3/);
  assert.match(refused.refused, /never the owner's/);
  assert.ok(!refused.refused.includes("ownerRecordsReviews"), "the refusal names no opt-in; there is none");
  assert.equal("owner" in refused, false);
  // A stale opt-in that got past parseConfig changes nothing: still refused.
  assert.match(reviewToken({ agents, ownerRecordsReviews: true }, model, actor).refused, /no agent token for opencode\/glm-5\.3/);
  // A named entry that holds nothing is missing, and the refusal names it.
  const empty = reviewToken({ agents, tokens: { [model]: "agent.glm" } }, model, actor, { readSecret: () => null });
  assert.match(empty.refused, /the agent token for opencode\/glm-5\.3 is missing: the Keychain entry agent\.glm holds none/);
  const noFile = reviewToken({ agents, tokens: { [model]: "tokens/glm" } }, model, actor, { env: { ATELIER_CONFIG_DIR: join(tmpdir(), "atelier-no-such-dir") } });
  assert.match(noFile.refused, /is missing: the file tokens\/glm holds none/);
  // A store that cannot be read is a refusal too, never an owner-recorded review.
  const broken = reviewToken({ agents, tokens: { [model]: "agent.glm" } }, model, actor, { readSecret: () => { throw new Error("security exited 44"); } });
  assert.match(broken.refused, /could not be read from agent\.glm: security exited 44/);
  assert.deepEqual(reviewToken({ agents, tokens: { [model]: "agent.glm" } }, model, actor, { readSecret: () => FAKE }), { token: FAKE });
});

test("a review job makes every CLI call with the model's own token, and the token reaches nothing else", async () => {
  const { io, calls, logs } = fixture();
  const state = await runReview(assignment, { agents, tokens: { [model]: "agent.glm" } }, "home:studio", io);
  assert.equal(state.phase, "reviewed");
  const made = cliCalls(calls);
  assert.deepEqual(made.map((c) => c.argv[0]), ["review-claim", "review"]);
  for (const c of made) assert.deepEqual(c.opts, { token: FAKE }, `${c.argv[0]} authenticates as the reviewer`);
  assert.ok(made.every((c) => c.argv.includes("--as") && c.argv[c.argv.indexOf("--as") + 1] === actor), "every call names the reviewer, which the agent token binds it to");
  assert.deepEqual(calls.filter((c) => c.readSecret), [{ readSecret: "agent.glm" }], "the token is read once, by its exact name, for this job alone");
  // The harness gets its provider key, never the agent token or the owner's.
  const harness = calls.find((c) => c.harness);
  assert.equal(harness.env.ZAI_API_KEY, "provider-key");
  assert.ok(!Object.values(harness.env).some((v) => String(v).includes(FAKE) || String(v).includes("atl_owner")));
  assert.ok(!Object.keys(harness.env).some((k) => /^ATELIER_/i.test(k)));
  // Nothing printed, logged or passed as an argument holds the token.
  const shown = everything(calls.map(({ opts, ...rest }) => rest), logs);
  assert.ok(!shown.includes(FAKE), "the token value appears nowhere but the call's own credential");
  assert.ok(!logs.some((l) => /owner token/.test(l)), logs.join("\n"));
});

test("a release after a failure is made with the same token as the claim", async () => {
  const { io, calls } = fixture();
  io.readVerdict = () => "Looks fine.";
  const state = await runReview(assignment, { agents, tokens: { [model]: "agent.glm" } }, "home:studio", io);
  assert.equal(state.phase, "failed");
  const release = cliCalls(calls).find((c) => c.argv[0] === "review-release");
  assert.ok(release, "the request is released");
  assert.deepEqual(release.opts, { token: FAKE });
});

test("a runner without a token for a model refuses that model's review jobs, before any claim, and names the token", async () => {
  for (const [config, pattern] of [
    [{ agents }, /no agent token for opencode\/glm-5\.3: the runner config names none under tokens\["glm-5\.3"\]/],
    [{ agents, tokens: { [model]: "agent.glm" } }, /is missing: the Keychain entry agent\.glm holds none/],
  ]) {
    const { io, calls, logs } = fixture({ stored: null });
    const state = await runReview(assignment, config, "home:studio", io);
    assert.equal(state.phase, "failed");
    assert.equal(state.skipped, true, "refused for this process, not retried every poll");
    assert.match(state.reason, pattern);
    assert.deepEqual(cliCalls(calls), [], "no request is claimed that the runner could not answer as the reviewer");
    assert.ok(!calls.some((c) => c.harness), "no harness runs");
    assert.ok(logs.some((l) => pattern.test(l)), "the refusal is logged with the token's name");
  }
});

test("a stale ownerRecordsReviews opt-in buys no owner-recorded review: the job is refused like any other without a token", async () => {
  const { io, calls, logs } = fixture();
  const state = await runReview(assignment, { agents, ownerRecordsReviews: true }, "home:studio", io);
  assert.equal(state.phase, "failed");
  assert.equal(state.skipped, true);
  assert.match(state.reason, /no agent token for opencode\/glm-5\.3: the runner config names none under tokens\["glm-5\.3"\]/);
  assert.deepEqual(cliCalls(calls), [], "no call is made with the runner's own (owner) credentials");
  assert.ok(!calls.some((c) => c.harness), "no harness runs");
  assert.ok(!logs.some((l) => /owner token \(ownerRecordsReviews\)|the owner recorded this review/.test(l)), logs.join("\n"));
  // A model that has a token uses it, whatever else the config carries.
  const both = fixture();
  const reviewed = await runReview(assignment, { agents, tokens: { [model]: "agent.glm" }, ownerRecordsReviews: true }, "home:studio", both.io);
  assert.equal(reviewed.phase, "reviewed");
  for (const c of cliCalls(both.calls)) assert.deepEqual(c.opts, { token: FAKE });
});

// The real CLI helper (runRunner's io.cli) hands the token to the CLI as
// ATELIER_TOKEN in the child's environment and nowhere else, and the CLI
// sends it as the Authorization header of each review call: proved end to
// end against a server of the test's own, with git and the harness stubbed.
test("the review calls reach the server with the model's token in their Authorization header, not the owner's", { timeout: 60_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-review-token-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      requests.push({ method: req.method, path: req.url, authorization: req.headers.authorization, actor: req.headers["x-atelier-actor"], runner: req.headers["x-atelier-runner"] });
      const answer = req.url === "/api/config" ? { ownerActor: "owner", ownerName: "The owner", actor }
        : req.url.endsWith("/review-claim") ? claimed
        : req.url.endsWith("/base-token") ? { remote: "https://artifacts.example/p", token: "base-token", defaultBranch: "main" }
        : req.method === "GET" ? { item: { id: "t21", head: H1 }, reviews: [], evidence: [], events: [], ownerActor: "owner" }
        : { ok: true };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  // The runner's own environment, as a LaunchAgent would set it: the owner's
  // token, and the test server in place of atelier.zone.
  const saved = { ...process.env };
  t.after(() => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); });
  delete process.env.ATELIER_ACTOR;
  Object.assign(process.env, { ATELIER_TOKEN: "atl_owner_" + "0".repeat(60), ATELIER_SERVER: origin, ATELIER_CONFIG_DIR: dir, ATELIER_SECRET_STORE: "file", ATELIER_OWNER: "owner" });
  const path = join(dir, "runner.json");
  writeFileSync(path, JSON.stringify({ agents: [{ agent: "opencode", models: [model], command: ["reviewer", "{model}", "{brief_file}", "{diff_file}", "{verdict_file}"] }], jobs: ["review"], tokens: { [model]: "tokens/glm" } }));
  mkdirSync(join(dir, "tokens"));
  writeFileSync(join(dir, "tokens/glm"), `${FAKE}\n`, { mode: 0o600 });
  const { io } = fixture();
  const { cli, stopped, env, readSecret, ...taskIO } = io;
  const previous = process.exitCode;
  t.after(() => { process.exitCode = previous; });
  const harnessEnvs = [], children = [];
  await runRunner({ _: ["runner"], multi: {}, name: "home:studio", config: path, once: true }, {
    workspacePath: () => join(dir, "t21"), wait: async () => {}, queue: async () => [assignment],
    taskIO: { ...taskIO, async harness(argv, cwd, harnessEnv) { harnessEnvs.push(harnessEnv); return { code: 0 }; } },
    async executeChild(argv, options) {
      if (argv[0] === "git") return { code: 0, output: argv[1] === "merge-base" ? H0 : argv[1] === "rev-list" ? `${H1} ${H0}` : "" };
      children.push({ argv, env: options.env });
      return execute(argv, options);
    },
  });
  assert.equal(process.exitCode, previous, "the review ran to its end");
  const review = requests.filter((r) => r.path !== "/api/config");
  assert.deepEqual(review.map((r) => [r.method, r.path]), [
    ["POST", "/api/projects/atelier/items/t21/review-claim"],
    ["GET", "/api/projects/atelier/items/t21"],
    ["POST", "/api/projects/atelier/items/t21/review"],
  ]);
  for (const r of requests) assert.equal(r.authorization, `Bearer ${FAKE}`, `${r.method} ${r.path} carries the reviewer's token`);
  for (const r of review) assert.equal(r.actor, actor, `${r.method} ${r.path} is made as the reviewer the token binds`);
  assert.equal(review[0].runner, "home:studio");
  assert.ok(!requests.some((r) => r.authorization.includes("atl_owner")), "the owner token is sent on no review call");
  // The CLI got the token through its environment alone: no argument holds it.
  for (const child of children) {
    assert.equal(child.env.ATELIER_TOKEN, FAKE);
    assert.ok(!child.argv.some((a) => a.includes(FAKE)));
  }
  assert.equal(harnessEnvs.length, 1);
  assert.ok(!JSON.stringify(harnessEnvs[0]).includes(FAKE), "the harness never sees the token");
});
