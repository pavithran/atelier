// t665: a runner checks that a harness can run before it offers it. The
// finding it would have caught: on 2026-10-14 a fast take of ourai/t63 cloned
// main and then atelier-claude exited "Not logged in", after the claim.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harnessReady } from "./harness/adapter.mjs";
import { READY_RECHECK_MS, planFilePath, runRunner } from "./runner.mjs";

const root = mkdtempSync(join(tmpdir(), "atelier-signin-tests-"));
after(() => rmSync(root, { recursive: true, force: true }));

test("a signed-out Claude CLI, a probe that cannot run and a timeout are not ready; a signed-in one is", async () => {
  const home = mkdtempSync(join(root, "home-"));
  const ask = (run) => harnessReady("claude-code", { env: {}, home, run });
  assert.deepEqual(await ask(async () => ({ code: 0, stdout: '{"loggedIn": true}' })), { ready: true });
  for (const run of [
    async () => ({ code: 1, stdout: '{"loggedIn": false}' }),
    async () => ({ code: 0, stdout: "Not logged in" }),
    async () => { throw new Error("spawn claude ENOENT"); },
    async () => { throw Object.assign(new Error("timed out"), { killed: true }); },
  ]) {
    const answer = await ask(run);
    assert.equal(answer.ready, false);
    assert.match(answer.why, /claude auth login|setup-token/);
  }
  // Codex is ready only when `codex login status` exits 0 (t558); anything else, a missing binary and a timeout included, is not.
  let asked;
  assert.deepEqual(await harnessReady("codex", { env: { A: "1" }, run: async (_exe, args, o) => { asked = [args, o.env.A]; return { code: 0, stdout: "" }; } }), { ready: true });
  assert.deepEqual(asked, [["login", "status"], "1"]);
  for (const run of [async () => ({ code: 1, stdout: "" }), async () => { throw new Error("spawn codex ENOENT"); }, async () => { throw Object.assign(new Error("timed out"), { killed: true }); }]) {
    const answer = await harnessReady("codex", { run });
    assert.equal(answer.ready, false);
    assert.match(answer.why, /codex login/);
  }
  assert.deepEqual(await harnessReady("opencode", { run: async () => { throw new Error("never asked"); } }), { ready: true, state: "unknown" });
});

test("the key file counts only when the job's own wrapper loads it, and the job's environment decides the rest (the finding on 082d52b4)", async () => {
  const home = mkdtempSync(join(root, "home-"));
  mkdirSync(join(home, ".config", "api-keys"), { recursive: true });
  writeFileSync(join(home, ".config", "api-keys", "claude-code-auth.key"), "secret-token\n");
  const wrapper = join(home, "atelier-claude"), plain = join(home, "other");
  writeFileSync(wrapper, "#!/bin/zsh\nexport CLAUDE_CODE_OAUTH_TOKEN=\"$(cat $HOME/.config/api-keys/claude-code-auth.key)\"\n");
  writeFileSync(plain, "#!/bin/sh\n");
  // The probe signs in only with a token; whether it has one is what is asked.
  const run = async (_exe, _args, { env }) => ({ code: env.CLAUDE_CODE_OAUTH_TOKEN ? 0 : 1, stdout: JSON.stringify({ loggedIn: !!env.CLAUDE_CODE_OAUTH_TOKEN }) });
  const ask = (env, command) => harnessReady("claude-code", { env, command, home, run });
  // The wrapper loads the file: the job has the token, so the probe does.
  assert.deepEqual(await ask({}, [wrapper, "{model}"]), { ready: true });
  // The shipped Node adapter and a command that never mentions the file do not: the
  // job would run without the token, so the probe must too, whatever the
  // runner's own environment holds.
  assert.equal((await ask({}, [process.execPath, "bin/harness/atelier-claude.mjs"])).ready, false);
  assert.equal((await ask({}, [plain])).ready, false);
  assert.equal((await ask({}, undefined)).ready, false);
  // The token is never in the answer.
  assert.doesNotMatch(JSON.stringify(await ask({}, [plain])), /secret-token/);
});

