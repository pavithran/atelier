import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { addressRefusal, builderRefusals, commitRefusals, emailProblem, IDENTITY_LOG_FORMAT, isPublicMirror, parseIdentityLog, publicRefusals, settleCommitIdentity } from "../src/commit-identity.ts";
import { identityRefusals, IDENTITY_FILE, resolveIdentity, runTask } from "../cli/runner.mjs";
import { identityEnv, identityRangeRefusals } from "../cli/atelier.mjs";

// The project's commit identity (t451): what the policy holds, what a claim
// writes into a workspace, what a runner checks before a builder starts, and
// what a landing checks before the baseline takes its commits.

const OWNER = { name: "Project Owner", email: "123+owner@users.noreply.github.com" };
const AGENT = "agents@atelier.example";
const POLICY = { ...OWNER, agentEmails: [AGENT], privateEmails: ["owner@personal.example"] };

const cli = resolve("cli/atelier.mjs");
const run = (cwd, args, env) => execFileSync("git", args, { cwd, encoding: "utf8", env }).trim();

// A Git environment with no global or system identity: nothing the machine
// running the tests sets reaches it, as on a fresh machine.
function bareEnv(root) {
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "gitconfig"), "");
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_|^EMAIL$/.test(k)));
  return { ...env, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(home, "gitconfig") };
}

function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "atelier-commit-identity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

// ── policy ─────────────────────────────────────────────────────────────────

test("the policy takes a validated name and address, explicit agent addresses and declared private ones", () => {
  const settled = settleCommitIdentity({ commitName: " Project Owner ", commitEmail: OWNER.email, agentEmails: [AGENT, "AGENTS@atelier.example", ""], privateEmails: ["owner@personal.example"] }, undefined);
  assert.deepEqual(settled, POLICY, "trimmed, a repeat kept once whatever its case, a blank entry dropped");
  // A later init changes only what it names.
  assert.deepEqual(settleCommitIdentity({ agentEmails: [] }, settled), { ...POLICY, agentEmails: [] });
  assert.equal(settleCommitIdentity({}, settled), settled);
  assert.equal(settleCommitIdentity({}, undefined), undefined, "a project from before t451 names none until the owner does");
});

test("an invalid policy is refused, naming the field to fix", () => {
  const refused = (init, current, pattern) => assert.throws(() => settleCommitIdentity(init, current), (e) => e.code === "bad_identity" && pattern.test(e.detail), JSON.stringify(init));
  refused({ commitEmail: OWNER.email }, undefined, /needs both a name and an address: give commitName \(atelier init --commit-name NAME\)/);
  refused({ commitName: "Owner" }, undefined, /give commitEmail \(atelier init --commit-email EMAIL\)/);
  refused({ commitName: "", commitEmail: OWNER.email }, undefined, /commitName must be/);
  refused({ commitName: "A <b>", commitEmail: OWNER.email }, undefined, /no angle brackets/);
  refused({ commitName: "Owner", commitEmail: "not an address" }, undefined, /commitEmail "not an address" is not an email address/);
  refused({ commitName: "Owner", commitEmail: "pavi@studio.local" }, undefined, /commitEmail "pavi@studio.local" is one Git guesses/);
  refused({ commitName: "Owner", commitEmail: "pavi@mbp.(none)" }, undefined, /one Git guesses/);
  refused({ agentEmails: ["bot@localhost"] }, POLICY, /agentEmails "bot@localhost"/);
  refused({ agentEmails: "x" }, POLICY, /agentEmails "x" is not an email address/);
  refused({ agentEmails: 3 }, POLICY, /agentEmails must be a list/);
  refused({ privateEmails: [OWNER.email] }, POLICY, /commitEmail 123\+owner@users\.noreply\.github\.com is declared private/);
  refused({ privateEmails: [AGENT] }, POLICY, /agentEmails agents@atelier\.example is declared private/);
  refused({ publicMirrors: ["--upload-pack=x"] }, POLICY, /publicMirrors "--upload-pack=x" is not a remote name/);
  refused({ publicMirrors: ["git@github.com:o/r.git"] }, POLICY, /is not a remote name/);
  refused({ publicMirrors: 3 }, POLICY, /publicMirrors must be a list of remote names/);
  // A public mirror would publish the project's address: it must be a no-reply one.
  refused({ publicMirrors: ["github"] }, { ...POLICY, email: "owner@studio.example" }, /commitEmail owner@studio\.example is not a GitHub no-reply address .* publicMirrors github would publish it/);
  refused({ commitEmail: "owner@studio.example" }, { ...POLICY, publicMirrors: ["github"] }, /is not a GitHub no-reply address/);
});

