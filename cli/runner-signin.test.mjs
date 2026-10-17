// t665: a runner checks that a harness can run before it offers it. The
// finding it would have caught: on 2026-10-14 a fast take of ourai/t63 cloned
// main and then atelier-claude exited "Not logged in", after the claim.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harnessReady } from "./harness/adapter.mjs";
import { READY_RECHECK_MS, runRunner } from "./runner.mjs";

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
  assert.deepEqual(await harnessReady("codex", { run: async () => { throw new Error("never asked"); } }), { ready: true });
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