test("a runner leaves a signed-out harness out of its offer, says why once, and offers it again when it is ready", async () => {
  const dir = mkdtempSync(join(root, "run-"));
  const config = join(dir, "runner.json");
  writeFileSync(config, JSON.stringify({ agents: [
    { agent: "claude-code", models: ["sonnet-5.5"], command: ["/x/atelier-claude", "{model}", "{brief_file}"] },
    { agent: "opencode", models: ["glm-5.3"], command: ["stub", "{model}", "{brief_file}"] },
  ] }));
  const logs = [], offers = [];
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "runner-only-token";
  after(() => { delete process.env.CLAUDE_CODE_OAUTH_TOKEN; });
  let clock = 1_000_000, signedIn = false, asked = 0, polls = 0;
  await runRunner({ _: ["runner"], multi: {}, name: "home:studio", config }, {
    now: () => clock, limitFile: join(dir, "limits.json"),
    taskIO: { log: (line) => logs.push(line) },
    harnessReady: async (harness, job) => { asked++; assert.ok(job.env && !("CLAUDE_CODE_OAUTH_TOKEN" in job.env), "the probe gets the job's filtered environment"); assert.ok(job.command.length); assert.equal(harness, "claude-code", "the developer's own command is not probed"); return signedIn ? { ready: true } : { ready: false, why: "the Claude CLI is not signed in; run `claude auth login`" }; },
    wait: () => Promise.resolve(),
    async queue(offer) {
      offers.push(offer.agents.map((a) => a.agent));
      polls++;
      if (polls === 2) clock += 1;                     // inside the recheck interval: not asked again
      if (polls === 3) { clock += READY_RECHECK_MS; signedIn = true; }
      if (polls === 4) { clock += READY_RECHECK_MS; }
      if (polls >= 4) process.emit("SIGTERM");
      return [];
    },
  });
  assert.deepEqual(offers.slice(0, 3), [["opencode"], ["opencode"], ["opencode"]]);
  assert.deepEqual(offers[3], ["claude-code", "opencode"]);
  assert.equal(asked, 2);
  assert.equal(logs.filter((l) => /claude-code is not offered: the Claude CLI is not signed in; run `claude auth login`/.test(l)).length, 1);
  assert.equal(logs.filter((l) => /claude-code is ready again/.test(l)).length, 1);
});

// t558: a review of codex/gpt-6-astra on ikon-weblog t33 was claimed again
// at every lease by a runner that could not serve it. A task the queue still
// lists for a harness the readiness check dropped is not taken, review or not.
test("a runner takes no review for a harness it found not ready, even when the queue lists one", async () => {
  const dir = mkdtempSync(join(root, "run-"));
  const config = join(dir, "runner.json");
  writeFileSync(config, JSON.stringify({ agents: [{ agent: "claude-code", models: ["sonnet-5.5"], command: ["/x/atelier-claude", "{model}", "{brief_file}", "{verdict_file}"] }, { agent: "opencode", models: ["glm-5.3"], command: ["stub", "{model}", "{brief_file}", "{verdict_file}"] }], jobs: ["review"] }));
  const logs = [], skips = [];
  let polls = 0;
  const review = { project: "atelier", agent: "claude-code", model: "sonnet-5.5", actor: "claude-code/sonnet-5.5", item: { id: "t9", title: "x", head: "a".repeat(40), request: 7, dispatch: { to: "home", agent: "claude-code", model: "sonnet-5.5", job: "review", by: "owner", at: "2026-10-12T19:00:00.000Z", note: "" } } };
  await runRunner({ _: ["runner"], multi: {}, name: "home:studio", config }, {
    now: () => 1_000_000, limitFile: join(dir, "limits.json"),
    taskIO: { log: (line) => logs.push(line), cli: async (argv) => { logs.push(`cli ${argv[0]}`); return "{}"; } },
    harnessReady: async () => ({ ready: false, why: "the Claude CLI is not signed in" }),
    reportReviewSkip: async (body) => { skips.push(body); },
    wait: () => Promise.resolve(),
    async queue() { if (++polls > 1) process.emit("SIGTERM"); return [review]; },
  });
  assert.equal(logs.some((l) => /^cli review-claim/.test(l)), false, "no claim was made");
  assert.deepEqual(skips, [], "and nothing was skipped or reported");
});