test("the policy declares which remotes are public mirrors, kept on a later init and cleared by an empty list", () => {
  const mirrored = settleCommitIdentity({ publicMirrors: ["github", " github ", "", "codeberg"] }, POLICY);
  assert.deepEqual(mirrored, { ...POLICY, publicMirrors: ["github", "codeberg"] });
  assert.deepEqual(settleCommitIdentity({ agentEmails: [] }, mirrored).publicMirrors, ["github", "codeberg"]);
  assert.deepEqual(settleCommitIdentity({ publicMirrors: [] }, mirrored), POLICY);
});

test("an address is refused when missing, guessed, declared private or outside the policy", () => {
  assert.equal(emailProblem(null), "is not set");
  assert.match(emailProblem("me@macbook"), /guesses/);
  assert.equal(addressRefusal(POLICY, OWNER.email), null);
  assert.equal(addressRefusal(POLICY, AGENT.toUpperCase()), null, "addresses compare without regard to case");
  assert.match(addressRefusal(POLICY, "owner@personal.example"), /declared private in the project's policy \(privateEmails\)/);
  assert.match(addressRefusal(POLICY, "someone@else.example"), /neither the project's commit address \(123\+owner@users\.noreply\.github\.com\) nor an agent address the policy allows \(agentEmails\)/);
});

// ── a builder's effective identity ────────────────────────────────────────

function workspace(t) {
  const root = tempRoot(t), dir = join(root, "ws"), env = bareEnv(root);
  execFileSync("git", ["init", "-q", dir], { env });
  writeFileSync(join(dir, ".git", IDENTITY_FILE), JSON.stringify(POLICY));
  return { dir, env };
}

test("with no global identity and nothing written, a builder is refused for Git's guess, naming the setting", (t) => {
  const { dir, env } = workspace(t);
  const resolved = resolveIdentity(dir, env);
  assert.equal(resolved.author.email, null, "a guessed address reads as missing");
  assert.equal(resolved.author.name, null);
  const refused = identityRefusals(dir, env, "demo");
  assert.ok(refused.some((r) => /^the author email is not set; set user\.email in the workspace's \.git\/config \(atelier claim sets it from the project's policy\) to 123\+owner@users\.noreply\.github\.com$/.test(r)), refused.join("\n"));
  assert.ok(refused.some((r) => /^the committer name is not set, so Git would guess one; set user\.name/.test(r)), refused.join("\n"));
});

test("the claim's local identity passes; a conflicting environment value is refused, naming its variable", (t) => {
  const { dir, env } = workspace(t);
  run(dir, ["config", "--local", "user.name", OWNER.name], env);
  run(dir, ["config", "--local", "user.email", OWNER.email], env);
  assert.deepEqual(identityRefusals(dir, env, "demo"), []);
  // An agent address the policy allows passes from the environment too.
  assert.deepEqual(identityRefusals(dir, { ...env, GIT_AUTHOR_EMAIL: AGENT }, "demo"), []);
  // The environment wins over the config, as it does for Git.
  const refused = identityRefusals(dir, { ...env, GIT_AUTHOR_EMAIL: "me@personal.example", GIT_COMMITTER_EMAIL: "owner@personal.example" }, "demo");
  assert.deepEqual(refused, [
    "the author email me@personal.example is neither the project's commit address (123+owner@users.noreply.github.com) nor an agent address the policy allows (agentEmails); fix GIT_AUTHOR_EMAIL in the environment",
    "the committer email owner@personal.example is declared private in the project's policy (privateEmails); fix GIT_COMMITTER_EMAIL in the environment",
  ]);
  // A name Git refuses to use (only spaces) is refused with Git's reason, not
  // passed on from the raw value (gpt-6-astra at dd559d7e).
  const blank = identityRefusals(dir, { ...env, GIT_AUTHOR_NAME: "   " }, "demo");
  assert.match(blank.join("\n"), /Git cannot use the author identity \(.+\); fix GIT_AUTHOR_NAME in the environment/);
  // An empty variable is a missing field, not the config's.
  assert.match(identityRefusals(dir, { ...env, GIT_COMMITTER_NAME: "" }, "demo").join("\n"), /the committer name is not set, so Git would guess one; set GIT_COMMITTER_NAME in the environment/);
  // committer.email in a global config beats user.email, and is named by its file.
  run(dir, ["config", "--global", "committer.email", "me@studio.local"], env);
  assert.match(identityRefusals(dir, env, "demo").join("\n"), /the committer email me@studio\.local is one Git guesses from the machine's user and host names; fix committer\.email in .*gitconfig/);
});

test("a workspace with no policy recorded refuses the builder and names the init that sets one", (t) => {
  const { dir, env } = workspace(t);
  rmSync(join(dir, ".git", IDENTITY_FILE));
  run(dir, ["config", "--local", "user.name", OWNER.name], env);
  run(dir, ["config", "--local", "user.email", OWNER.email], env);
  assert.deepEqual(identityRefusals(dir, env, "demo"), ["demo has no commit identity in its policy; the owner sets one with atelier init --commit-name NAME --commit-email EMAIL [--agent-email EMAIL ...] (docs/setup.md, \"Commit identity\")"]);
  assert.deepEqual(builderRefusals(null, resolveIdentity(dir, env), "demo"), identityRefusals(dir, env, "demo"));
});

test("a runner whose builder identity is refused starts no harness and releases the task, naming the setting", async () => {
  const calls = [], logs = [];
  let heads = 0;
  const io = {
    log: (s) => logs.push(s), stopped: () => false, env: {}, ownerTokens: () => [],
    workspacePath: (project, id) => `/cache/work/${project}/${id}`,
    async cli(argv) { calls.push({ argv }); },
    async reset() {}, async head() { heads++; return "before"; },
    async brief() { return { file: "/cache/brief.txt" }; }, async removeBrief() {},
    async identityRefusals(cwd, env, project) {
      calls.push({ identity: [cwd, project], meta: env.CF_AIG_METADATA !== undefined });
      return ["the author email me@personal.example is neither the project's commit address (x) nor an agent address the policy allows (agentEmails); fix GIT_AUTHOR_EMAIL in the environment"];
    },
    async harness() { calls.push({ harness: true }); return { code: 0 }; },
  };
  const assignment = { project: "demo", agent: "claude-code", model: "opus-5.5", actor: "claude-code/opus-5.5", item: { id: "t5", title: "Edit", scope: [] } };
  const state = await runTask(assignment, { agents: [{ agent: "claude-code", models: ["opus-5.5"], command: ["claude", "{brief_file}"] }] }, "home:studio", io);
  assert.equal(state.phase, "failed");
  assert.match(state.reason, /^commit identity refused before the builder started: the author email me@personal\.example .*fix GIT_AUTHOR_EMAIL in the environment$/);
  assert.equal(state.taskFailure, false, "the runner's setup, not the model's work");
  assert.ok(!calls.some((c) => c.harness), "no harness ran");
  assert.deepEqual(calls.find((c) => c.identity), { identity: ["/cache/work/demo/t5", "demo"], meta: true }, "checked in the harness's own environment");
  const release = calls.find((c) => c.argv?.[0] === "release");
  assert.ok(release, "the task goes back");
  assert.match(release.argv.at(-1), /GIT_AUTHOR_EMAIL/);
});

// ── landing ───────────────────────────────────────────────────────────────

const gitFn = (env) => (args, opts = {}) => {
  const out = execFileSync("git", args, { cwd: opts.cwd, encoding: "utf8", env });
  return opts.raw ? out : out.trim();
};

test("a landing checks the commits it adds, its own merge commit included, and leaves the baseline's history alone", (t) => {
  const root = tempRoot(t), dir = join(root, "repo"), env = bareEnv(root);
  execFileSync("git", ["init", "-q", "-b", "main", dir], { env });
  const commit = (message, who, extra = {}) => run(dir, ["-c", `user.name=${who.name}`, "-c", `user.email=${who.email}`, "commit", "-q", "--allow-empty", "-m", message], { ...env, ...extra });
  // Grandfathered: the baseline holds a commit under a guessed address.
  commit("Old", { name: "Pavi", email: "pavi@mbp.local" });
  const baseline = run(dir, ["rev-parse", "HEAD"], env);
  run(dir, ["checkout", "-q", "-b", "task"], env);
  commit("Agent work", { name: "codex", email: AGENT });
  const agentHead = run(dir, ["rev-parse", "HEAD"], env);
  const git = gitFn(env);
  assert.deepEqual(identityRangeRefusals(git, dir, POLICY, baseline, agentHead), [], "the baseline's own commit is outside the range");

  commit("Personal", { name: "Pavi", email: "owner@personal.example" });
  const bad = run(dir, ["rev-parse", "HEAD"], env);
  assert.deepEqual(identityRangeRefusals(git, dir, POLICY, baseline, bad), [`commit ${bad.slice(0, 12)}: the author email owner@personal.example is declared private in the project's policy (privateEmails)`, `commit ${bad.slice(0, 12)}: the committer email owner@personal.example is declared private in the project's policy (privateEmails)`]);

  // The generated merge commit: under the policy's identity, whatever the
  // caller's environment says, it passes; made as the environment says, it
  // is refused, naming it and the field.
  run(dir, ["checkout", "-q", "main"], env);
  const conflicting = { GIT_AUTHOR_NAME: "Pavi", GIT_AUTHOR_EMAIL: "pavi@mac.example", GIT_COMMITTER_NAME: "Pavi", GIT_COMMITTER_EMAIL: "pavi@mac.example" };
  execFileSync("git", ["merge", "-q", "--no-ff", "-m", "Merge t1", agentHead], { cwd: dir, env: { ...env, ...conflicting, ...identityEnv(POLICY) } });
  const merged = run(dir, ["rev-parse", "HEAD"], env);
  assert.deepEqual(identityRangeRefusals(git, dir, POLICY, baseline, merged), []);
  assert.equal(run(dir, ["log", "-1", "--format=%an <%ae> / %cn <%ce>"], env), `${OWNER.name} <${OWNER.email}> / ${OWNER.name} <${OWNER.email}>`);
  run(dir, ["reset", "-q", "--hard", baseline], env);
  execFileSync("git", ["merge", "-q", "--no-ff", "-m", "Merge t1", agentHead], { cwd: dir, env: { ...env, ...conflicting } });
  const stray = run(dir, ["rev-parse", "HEAD"], env);
  const refused = identityRangeRefusals(git, dir, POLICY, baseline, stray);
  assert.equal(refused.length, 2);
  assert.equal(refused[0], `commit ${stray.slice(0, 12)}: the author email pavi@mac.example is neither the project's commit address (123+owner@users.noreply.github.com) nor an agent address the policy allows (agentEmails)`);
  assert.match(refused[1], /: the committer email pavi@mac\.example /);
});

test("commit records parse whatever a name holds, and an empty field is refused", () => {
  const log = `${"a".repeat(40)}\0A, \"B\"\0${AGENT}\0\0${OWNER.email}\x1e\n`;
  assert.equal(IDENTITY_LOG_FORMAT, "%H%x00%an%x00%ae%x00%cn%x00%ce%x1e");
  const [c] = parseIdentityLog(log);
  assert.deepEqual(c, { commit: "a".repeat(40), authorName: "A, \"B\"", authorEmail: AGENT, committerName: "", committerEmail: OWNER.email });
  assert.deepEqual(commitRefusals(POLICY, [c]), [`commit ${"a".repeat(12)}: the committer name is empty`]);
});

// ── public mirror ─────────────────────────────────────────────────────────

test("a public mirror takes only the project's own no-reply address: an agent address allowed for landing is not thereby public", () => {
  const c = (authorEmail, committerEmail = authorEmail) => ({ commit: "b".repeat(40), authorName: "A", authorEmail, committerName: "A", committerEmail });
  const mirrored = { ...POLICY, publicMirrors: ["github"] };
  assert.deepEqual(publicRefusals(mirrored, [c(OWNER.email), c(OWNER.email.toUpperCase())]), []);
  assert.equal(commitRefusals(mirrored, [c(AGENT)]).length, 0, "landing allows the agent address");
  assert.deepEqual(publicRefusals(mirrored, [c(AGENT, OWNER.email)]), [`commit ${"b".repeat(12)}: the author email ${AGENT} is not the project's public address ${OWNER.email} (commitEmail), the only one a public mirror (publicMirrors) takes`]);
  // Another no-reply address is public, but not the project's declared one.
  assert.match(publicRefusals(mirrored, [c(OWNER.email, "41898282+github-actions[bot]@users.noreply.github.com")])[0], /the committer email 41898282\+github-actions\[bot\]@users\.noreply\.github\.com is not the project's public address/);
  assert.equal(publicRefusals(mirrored, [c("owner@personal.example")]).length, 2);
  // A policy whose own address is not a no-reply one publishes nothing.
  assert.match(publicRefusals({ ...POLICY, email: "owner@studio.example" }, [c("owner@studio.example")])[0], /the author email owner@studio\.example is not a GitHub no-reply address .*; set commitEmail/);
});

test("only a remote the policy declares is a public mirror", () => {
  assert.equal(isPublicMirror({ ...POLICY, publicMirrors: ["github"] }, "github"), true);
  assert.equal(isPublicMirror({ ...POLICY, publicMirrors: ["github"] }, "origin"), false);
  assert.equal(isPublicMirror(POLICY, "github"), false, "no declared mirrors, none checked");
  assert.equal(isPublicMirror(undefined, "github"), false);
});

// ── claim ─────────────────────────────────────────────────────────────────

// A server that answers a claim with a fork the test serves from a local
// bare repository, and the policy's identity, or none; `atelier claim` runs
// against it with no global Git identity and no registered checkout.
async function claimFixture(t) {
  const root = tempRoot(t), env = bareEnv(root);
  const source = join(root, "source"), fork = join(root, "fork.git");
  execFileSync("git", ["init", "-q", "-b", "main", source], { env });
  run(source, ["-c", "user.name=Seed", "-c", `user.email=${OWNER.email}`, "commit", "-q", "--allow-empty", "-m", "Initial"], env);
  execFileSync("git", ["clone", "-q", "--bare", source, fork], { env });
  const state = { identity: POLICY };
  const server = createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    const item = { id: "t1", title: "Edit", scope: [], owner: "codex/test", state: "claimed" };
    const data = req.url.endsWith("/claim")
      ? { item, workspace: { token: "write-token", remote: fork, defaultBranch: "main", expiresAt: "2026-10-11T00:00:00.000Z" }, commitIdentity: state.identity }
      : { item };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  });
  t.after(() => server.close());
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  writeFileSync(join(root, "config.json"), JSON.stringify({}));
  Object.assign(env, { ATELIER_ACTOR: "codex/test", ATELIER_CONFIG_DIR: root, ATELIER_CACHE: join(root, "cache"), ATELIER_TOKEN: "api-token", ATELIER_SERVER: `http://127.0.0.1:${server.address().port}` });
  const claim = async (extra = {}) => {
    const child = spawn(process.execPath, [cli, "claim", "t1", "--project", "proj"], { cwd: root, env: { ...env, ...extra } });
    let output = ""; child.stdout.on("data", (s) => output += s); child.stderr.on("data", (s) => output += s);
    const status = await new Promise((done) => child.on("close", done));
    return { status, output };
  };
  const ws = join(root, "cache", "work", "proj", "t1");
  return { env, state, claim, ws, local: (key) => run(ws, ["config", "--local", "--get", key], env) };
}

test("every claim, of a new clone or a reused one, writes the policy's identity on a machine with no checkout or global identity", async (t) => {
  const f = await claimFixture(t);
  const first = await f.claim();
  assert.equal(first.status, 0, first.output);
  assert.match(first.output, /Commits here are authored as Project Owner <123\+owner@users\.noreply\.github\.com>, as the project's policy names\./);
  assert.equal(f.local("user.name"), OWNER.name);
  assert.equal(f.local("user.email"), OWNER.email);
  assert.deepEqual(JSON.parse(readFileSync(join(f.ws, ".git", IDENTITY_FILE), "utf8")), POLICY);
  assert.deepEqual(identityRefusals(f.ws, f.env, "proj"), [], "a builder may start here");

  // A reused clone holding another identity, and a policy changed since:
  // the claim writes the policy's again.
  run(f.ws, ["config", "--local", "user.email", "owner@personal.example"], f.env);
  f.state.identity = { ...POLICY, name: "Renamed Owner" };
  const again = await f.claim();
  assert.equal(again.status, 0, again.output);
  assert.equal(f.local("user.email"), OWNER.email);
  assert.equal(f.local("user.name"), "Renamed Owner");
  assert.equal(JSON.parse(readFileSync(join(f.ws, ".git", IDENTITY_FILE), "utf8")).name, "Renamed Owner");
});

test("a claim in an environment that would commit under another address fails, naming the variable", async (t) => {
  const f = await claimFixture(t);
  const r = await f.claim({ GIT_AUTHOR_EMAIL: "me@personal.example" });
  assert.notEqual(r.status, 0);
  assert.match(r.output, /t1 is claimed, but a commit made in .* would carry an identity the project's policy refuses:\n {2}the author email me@personal\.example is neither .* fix GIT_AUTHOR_EMAIL in the environment\nFix that, then run atelier claim t1 again\./);
  // The workspace still holds the policy's identity for the next claim.
  assert.equal(f.local("user.email"), OWNER.email);
});

test("a claim whose identity cannot be recorded fails its setup", async (t) => {
  const f = await claimFixture(t);
  assert.equal((await f.claim()).status, 0);
  rmSync(join(f.ws, ".git", IDENTITY_FILE));
  mkdirSync(join(f.ws, ".git", IDENTITY_FILE));
  const r = await f.claim();
  assert.notEqual(r.status, 0);
  assert.match(r.output, /the claim could not record the project's commit identity in .*atelier-identity\.json/);
});

test("a claim in a project with no identity says so, and the runner's check refuses the builder", async (t) => {
  const f = await claimFixture(t);
  f.state.identity = null;
  const r = await f.claim();
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /Warning: proj has no commit identity in its policy; the owner sets one with atelier init --commit-name NAME --commit-email EMAIL/);
  assert.deepEqual(identityRefusals(f.ws, f.env, "proj"), [r.output.match(/Warning: (proj has no commit identity[^\n]*?\))\./)[1]]);
});
