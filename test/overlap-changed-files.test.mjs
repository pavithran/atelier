// G13 (lessons-to-2.0, S8, row 16): overlap is judged on the files a task
// changed, and a refused dispatch stays queued. Each step drives the real CLI
// against the real Node server and its Git hook with the real git client: the
// changed files are the ones the push route reads from the task's branch
// against its merge base with main. Every credential here is a dummy.
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startServer } from "../src/runtime/server.mjs";
import { footprintsOverlap } from "../src/rules.ts";

const OWNER = "atl_00112233445566778899aabbccddeeff";
const BUILDER = "claude-code/opus-5.5";
const OTHER = "codex/gpt-6";
const root = mkdtempSync(join(tmpdir(), "atelier-overlap-files-"));
after(() => rmSync(root, { recursive: true, force: true }));

const gitEnv = { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };
for (const k of Object.keys(gitEnv)) if (k.startsWith("ATELIER_")) delete gitEnv[k];
const run = (cmd, args, opts = {}) => new Promise((ok) => execFile(cmd, args, { env: gitEnv, encoding: "utf8", timeout: 60_000, ...opts },
  (err, stdout, stderr) => ok({ code: err ? (err.code ?? 1) : 0, stdout, stderr })));
const git = async (cwd, ...args) => {
  const r = await run("git", ["-c", "credential.helper=", ...args], { cwd });
  assert.equal(r.code, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

let server, base;
const cache = join(root, "cache");
const api = async (method, path, body, token = OWNER, extra = {}) => {
  const res = await fetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-atelier-actor": "owner", ...(token === OWNER ? { "x-atelier-acting": BUILDER } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const cli = (argv, { token = OWNER, cwd = root } = {}) => run(process.execPath, [join(process.cwd(), "cli/atelier.mjs"), ...argv, ...(argv[0] === "login" ? [] : ["--project", "demo"])], {
  cwd, env: { ...gitEnv, ATELIER_CONFIG_DIR: join(root, "config"), ATELIER_CACHE: cache, ATELIER_TOKEN: token, ATELIER_SERVER: base, ATELIER_SECRET_STORE: "file", NO_COLOR: "1", ATELIER_ACTING: BUILDER },
});
const task = async (title, scope) => {
  const r = await api("POST", "/projects/demo/items", { title, scope });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.id;
};

before(async () => {
  server = await startServer({ env: "test", dataDir: join(root, "data"), host: "127.0.0.1", vars: { ATELIER_TOKEN: OWNER } });
  base = server.url.replace("localhost", "127.0.0.1");
  const login = await cli(["login", "--server", base]);
  assert.equal(login.code, 0, login.stderr);
  const checkout = join(root, "demo");
  mkdirSync(join(checkout, "src", "a"), { recursive: true });
  mkdirSync(join(checkout, "src", "b"), { recursive: true });
  writeFileSync(join(checkout, "src", "a", "x.txt"), "one\n");
  writeFileSync(join(checkout, "src", "b", "y.txt"), "one\n");
  await git(checkout, "init", "-q", "-b", "main");
  await git(checkout, "add", ".");
  await git(checkout, "commit", "-q", "-m", "first");
  const init = await cli(["init", "--check", "git status", "--refuse-overlap", "--commit-name", "t", "--commit-email", "t@example.test"], { cwd: checkout });
  assert.equal(init.code, 0, `${init.stdout}\n${init.stderr}`);
});
after(async () => { await server?.close(); });

test("the footprint rule: changed files against changed files, changed files against a scope, scopes against scopes", () => {
  assert.equal(footprintsOverlap({ scope: ["src/**"], changedFiles: ["src/a/x.txt"] }, { scope: ["src/b/**"] }), false);
  assert.equal(footprintsOverlap({ scope: ["src/**"], changedFiles: ["src/a/x.txt"] }, { scope: ["src/a/**"] }), true);
  assert.equal(footprintsOverlap({ scope: ["src/**"], changedFiles: ["src/a/x.txt"] }, { scope: [] }), true, "an unscoped task overlaps everything");
  assert.equal(footprintsOverlap({ scope: ["src/**"], changedFiles: ["src/a/x.txt"] }, { scope: ["src/**"], changedFiles: ["src/b/y.txt"] }), false);
  assert.equal(footprintsOverlap({ scope: ["src/**"], changedFiles: [] }, { scope: ["src/b/**"] }), true, "no changed files: the scope counts");
});

test("overlap is judged on the changed files once a task has commits; a held dispatch stays queued, names its blocker and is offered once the blocker is abandoned", async () => {
  const agentToken = (await api("POST", "/tokens", { actor: BUILDER, projects: ["demo"] })).body.token;
  const otherToken = (await api("POST", "/tokens", { actor: OTHER, projects: ["demo"] })).body.token;
  const runnerToken = (await api("POST", "/tokens", { runner: "home:studio", projects: ["demo"] })).body.token;
  assert.ok(agentToken && otherToken && runnerToken);

  const wide = await task("Touches src broadly", ["src/**"]);
  const claimed = await cli(["claim", wide, "--as", BUILDER], { token: agentToken });
  assert.equal(claimed.code, 0, `${claimed.stdout}\n${claimed.stderr}`);

  // Edge: the live task has no commits yet, so its glob counts.
  const beside = await task("Touches src/b", ["src/b/**"]);
  const early = await cli(["claim", beside, "--as", OTHER], { token: otherToken });
  assert.notEqual(early.code, 0, early.stdout);
  assert.match(early.stderr, new RegExp(`overlap: ${beside}'s scope overlaps live ${wide}`));
  assert.match(early.stderr, /\nnext: /);

  // The live task changes src/a alone and pushes.
  const dir = join(cache, "work", "demo", wide);
  writeFileSync(join(dir, "src", "a", "x.txt"), "two\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-q", "-m", "change src/a");
  const pushed = await cli(["push", wide, "--as", BUILDER], { token: agentToken, cwd: dir });
  assert.equal(pushed.code, 0, `${pushed.stdout}\n${pushed.stderr}`);

  // Its glob still overlaps src/b/**, but its changed files do not.
  const later = await cli(["claim", beside, "--as", OTHER], { token: otherToken });
  assert.equal(later.code, 0, `${later.stdout}\n${later.stderr}`);
  await cli(["release", beside, "--as", OTHER], { token: otherToken });

  // A task whose scope reaches the changed file: its dispatch is held, not refused.
  const clash = await task("Touches src/a", ["src/a/**"]);
  const dispatched = await cli(["dispatch", clash, "--to", "home", "--agent", "opencode", "--model", "glm-5.3"]);
  assert.equal(dispatched.code, 0, `${dispatched.stdout}\n${dispatched.stderr}`);
  assert.match(dispatched.stdout, new RegExp(`${clash} is held: its claim would overlap ${wide} \\(claimed by ${BUILDER.replace(/[./]/g, "\\$&")}\\)`));
  const shown = (await api("GET", `/projects/demo/items/${clash}`)).body;
  assert.equal(shown.item.dispatch.to, "home", "the dispatch is recorded");
  assert.equal(shown.events.find((e) => e.kind === "item.dispatched").data.heldBy, wide);

  // A runner is offered nothing for it while the blocker is live; the owner's queue names the blocker.
  const offer = { runner: "home:studio", kind: "home", jobs: ["build"], agents: [{ agent: "opencode", models: ["glm-5.3"] }] };
  const poll = async () => (await api("POST", "/queue", offer, runnerToken, { "x-atelier-actor": "runner/studio" })).body.map((q) => q.item.id);
  assert.ok(!(await poll()).includes(clash), "an overlap-held dispatch is offered to no runner");
  const queue = await cli(["queue"]);
  assert.match(queue.stdout, new RegExp(`demo/${clash} .*\\n(?:.*\\n)*?  Overlap refused: ${wide} \\(claimed by`));

  // Edge: the blocker is abandoned; the held dispatch is offered.
  const abandoned = await cli(["abandon", wide, "--note", "superseded", "--quote", "abandon it, it is superseded"]);
  assert.equal(abandoned.code, 0, `${abandoned.stdout}\n${abandoned.stderr}`);
  assert.ok((await poll()).includes(clash), "offered once its blocker is abandoned");
});