// t558: Codex signed out (`codex login status` exits 1): the runner takes no codex review.
test("a runner takes no codex review while codex login status fails", async () => {
  const dir = mkdtempSync(join(root, "run-"));
  const config = join(dir, "runner.json");
  writeFileSync(config, JSON.stringify({ agents: [{ agent: "codex", models: ["gpt-6-astra"], command: ["/x/atelier-codex", "{model}", "{brief_file}", "{verdict_file}"] }, { agent: "opencode", models: ["glm-5.3"], command: ["stub", "{model}", "{brief_file}", "{verdict_file}"] }], jobs: ["review"] }));
  const logs = [], skips = [], offers = [];
  let polls = 0;
  const review = { project: "atelier", agent: "codex", model: "gpt-6-astra", actor: "codex/gpt-6-astra", item: { id: "t9", title: "x", head: "a".repeat(40), request: 7, dispatch: { to: "home", agent: "codex", model: "gpt-6-astra", job: "review", by: "owner", at: "2026-10-12T19:00:00.000Z", note: "" } } };
  await runRunner({ _: ["runner"], multi: {}, name: "home:studio", config }, {
    now: () => 1_000_000, limitFile: join(dir, "limits.json"),
    taskIO: { log: (line) => logs.push(line), cli: async (argv) => { logs.push(`cli ${argv[0]}`); return "{}"; } },
    harnessReady: (harness, job) => harnessReady(harness, { ...job, run: async () => ({ code: 1, stdout: "" }) }),
    reportReviewSkip: async (body) => { skips.push(body); },
    wait: () => Promise.resolve(),
    async queue(offer) { offers.push(offer.agents.length); if (++polls > 1) process.emit("SIGTERM"); return [review]; },
  });
  assert.equal(offers[0], 1, "codex is left out of the offer");
  assert.ok(logs.some((l) => /codex is not offered: Codex is not signed in/.test(l)));
  assert.equal(logs.some((l) => /^cli review-claim/.test(l)), false);
  assert.deepEqual(skips, []);
});

// t195: Antigravity is probed too, and its answer is signed-in, signed-out or unknown.
test("Antigravity reports signed-in, signed-out or unknown; a network error or timeout is unknown", async () => {
  const ask = (run) => harnessReady("antigravity", { env: {}, run });
  assert.deepEqual(await ask(async (_exe, args) => { assert.deepEqual(args, ["models"]); return { code: 0, stdout: "gemini-4-argon-medium\tGemini 4\n", stderr: "" }; }), { ready: true, state: "signed-in" });
  const out = await ask(async () => ({ code: 1, stdout: "", stderr: "Error: not signed in, run agy to log in" }));
  assert.equal(out.state, "signed-out");
  assert.equal(out.ready, false);
  for (const run of [
    async () => ({ code: 1, stdout: "", stderr: "dial tcp: lookup example: no such host (could not authenticate)" }),
    async () => ({ code: 0, stdout: "", stderr: "" }),
    async () => { throw Object.assign(new Error("timed out"), { killed: true }); },
  ]) {
    const answer = await ask(run);
    assert.equal(answer.state, "unknown");
    assert.equal(answer.ready, false);
  }
  // The findings on 11c38ef7: output that is not a model list, and a network
  // error that exits 0, are unknown, never signed-in.
  for (const stdout of ["Usage: agy models [options]\n", "Network error: offline\n", "Error: could not reach the service\n", "Loading...\n"]) {
    const answer = await ask(async () => ({ code: 0, stdout, stderr: "" }));
    assert.equal(answer.state, "unknown", stdout);
    assert.equal(answer.ready, false, stdout);
  }
  const offline = await ask(async () => ({ code: 0, stdout: "gemini-4-argon-medium\n", stderr: "dial tcp: no such host" }));
  assert.deepEqual([offline.ready, offline.state], [false, "unknown"]);
  assert.equal((await ask(async () => ({ code: 0, stdout: "- claude-opus-5-5-high  Claude Opus\n- gemini-3.1-pro-high\n", stderr: "" }))).state, "signed-in");
  // A custom wrapper has no probe: unknown, and still offered.
  assert.deepEqual(await harnessReady("opencode", {}), { ready: true, state: "unknown" });
});

