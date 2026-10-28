// Atelier 2.0, task 5, the review's write-isolation findings: no runner can
// take another holder's task grant through the project's git-token route, and
// no task grant outlives the task's hold. A grant is answered 401 at info/refs
// once the task merges (the ordinary merge path, not record-merge), is handed
// over, abandoned or unclaimed, and once the agent token it was minted under
// is revoked. The advertised remote comes from the address the server
// accepted the connection on, never from the caller's Host header. Each test
// drives the real server over HTTP and pushes with the real git client to the
// real hook. Every credential here is a dummy.
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startServer } from "../src/runtime/server.mjs";

const OWNER = "atl_00112233445566778899aabbccddeeff";
const BUILDER = "opencode/glm-5.3";
const OTHER = "claude-code/opus-5.5";
const root = mkdtempSync(join(tmpdir(), "atelier-claim-grants-"));
after(() => rmSync(root, { recursive: true, force: true }));

const gitEnv = { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };
const run = (cmd, args, opts = {}) => new Promise((ok) => execFile(cmd, args, { env: gitEnv, encoding: "utf8", timeout: 60_000, ...opts },
  (err, stdout, stderr) => ok({ code: err ? (err.code ?? 1) : 0, stdout: stdout.trim(), stderr })));
const git = async (cwd, ...args) => {
  const r = await run("git", ["-c", "credential.helper=", ...args], { cwd });
  assert.equal(r.code, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};
const bearer = (token) => ["-c", `http.extraHeader=Authorization: Bearer ${token}`];

let server, base, seed, agentToken, otherToken;
const remote = () => `${base}/git/demo.git`;
const L = () => server.namespace.get(server.namespace.idFromName("project:demo"));
const api = async (method, path, body, token = OWNER, actor = "owner", extra = {}) => {
  const res = await fetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-atelier-actor": actor, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
// What the Git host answers a credential's read at info/refs.
const infoRefs = async (token) => (await fetch(`${remote()}/info/refs?service=git-upload-pack`, { headers: { authorization: `Bearer ${token}` } })).status;
const newTask = async (title) => {
  const r = await api("POST", "/projects/demo/items", { title, scope: ["src/**"] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.id;
};
// An agent's claim through the route; answers its task grant.
async function claim(id, token = agentToken, actor = BUILDER) {
  const r = await api("POST", `/projects/demo/items/${id}/claim`, {}, token, actor);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.workspace.token;
}
// A commit on the project's tip writing `file`, pushed to t/N with `grant`.
async function pushTask(id, grant, file) {
  const dir = join(root, `work-${id}-${file}`);
  await git(root, ...bearer(OWNER), "clone", "-q", remote(), dir);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", file), `${file}\n`);
  await git(dir, "add", ".");
  await git(dir, "commit", "-q", "-m", `add ${file}`);
  const r = await run("git", ["-c", "credential.helper=", ...bearer(grant), "push", "-q", remote(), `HEAD:refs/heads/t/${id.slice(1)}`], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  return { dir, head: await git(dir, "rev-parse", "HEAD") };
}

before(async () => {
  server = await startServer({ env: "test", dataDir: join(root, "data"), host: "127.0.0.1", vars: { ATELIER_TOKEN: OWNER } });
  base = server.url.replace("localhost", "127.0.0.1");
  assert.equal((await api("PUT", "/projects/demo", { checks: ["git status"] })).status, 200);
  seed = join(root, "seed");
  mkdirSync(seed);
  await git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "a.txt"), "one\n");
  await git(seed, "add", ".");
  await git(seed, "commit", "-q", "-m", "first");
  await git(seed, ...bearer(OWNER), "push", "-q", remote(), "HEAD:refs/heads/main");
  agentToken = (await api("POST", "/tokens", { actor: BUILDER, projects: ["demo"] })).body.token;
  otherToken = (await api("POST", "/tokens", { actor: OTHER, projects: ["demo"] })).body.token;
});
after(async () => { await server?.close(); });

test("a runner that does not hold the task's job cannot take its grant through git-token, posing as the holder; the holder's runner can", async () => {
  const id = await newTask("Held by runner a");
  assert.equal((await api("POST", `/projects/demo/items/${id}/dispatch`, { to: "home", agent: "opencode" })).status, 200);
  const runners = {};
  for (const name of ["home:a", "home:b"]) {
    runners[name] = (await api("POST", "/tokens", { runner: name, projects: ["demo"] })).body.token;
    const polled = await api("POST", "/queue", { runner: name, kind: "home", jobs: ["build"], agents: [{ agent: "opencode", models: ["glm-5.3"] }] }, runners[name], `runner/${name.slice(5)}`);
    assert.equal(polled.status, 200, JSON.stringify(polled.body));
  }
  const claimed = await api("POST", `/projects/demo/items/${id}/claim`, {}, runners["home:a"], BUILDER, { "x-atelier-runner": "home:a" });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  const grant = claimed.body.workspace.token;
  const recorded = await L().tokenId(id);
  // Runner b names the holder's actor and asks for the task grant.
  const taken = await api("POST", "/projects/demo/git-token", { kind: "task", item: id }, runners["home:b"], BUILDER);
  assert.ok(taken.status === 403 || taken.status === 409, JSON.stringify(taken.body));
  assert.equal(taken.body.token, undefined, "no credential was issued");
  assert.equal(await L().tokenId(id), recorded, "the holder's grant was not rotated away");
  assert.equal(await infoRefs(grant), 200);
  // Runner b is refused for a task nobody dispatched to it as well.
  const loose = await newTask("Claimed by an agent");
  await claim(loose);
  const posed = await api("POST", "/projects/demo/git-token", { kind: "task", item: loose }, runners["home:b"], BUILDER);
  assert.ok(posed.status === 403 || posed.status === 409, JSON.stringify(posed.body));
  // The holder's own runner may rotate its grant.
  const own = await api("POST", "/projects/demo/git-token", { kind: "task", item: id }, runners["home:a"], BUILDER, { "x-atelier-runner": "home:a" });
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.equal(await infoRefs(grant), 401, "the rotated grant is dead");
  assert.equal(await infoRefs(own.body.token), 200);
});

test("an agent token gets a task grant only for its own actor", async () => {
  const id = await newTask("Held by the builder");
  const grant = await claim(id);
  const posed = await api("POST", "/projects/demo/git-token", { kind: "task", item: id }, otherToken, BUILDER);
  assert.equal(posed.status, 403, JSON.stringify(posed.body));
  assert.equal(posed.body.token, undefined);
  assert.equal(await infoRefs(grant), 200);
});

test("the ordinary merge clears the task's grant with the merge: the old grant is answered 401", async () => {
  const id = await newTask("Merged");
  const grant = await claim(id);
  const { head } = await pushTask(id, grant, "merged.txt");
  assert.equal((await api("POST", `/projects/demo/items/${id}/push`, { head }, agentToken, BUILDER)).status, 200);
  const checked = await api("POST", `/projects/demo/items/${id}/evidence`, { kind: "check", claim: "git status", head, passed: true }, agentToken, BUILDER);
  assert.equal(checked.status, 200, JSON.stringify(checked.body));
  const submitted = await api("POST", `/projects/demo/items/${id}/submit`, { summary: "done", head }, agentToken, BUILDER);
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  const accepted = await api("POST", `/projects/demo/items/${id}/accept`, { head });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(await infoRefs(grant), 200, "accepted, the holder still holds it");
  // The developer's merge of the accepted head onto main, then the merged route.
  await git(seed, ...bearer(OWNER), "fetch", "-q", remote(), "main");
  await git(seed, "reset", "-q", "--hard", "FETCH_HEAD");
  await git(seed, ...bearer(OWNER), "fetch", "-q", remote(), `refs/heads/t/${id.slice(1)}`);
  await git(seed, "merge", "-q", "--no-ff", "-m", `Merge ${id}`, "FETCH_HEAD");
  await git(seed, ...bearer(OWNER), "push", "-q", remote(), "HEAD:refs/heads/main");
  const merged = await api("POST", `/projects/demo/items/${id}/merged`, { mergeCommit: await git(seed, "rev-parse", "HEAD") });
  assert.equal(merged.status, 200, JSON.stringify(merged.body));
  assert.equal(merged.body.state, "merged");
  assert.equal(await L().tokenId(id), null, "the merge took the write token with it");
  assert.equal(await infoRefs(grant), 401);
});

test("handoff, abandon and unclaim each leave the old task grant answered 401", async () => {
  const handed = await newTask("Handed over");
  const g1 = await claim(handed);
  const h = await api("POST", `/projects/demo/items/${handed}/handoff`, { to: OTHER, note: "yours now" }, agentToken, BUILDER);
  assert.equal(h.status, 200, JSON.stringify(h.body));
  assert.equal(await infoRefs(g1), 401, "handoff");

  const dropped = await newTask("Abandoned");
  const g2 = await claim(dropped);
  const a = await api("POST", `/projects/demo/items/${dropped}/abandon`, { note: "not needed" });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(await L().tokenId(dropped), null);
  assert.equal(await infoRefs(g2), 401, "abandon");

  // A claim given up after its grant was made (the claim route's own
  // rollback, Ledger.unclaim) leaves the grant's actor holding nothing.
  const rolled = await newTask("Unclaimed");
  await L().claim(rolled, BUILDER);
  const minted = await api("POST", "/projects/demo/git-token", { kind: "task", item: rolled }, agentToken, BUILDER);
  assert.equal(minted.status, 200, JSON.stringify(minted.body));
  assert.equal(await infoRefs(minted.body.token), 200);
  await L().unclaim(rolled, BUILDER, "a test's rollback");
  assert.equal((await L().item(rolled)).owner, null);
  assert.equal(await infoRefs(minted.body.token), 401, "unclaim");
});

test("revoking the agent token revokes the task grant and the read grant minted under it", async () => {
  const made = await api("POST", "/tokens", { actor: "codex/gpt-6", projects: ["demo"] });
  const id = await newTask("Revoked with its token");
  const grant = await claim(id, made.body.token, "codex/gpt-6");
  const read = await api("POST", "/projects/demo/git-token", { kind: "read" }, made.body.token, "codex/gpt-6");
  assert.equal(read.status, 200);
  assert.equal(await infoRefs(grant), 200);
  assert.equal(await infoRefs(read.body.token), 200);
  assert.equal((await api("DELETE", `/tokens/${made.body.id}`)).body.revoked, true);
  assert.equal(await infoRefs(grant), 401);
  assert.equal(await infoRefs(read.body.token), 401);
});

// One request over node:http, where the Host header and any header can be set.
function raw(path, headers, body) {
  return new Promise((ok, fail) => {
    const url = new URL(path, base);
    const req = httpRequest({ host: url.hostname, port: url.port, path: url.pathname, method: "PUT", headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json", "x-atelier-actor": "owner", ...headers } }, (res) => {
      let text = "";
      res.on("data", (d) => { text += d; });
      res.on("end", () => ok({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on("error", fail);
    req.end(JSON.stringify(body ?? {}));
  });
}

test("the advertised remote is the address the server accepted the connection on, whatever Host or x-atelier-git-origin the caller sends", async () => {
  const port = new URL(base).port;
  const plain = await raw("/api/projects/demo", {});
  assert.equal(plain.status, 200, JSON.stringify(plain.body));
  assert.equal(plain.body.baseline.remote, `http://127.0.0.1:${port}/git/demo.git`);
  const forged = await raw("/api/projects/demo", { host: "evil.example", "x-atelier-git-origin": "http://evil.example" });
  assert.equal(forged.body.baseline.remote, `http://127.0.0.1:${port}/git/demo.git`, "neither the Host nor the caller's header names the remote");
  const tailnetHost = await raw("/api/projects/demo", { host: "100.99.0.102:4100" });
  assert.equal(tailnetHost.body.baseline.remote, `http://127.0.0.1:${port}/git/demo.git`);
  // A loopback request that came through the tunnel is given the public origin.
  const tunnelled = await raw("/api/projects/demo", { "cf-connecting-ip": "203.0.113.9", "x-atelier-git-origin": "http://127.0.0.1:1" });
  assert.equal(tunnelled.body.baseline.remote, `http://localhost:${new URL(server.url).port}/git/demo.git`);
});
