// Atelier 2.0, task 3 (design-branches-2026-10-28.md, section 4.4, rules 5
// and 6): the pre-receive hook runs the secret scan and the private-file
// guard over the commits a push adds, before the ref moves, and the server
// records what the scan found on the item. Each test pushes with the real
// git client to the real server and the real hook. Every key here is a
// dummy, built at run time so this file holds none.
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startServer } from "../src/runtime/server.mjs";

const OWNER = "atl_00112233445566778899aabbccddeeff";
const AGENT = "codex/gpt-6";
const KEY = ["sk", "proj", "TESTONLY", "d".repeat(28)].join("-");
const root = mkdtempSync(join(tmpdir(), "atelier-git-scan-"));
after(() => rmSync(root, { recursive: true, force: true }));

const artifacts = {
  create: async () => ({}),
  get: async (repo) => ({
    info: async () => ({ remote: `https://git.test/${repo}.git`, defaultBranch: "main" }),
    createToken: async (scope) => ({ id: "tok1", plaintext: "art_dummy", scope, expiresAt: new Date(Date.now() + 3600e3).toISOString() }),
    revokeToken: async () => true,
    [Symbol.dispose]() {},
  }),
};

const gitEnv = { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };
const git = (...args) => execFileSync("git", ["-c", "credential.helper=", ...args], { cwd: work, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
// Git that talks to the server runs asynchronously: the server answers from
// this same process.
const tryGit = (...args) => new Promise((ok) => execFile("git", ["-c", "credential.helper=", ...args], { cwd: work, env: gitEnv, encoding: "utf8", timeout: 30_000 },
  (err, stdout, stderr) => ok({ status: err ? (err.code ?? 1) : 0, stdout, stderr })));

let server, base, work, t5;
const errors = [];
const L = () => server.namespace.get(server.namespace.idFromName("project:demo"));
const remote = (token) => `${base.replace("http://", `http://x:${token}@`)}/git/demo.git`;
const push = (token, refspec) => tryGit("push", "--porcelain", remote(token), refspec);
const tip = async (ref) => (await tryGit("ls-remote", remote(OWNER), ref)).stdout.split("\t")[0];
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

function api(method, path, body, token = OWNER, actor = "owner") {
  return fetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-atelier-actor": actor }, body: body === undefined ? undefined : JSON.stringify(body) });
}
// A commit on `parent` that writes `files` ({ path: text }) to its tree.
function commit(message, parent, files) {
  git("read-tree", parent);
  for (const [path, text] of Object.entries(files)) {
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: work, env: gitEnv, input: text }).toString().trim();
    git("update-index", "--add", "--cacheinfo", `100644,${blob},${path}`);
  }
  return git("commit-tree", git("write-tree"), "-p", parent, "-m", message);
}
function refused(r, text) {
  assert.notEqual(r.status, 0, `the push succeeded:\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, text);
  assert.equal(r.stderr.includes(KEY), false, "the refusal shows the key");
}
function filesUnder(dir) {
  return readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? filesUnder(join(dir, f)) : [join(dir, f)]));
}

const consoleError = console.error;
before(async () => {
  console.error = (...args) => { errors.push(args.join(" ")); consoleError(...args); };
  server = await startServer({ env: "test", dataDir: join(root, "data"), host: "127.0.0.1", vars: { ATELIER_TOKEN: OWNER }, bindings: { ARTIFACTS: artifacts } });
  base = server.url.replace("localhost", "127.0.0.1");
  assert.equal((await api("PUT", "/projects/demo", {})).status, 200);
  for (let i = 1; i <= 5; i++) assert.equal((await api("POST", "/projects/demo/items", { title: `Task ${i}` })).status, 201);
  const agentToken = (await (await api("POST", "/tokens", { actor: AGENT, projects: ["demo"] })).json()).token;
  work = join(root, "work");
  mkdirSync(work);
  git("init", "-q", "-b", "main");
  writeFileSync(join(work, "a.txt"), "one\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "first");
  assert.equal((await push(OWNER, "HEAD:refs/heads/main")).status, 0);
  await L().claim("t5", AGENT);
  const r = await api("POST", "/projects/demo/git-token", { kind: "task", item: "t5" }, agentToken, AGENT);
  assert.equal(r.status, 200, await r.clone().text());
  t5 = (await r.json()).token;
});
after(async () => { console.error = consoleError; await server?.close(); });

const main = () => git("rev-parse", "main");

test("a push carrying a key-shaped line is refused before the ref moves, naming file and line; the owner's clearance lets it through and it becomes the scan record", async () => {
  const c = commit("add config", main(), { "config.env": `MODE=test\nOPENAI_API_KEY=${KEY}\n` });
  refused(await push(t5, `${c}:refs/heads/t/5`), /secret scan found a key-shaped line: config\.env:2 in [0-9a-f]{12}.*atelier clear-secret t5/s);
  assert.equal(await tip("refs/heads/t/5"), "");
  // The refused push's findings stand on the item, so the owner can clear them.
  let item = await L().item("t5");
  assert.deepEqual(item.secret.map((f) => [f.file, f.line, f.commit, f.head, !!f.cleared]), [["config.env", 2, c, c, false]]);
  assert.equal(item.secret[0].fingerprint, sha256(`OPENAI_API_KEY=${KEY}`));
  await L().clearSecret("t5", "owner", "a dummy key the test made");
  const ok = await push(t5, `${c}:refs/heads/t/5`);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(await tip("refs/heads/t/5"), c);
  // Recording the head takes the hook's report as its scan: nothing pending,
  // the line flagged and cleared.
  item = await L().recordPush("t5", AGENT, c, c, false, { holdsRecorded: true, rebasedFrom: null }, [], true);
  assert.equal(item.head, c);
  assert.equal(item.secretScan, undefined);
  assert.deepEqual(item.secret.map((f) => [f.file, f.line, f.head, f.cleared]), [["config.env", 2, c, true]]);
});

test("a line the allowance list permits passes, and a clean push clears the scan record", async () => {
  const before = await tip("refs/heads/t/5");
  const line = `SERVICE_TOKEN=${KEY.replace("TESTONLY", "ALLOWED0")}`;
  const added = commit("add fixture", before, { "fixture.env": `${line}\n` });
  const allow = { allowances: [{ commit: added, file: "fixture.env", sha256: sha256(line), reason: "a dummy fixture" }] };
  const head = commit("allow fixture", added, { "docs/atelier/privacy-allow.json": JSON.stringify(allow) });
  const ok = await push(t5, `${head}:refs/heads/t/5`);
  assert.equal(ok.status, 0, ok.stderr);
  const item = await L().recordPush("t5", AGENT, head, head, false, { holdsRecorded: true, rebasedFrom: null }, [], true);
  // config.env's cleared line is still in the task's commits and still
  // recorded; the allowed one is not a finding.
  assert.deepEqual(item.secret.map((f) => [f.file, f.cleared]), [["config.env", true]]);
  // Without the allowance the same line refuses.
  refused(await push(t5, `${commit("unallowed", head, { "other.env": `${line}\n` })}:refs/heads/t/5`), /other\.env:1/);
  // A history without any key-shaped line clears the record.
  const clean = commit("clean", main(), { "b.txt": "two\n" });
  assert.equal((await push(t5, `+${clean}:refs/heads/t/5`)).status, 0);
  const cleared = await L().recordPush("t5", AGENT, clean, clean, false, { holdsRecorded: false, rebasedFrom: head }, [], true);
  assert.equal(cleared.secret, undefined);
  assert.equal(cleared.secretScan, undefined);
});

test("a push carrying a private file is refused before the ref moves", async () => {
  assert.deepEqual(await L().setPrivatePaths(["PROJECT.md", "./notes/"]), ["PROJECT.md", "notes"]);
  const before = await tip("refs/heads/t/5");
  refused(await push(t5, `${commit("plan", before, { "PROJECT.md": "the plan\n" })}:refs/heads/t/5`), /would carry private files: PROJECT\.md in [0-9a-f]{12}/);
  refused(await push(t5, `${commit("notes", before, { "Notes/today.md": "x\n" })}:refs/heads/t/5`), /would carry private files: Notes\/today\.md/);
  // The owner's own push of the project's branch is guarded too.
  refused(await push(OWNER, `${commit("plan on main", main(), { "PROJECT.md": "the plan\n" })}:refs/heads/main`), /would carry private files/);
  assert.equal(await tip("refs/heads/t/5"), before);
  const ok = await push(t5, `${commit("public", before, { "README.md": "hello\n" })}:refs/heads/t/5`);
  assert.equal(ok.status, 0, ok.stderr);
});

test("no key, token or found value reaches the data directory, the hook's files or a log", async () => {
  const c = commit("again", main(), { "keys.txt": `Authorization: Bearer ${KEY}\n` });
  refused(await push(t5, `+${c}:refs/heads/t/5`), /keys\.txt:1/);
  const data = join(root, "data");
  for (const f of filesUnder(data)) {
    const bytes = readFileSync(f);
    for (const secret of [KEY, t5, OWNER]) assert.equal(bytes.includes(secret), false, `${f} holds a secret`);
  }
  // Each push's policy and report went with its request.
  assert.deepEqual(readdirSync(join(data, "hook-scans")), []);
  for (const line of errors) for (const secret of [KEY, t5, OWNER]) assert.equal(line.includes(secret), false, `a log line holds a secret: ${line}`);
});
