// Atelier 2.0, task 11 (design section 5; the 2.0 log, task 6's decision):
// on the Node server the project's repository is the baseline, and once its
// branch exists only a landing moves it. The four commands that pushed the
// branch with the owner's credential, which task 6 left refused by the hook,
// are reworked: init run again records the policy and pushes nothing; sync
// goes away, refused with the way each direction goes instead; wrap's
// baseline step reports the server's branch instead of publishing; ship's
// baseline step is skipped (test/ship.test.mjs). Each runs the real CLI
// against the real server and its real hook. Every credential is a dummy.
import { strict as assert } from "node:assert";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startServer } from "../src/runtime/server.mjs";

const OWNER = "atl_00112233445566778899aabbccddeeff00112233";
const root = mkdtempSync(join(tmpdir(), "atelier-node-baseline-"));
after(() => rmSync(root, { recursive: true, force: true }));
const gitEnv = { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };
for (const k of Object.keys(gitEnv)) if (k.startsWith("ATELIER_")) delete gitEnv[k];
const git = (cwd, ...args) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
let server, base;
const checkout = join(root, "demo");
const cli = (argv) => new Promise((ok) => execFile(process.execPath, [join(process.cwd(), "cli/atelier.mjs"), ...argv], {
  cwd: checkout, encoding: "utf8", timeout: 120_000,
  env: { ...gitEnv, ATELIER_CONFIG_DIR: join(root, "config"), ATELIER_CACHE: join(root, "cache"), ATELIER_PRIVATE_ROOT: join(root, "no-icloud"), ATELIER_TOKEN: OWNER, ATELIER_SERVER: base, ATELIER_SECRET_STORE: "file", NO_COLOR: "1", ATELIER_ACTING: "claude-code/opus-5.5" },
}, (err, stdout, stderr) => ok({ code: err ? (err.code ?? 1) : 0, stdout, stderr })));
const serverMain = () => git(join(root, "data", "repos", "demo.git"), "rev-parse", "refs/heads/main");
const commit = (file, text, message) => { writeFileSync(join(checkout, file), text); git(checkout, "add", file); git(checkout, "commit", "-q", "-m", message); return git(checkout, "rev-parse", "HEAD"); };

before(async () => {
  server = await startServer({ env: "test", dataDir: join(root, "data"), host: "127.0.0.1", vars: { ATELIER_TOKEN: OWNER } });
  base = server.url.replace("localhost", "127.0.0.1");
  mkdirSync(checkout);
  git(checkout, "init", "-q", "-b", "main");
  commit("a.txt", "one\n", "first");
  assert.equal((await cli(["login", "--server", base])).code, 0);
  const first = await cli(["init", "--check", "git status", "--commit-name", "t", "--commit-email", "t@example.test"]);
  assert.equal(first.code, 0, `${first.stdout}\n${first.stderr}`);
  assert.match(first.stdout, /demo's repository on this server now holds main @ /, "the first init still pushes the branch into the empty repository");
  assert.equal(serverMain(), git(checkout, "rev-parse", "HEAD"));
});
after(async () => { await server?.close(); });

test("the server says its repository is the baseline", async () => {
  const res = await fetch(`${base}/api/projects/demo/baseline-head`, { headers: { authorization: `Bearer ${OWNER}`, "x-atelier-actor": "owner" } });
  const body = await res.json();
  assert.equal(body.repository, "server");
  assert.equal(body.head, serverMain());
});

test("init run again records the policy and pushes nothing, saying what the checkout holds beyond the server's branch and how it gets there", async () => {
  const main = serverMain();
  const same = await cli(["init", "--check", "git status", "--check", "true", "--commit-name", "t", "--commit-email", "t@example.test"]);
  assert.equal(same.code, 0, `${same.stdout}\n${same.stderr}`);
  assert.match(same.stdout, /demo: policy recorded; nothing was pushed\. On this server the repository is the baseline, and main there is at [0-9a-f]{8}\.\nThis checkout's main is at the same commit\./);
  const ahead = commit("b.txt", "two\n", "made outside Atelier");
  const r = await cli(["init", "--check", "git status", "--commit-name", "t", "--commit-email", "t@example.test"]);
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /This checkout holds 1 commit the server's main lacks; only a landing moves main there, so they were not sent\./);
  assert.match(r.stdout, /next: carry them as a task: atelier new "TITLE" --project demo, claim it, push the commits to its branch, then atelier land tN --project demo/);
  assert.doesNotMatch(r.stderr, /refused|pre-receive/, "the hook was never asked");
  assert.equal(serverMain(), main, "the server's branch did not move");
  assert.notEqual(ahead, main);
  // The policy the re-run sent is the server's now.
  const project = await (await fetch(`${base}/api/projects/demo`, { headers: { authorization: `Bearer ${OWNER}`, "x-atelier-actor": "owner" } })).json();
  assert.deepEqual(project.project.policy.checks, ["git status"]);
  git(checkout, "reset", "-q", "--hard", main);
});

test("sync goes away: refused, naming atelier pull for one direction and a landing for the other, and nothing is sent", async () => {
  const main = serverMain();
  commit("c.txt", "three\n", "another made outside Atelier");
  const r = await cli(["sync", "--project", "demo"]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /demo's server keeps the project's repository itself, and that repository is the baseline: there is no separate baseline to carry commits to, and only a landing moves main there\. Nothing was sent\./);
  assert.match(r.stderr, /next: atelier pull --project demo brings this checkout to the server's main; commits made here outside Atelier reach it as a task: .*atelier land tN --project demo/);
  assert.equal(serverMain(), main);
  git(checkout, "reset", "-q", "--hard", main);
});

test("wrap's baseline step reports the server's branch instead of publishing, and the rest of wrap runs", async () => {
  const main = serverMain();
  const same = await cli(["wrap", "a session with nothing new", "--no-check", "--project", "demo"]);
  assert.equal(same.code, 0, `${same.stdout}\n${same.stderr}`);
  assert.match(same.stdout, /Baseline: the server's repository is the baseline, and its main is at [0-9a-f]{8}, as this checkout is\. Nothing to publish\./);
  writeFileSync(join(checkout, "notes.txt"), "a note\n");
  const r = await cli(["wrap", "a session that committed a note", "--no-check", "--project", "demo"]);
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /This checkout holds 1 commit it lacks, which were not published: only a landing moves main there\.\nnext: carry them as a task/);
  assert.doesNotMatch(r.stdout + r.stderr, /pre-receive|refused/);
  assert.equal(serverMain(), main, "wrap pushed nothing to the server's branch");
  assert.notEqual(git(checkout, "rev-parse", "HEAD"), main, "wrap still committed the session in the checkout");
});
