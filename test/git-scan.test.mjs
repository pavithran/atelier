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
const remote = (token, project = "demo") => `${base.replace("http://", `http://x:${token}@`)}/git/${project}.git`;
const push = (token, refspec) => tryGit("push", "--porcelain", remote(token), refspec);
const tip = async (ref) => (await tryGit("ls-remote", remote(OWNER), ref)).stdout.split("\t")[0];
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

function api(method, path, body, token = OWNER, actor = "owner") {
  return fetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-atelier-actor": actor, ...(token === OWNER ? { "x-atelier-acting": "claude-code/opus-5.5" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
}
// A commit on `parent` (and any `more` parents) that writes `files`
// ({ path: text }) to its tree.
function commit(message, parent, files, ...more) {
  git("read-tree", parent);
  for (const [path, text] of Object.entries(files)) {
    if (text === null) {
      // A submodule: a commit of another repository.
      git("update-index", "--add", "--cacheinfo", `160000,${"a".repeat(40)},${path}`);
      continue;
    }
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: work, env: gitEnv, input: text }).toString().trim();
    git("update-index", "--add", "--cacheinfo", `100644,${blob},${path}`);
  }
  return git("commit-tree", git("write-tree"), "-p", parent, ...more.flatMap((p) => ["-p", p]), "-m", message);
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
  server = await startServer({ env: "test", dataDir: join(root, "data"), host: "127.0.0.1", vars: { ATELIER_TOKEN: OWNER }, bindings: { REPOS: artifacts } });
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


// A landing grant minted straight from the store, for the tests of the
// hook's rules alone. Such a grant counts only while its task is accepted at
// its head and its actor holds the landing lease (GitHost.stillLanding);
// these fixtures have neither, so that check stands aside for the test.
// The route that mints landing grants, and the check itself, are tested
// against a real landing in test/land-grant.test.mjs.
function landingGrant(t, grant) {
  const { stillLanding } = server.git;
  server.git.stillLanding = async () => true;
  t.after(() => { server.git.stillLanding = stillLanding; });
  return server.git.grants.mint({ project: "demo", kind: "landing", lease: "test-lease", ...grant });
}

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
  // The owner's own pushes are guarded too (since task 6 the owner writes
  // dev/*, not the project's branch past its creation).
  refused(await push(OWNER, `${commit("plan on main", main(), { "PROJECT.md": "the plan\n" })}:refs/heads/dev/plan`), /would carry private files/);
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

const meta = { holdsRecorded: true, rebasedFrom: null };
const unreadable = { "blob.bin": "PK\0\u0001\0binary\0", "big.txt": "a".repeat(8 * 1024 * 1024 + 1), "sub": null };