test("a runner whose every harness is not ready refuses to start", async () => {
  const dir = mkdtempSync(join(root, "run-"));
  const config = join(dir, "runner.json");
  writeFileSync(config, JSON.stringify({ agents: [{ agent: "antigravity", models: ["gemini-4-argon-medium"], command: ["/x/atelier-agy", "{model}", "{brief_file}"] }] }));
  await assert.rejects(runRunner({ _: ["runner"], multi: {}, name: "home:studio", config }, {
    limitFile: join(dir, "limits.json"), taskIO: { log() {} }, wait: () => Promise.resolve(),
    harnessReady: async () => ({ ready: false, state: "unknown", why: "no network" }),
    async queue() { assert.fail("polled"); },
  }), /no harness is ready.*antigravity: no network/);
});

test("the readiness check runs on the heartbeat during a long job, so a harness that fails mid-job is withdrawn", async (t) => {
  const dir = mkdtempSync(join(root, "run-")), workspace = join(dir, "work");
  mkdirSync(workspace);
  const config = join(dir, "runner.json");
  writeFileSync(config, JSON.stringify({ agents: [
    { agent: "claude-code", models: ["m1"], command: ["/x/atelier-claude", "{model}", "{brief_file}", "{workspace}", "{plan_file}"] },
    { agent: "codex", models: ["c1"], command: ["/x/atelier-codex", "{model}", "{brief_file}"] },
  ], jobs: ["build", "plan"] }));
  const previous = Object.fromEntries(["ATELIER_CONFIG_DIR", "ATELIER_SECRET_STORE"].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { ATELIER_CONFIG_DIR: dir, ATELIER_SECRET_STORE: "file" });
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const assignment = { project: "demo", actor: "claude-code/m1", agent: "claude-code", model: "m1", item: { id: "t1", title: "Change", scope: ["src/**"], accept: ["works"], kind: "plan", dispatch: { job: "plan" } } };
  const logs = [];
  let clock = 1_000_000, probes = 0, headReads = 0;
  let sawProbe; const probed = new Promise((resolve) => { sawProbe = resolve; });
  await runRunner({ _: ["runner"], multi: {}, name: "home:studio", config, once: true }, {
    now: () => clock, limitFile: join(dir, "limits.json"), credential: "runner-secret", workspacePath: () => workspace, heartbeatMs: 10,
    queue: async () => [assignment],
    harnessReady: async (harness) => {
      if (harness !== "codex") return { ready: true };
      if (++probes === 1) return { ready: true };
      sawProbe();
      return { ready: false, why: "Codex is not signed in" };
    },
    jobBrief: async () => ({ text: "Plan the change" }),
    postPlan: async () => ({ valid: true, hash: "plan-hash" }),
    taskIO: { log: (line) => logs.push(line), reset: async () => {}, head: async () => ++headReads === 1 ? "before" : "after", dataHome: async () => null, identityRefusals: async () => [] },
    executeChild: async (argv) => {
      if (/atelier-claude/.test(argv[0])) {
        clock += READY_RECHECK_MS;                     // ten minutes pass inside the job
        await Promise.race([probed, new Promise((resolve) => setTimeout(resolve, 30_000))]);
        writeFileSync(planFilePath(workspace), JSON.stringify({ goal: "Change" }));
      }
      return { code: 0, output: "", stderr: "" };
    },
  });
  assert.equal(probes, 2, "codex was probed again while the job ran");
  assert.equal(logs.filter((l) => /codex is not offered: Codex is not signed in/.test(l)).length, 1);
});