test("a file the scan cannot read is recorded on a task's push, and refuses the owner's push", async (t) => {
  // On a task: recorded, not refused, with the reason (a blob over SCAN_BYTES included).
  const c = commit("unreadable", main(), unreadable);
  const ok = await push(t5, `+${c}:refs/heads/t/5`);
  assert.equal(ok.status, 0, ok.stderr);
  const item = await L().recordPush("t5", AGENT, c, c, false, meta, [], true);
  assert.deepEqual(item.secret.map((f) => [f.file, !!f.unscanned, f.reason]).sort(), [
    ["big.txt", true, `${8 * 1024 * 1024 + 1} bytes, over the ${8 * 1024 * 1024} the scan reads`],
    ["blob.bin", true, "binary content"],
    ["sub", true, "a submodule, whose content is in another repository"],
  ]);
  // On dev/* (and on the project's branch, which only a landing moves since
  // task 6): refused, naming each file.
  for (const ref of ["refs/heads/dev/x"]) {
    refused(await push(OWNER, `${c}:${ref}`), /could not read (?=.*big\.txt in [0-9a-f]{12} \(8388609 bytes, over the 8388608 the scan reads\))(?=.*blob\.bin in [0-9a-f]{12} \(binary content\))(?=.*sub in [0-9a-f]{12} \(a submodule).*no task to record/s);
  }
  for (const file of Object.keys(unreadable)) refused(await push(OWNER, `${commit(file, main(), { [file]: unreadable[file] })}:refs/heads/dev/${file}`), new RegExp(`could not read ${file} in`));
  assert.equal(await tip("refs/heads/main"), main());
  // A landing grant carrying the task applies its clearances: cleared by
  // content, the same files pass.
  await L().clearSecret("t5", "owner", "the files the test made");
  const accepted = c;
  const landing = landingGrant(t, { task: "t5", actor: AGENT, accepted });
  const merge = commit("merge t5", main(), {}, accepted);
  const landed = await push(landing.token, `${merge}:refs/heads/main`);
  assert.equal(landed.status, 0, landed.stderr);
  git("update-ref", "refs/heads/main", merge);
});

test("two pushes to one task keep a report each, and recordPush takes the one for the head it records", async () => {
  const a = commit("a", main(), { "a.bin": "\0a\0" });
  const b = commit("b", main(), { "b.bin": "\0b\0" });
  assert.equal((await push(t5, `+${a}:refs/heads/t/5`)).status, 0);
  assert.equal((await push(t5, `+${b}:refs/heads/t/5`)).status, 0);
  assert.deepEqual((await L().hookScan("t5", a)).unscanned.map((u) => u.file), ["a.bin"]);
  const first = await L().recordPush("t5", AGENT, a, a, false, meta, [], true);
  assert.deepEqual(first.secret.map((f) => [f.file, f.head]), [["a.bin", a]]);
  assert.equal(await L().hookScan("t5", a), null, "the report is consumed");
  const second = await L().recordPush("t5", AGENT, b, b, false, meta, [], true);
  assert.deepEqual(second.secret.map((f) => [f.file, f.head]), [["b.bin", b]]);
});

test("a merge commit carrying a line the allowance list permits passes, and one the list leaves out refuses", async () => {
  const line = `SERVICE_TOKEN=${KEY.replace("TESTONLY", "MERGED00")}`;
  const side = commit("side adds fixture", main(), { "fixture.env": `${line}\n` });
  const mainSide = commit("main side", main(), { "m.txt": "m\n" });
  const merge = commit("merge", mainSide, { "fixture.env": `${line}\n` }, side);
  const entry = (hash) => ({ commit: hash, file: "fixture.env", sha256: sha256(line), reason: "a dummy fixture" });
  const allow = (...hashes) => ({ "docs/atelier/privacy-allow.json": JSON.stringify({ allowances: hashes.map(entry) }) });
  refused(await push(t5, `+${commit("allow side only", merge, allow(side))}:refs/heads/t/5`), new RegExp(`fixture\\.env:1 in ${merge.slice(0, 12)}`));
  const head = commit("allow both", merge, allow(side, merge));
  const ok = await push(t5, `+${head}:refs/heads/t/5`);
  assert.equal(ok.status, 0, ok.stderr);
  const item = await L().recordPush("t5", AGENT, head, head, false, meta, [], true);
  assert.deepEqual((item.secret ?? []).filter((f) => f.file === "fixture.env"), []);
});

test("a push adding more commits than the scan reads is refused, naming the cap", async () => {
  let c = main();
  const sizes = 1001;
  // One fast-import stream makes the long history in a moment.
  const stream = Array.from({ length: sizes }, (_, i) => `commit refs/heads/long\ncommitter t <t@example.test> ${1700000000 + i} +0000\ndata 1\nx\n${i === 0 ? `from ${c}\n` : ""}\n`).join("");
  execFileSync("git", ["fast-import", "--quiet"], { cwd: work, env: gitEnv, input: stream });
  c = git("rev-parse", "refs/heads/long");
  refused(await push(t5, `+${c}:refs/heads/t/5`), /adds more than 1000 commits, more than the scan reads/);
});

test("owner creation scans only the tip of a long history; other pushes keep their restrictions", async () => {
  // The first commit holds a secret; the final tip holds only clean text.
  const stream = `blob\nmark :1\ndata ${Buffer.byteLength(KEY) + 1}\n${KEY}\n\n`
    + `blob\nmark :2\ndata 6\nclean\n\n`
    + Array.from({ length: 1001 }, (_, i) => `commit refs/heads/imported\ncommitter t <t@example.test> ${1700100000 + i} +0000\ndata 1\nx\n${i === 0 ? "deleteall\nM 100644 :1 config.env\n" : i === 1000 ? "M 100644 :2 config.env\n" : ""}\n`).join("");
  execFileSync("git", ["fast-import", "--quiet"], { cwd: work, env: gitEnv, input: stream });
  const clean = git("rev-parse", "imported");
  assert.equal(git("rev-list", "--count", clean), "1001");
  const initialPush = async (project, head, privates = []) => {
    assert.equal((await api("PUT", `/projects/${project}`, {})).status, 200);
    if (privates.length) {
      const ledger = server.namespace.get(server.namespace.idFromName(`project:${project}`));
      await ledger.setPrivatePaths(privates);
    }
    return tryGit("push", "--porcelain", remote(OWNER, project), `${head}:refs/heads/main`);
  };
  const ok = await initialPush("import-clean", clean);
  assert.equal(ok.status, 0, ok.stderr);
  refused(await push(t5, `+${clean}:refs/heads/t/5`), /adds more than 1000 commits/);
  refused(await push(OWNER, `${clean}:refs/heads/dev/imported`), /adds more than 1000 commits/);
  const next = commit("next", clean, { "a.txt": "hello\n" });
  refused(await tryGit("push", "--porcelain", remote(OWNER, "import-clean"), `${next}:refs/heads/main`), /main moves only by a landing/);

  const secret = commit("secret at tip", clean, { "config.env": `MODE=test\nOPENAI_API_KEY=${KEY}\n` });
  refused(await initialPush("import-secret", secret), new RegExp(`secret scan found a key-shaped line: config\\.env:2 in ${secret.slice(0, 12)}`));
  const fixture = git("commit-tree", git("rev-parse", `${secret}^{tree}`), "-m", "fixture root");
  const line = `OPENAI_API_KEY=${KEY}`;
  const allowed = commit("allow older fixture", fixture, { "docs/atelier/privacy-allow.json": JSON.stringify({ allowances: [
    { commit: fixture, file: "config.env", sha256: sha256(line), reason: "a dummy fixture" },
  ] }) });
  const initialized = await initialPush("import-allowed", allowed);
  assert.equal(initialized.status, 0, initialized.stderr);
  refused(await initialPush("import-unlisted", commit("another key", allowed, { "other.env": `${line}\n` })), /other\.env:1/);
  const privateTip = commit("private at tip", clean, { "Notes/plan.md": "private\n" });
  refused(await initialPush("import-private", privateTip, ["notes"]), /would carry private files: Notes\/plan\.md in [0-9a-f]{12}/);
  const privateRemoved = git("commit-tree", git("rev-parse", `${clean}^{tree}`), "-p", privateTip, "-m", "remove private file");
  assert.equal((await initialPush("import-private-removed", privateRemoved, ["notes"])).status, 0);

  const unread = commit("unreadable tip", clean, unreadable);
  refused(await initialPush("import-unreadable", unread), /could not read (?=.*big\.txt)(?=.*blob\.bin)(?=.*sub).*no task to record/s);
  const tooMany = `blob\nmark :1\ndata 2\nx\n\ncommit refs/heads/large-tree\ncommitter t <t@example.test> 1700200000 +0000\ndata 1\nx\ndeleteall\n`
    + Array.from({ length: 20001 }, (_, i) => `M 100644 :1 file-${i}\n`).join("") + "\n";
  execFileSync("git", ["fast-import", "--quiet"], { cwd: work, env: gitEnv, input: tooMany });
  refused(await initialPush("import-large", git("rev-parse", "large-tree")), /tip tree has more than 20000 files/);
  // Exercise both production byte caps without thousands of distinct blobs.
  const inventory = `blob\nmark :1\ndata 2\nx\n\ncommit refs/heads/inventory\ncommitter t <t@example.test> 1700200002 +0000\ndata 1\nx\ndeleteall\n`
    + Array.from({ length: 2100 }, (_, i) => `M 100644 :1 ${"p".repeat(4000)}-${i}\n`).join("") + "\n";
  execFileSync("git", ["fast-import", "--quiet"], { cwd: work, env: gitEnv, input: inventory });
  refused(await initialPush("import-inventory", git("rev-parse", "inventory")), /tip tree exceeds the 8388608-byte file inventory limit/);
  const content = "a".repeat(8 * 1024 * 1024);
  const bytes = `blob\nmark :1\ndata ${content.length}\n${content}\ncommit refs/heads/byte-tree\ncommitter t <t@example.test> 1700200001 +0000\ndata 1\nx\ndeleteall\n`
    + Array.from({ length: 33 }, (_, i) => `M 100644 :1 file-${i}\n`).join("") + "\n";
  execFileSync("git", ["fast-import", "--quiet"], { cwd: work, env: gitEnv, input: bytes });
  refused(await initialPush("import-bytes", git("rev-parse", "byte-tree")), /tip tree exceeds the 268435456-byte scan limit/);
});

test("empty-repository initialization keeps credential, ref-count, force and delete guards", async (t) => {
  const project = "empty-guards";
  assert.equal((await api("PUT", `/projects/${project}`, {})).status, 200);
  const url = (token) => remote(token, project);
  const send = (token, ...refs) => tryGit("push", "--porcelain", url(token), ...refs);
  const head = main();
  const { stillLanding } = server.git;
  server.git.stillLanding = async () => true;
  t.after(() => { server.git.stillLanding = stillLanding; });
  const landing = server.git.grants.mint({ project, kind: "landing", task: "t1", actor: AGENT,
    accepted: head, lease: "test-empty-lease" });
  refused(await send(landing.token, `${head}:refs/heads/main`), /landing merges onto main, which has no tip yet/);
  const agent = (await (await api("POST", "/tokens", { actor: AGENT, projects: [project] })).json()).token;
  refused(await send(agent, `${head}:refs/heads/main`), /401|Authentication failed/);
  const read = server.git.grants.mint({ project, kind: "read", actor: AGENT });
  refused(await send(read.token, `${head}:refs/heads/main`), /403/);
  assert.equal((await api("POST", `/projects/${project}/items`, { title: "Empty task" })).status, 201);
  const ledger = server.namespace.get(server.namespace.idFromName(`project:${project}`));
  await ledger.claim("t1", AGENT);
  const grantResponse = await api("POST", `/projects/${project}/git-token`, { kind: "task", item: "t1" }, agent, AGENT);
  assert.equal(grantResponse.status, 200, await grantResponse.clone().text());
  const task = (await grantResponse.json()).token;
  refused(await send(task, `${head}:refs/heads/main`), /this credential writes t\/1 only/);
  refused(await send(OWNER, `${head}:refs/heads/main`, `${head}:refs/heads/dev/other`), /one ref per push/);
  // Force is a client option, absent from the creation sent to receive-pack.
  // A forced creation must run the same tip scan and refuse a present key.
  const secret = commit("forced secret", head, { "force.env": `${KEY}\n` });
  refused(await send(OWNER, `+${secret}:refs/heads/main`), /secret scan found a key-shaped line: force\.env:1/);
  refused(await send(OWNER, ":refs/heads/main"), /no deletes: main stays/);
  // Nothing above may create even the second ref in the multi-ref push.
  const refs = await tryGit("ls-remote", url(OWNER));
  assert.equal(refs.status, 0, refs.stderr);
  assert.equal(refs.stdout.trim(), "");
});

test("abandoning a task drops the reports kept for it", async () => {
  const h = "c".repeat(40);
  await L().hookScanned("t4", h, [], [], false);
  assert.ok(await L().hookScan("t4", h));
  await L().abandon("t4", "owner", "not needed");
  assert.equal(await L().hookScan("t4", h), null);
});
