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
import { execFileSync } from "node:child_process";
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
  const res = await fetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-atelier-actor": actor, ...(token === OWNER ? { "x-atelier-acting": "claude-code/opus-5.5" } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
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
  assert.equal((await api("POST", `/projects/demo/items/${id}/dispatch`, { to: "home", agent: "opencode", model: "glm-5.3" })).status, 200);
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
  // Since task 6 only a landing grant moves main over Git; the fixture
  // writes the bare repository, standing in for that landing's push.
  await git(join(root, "data", "repos", "demo.git"), "fetch", "-q", seed, "HEAD:refs/heads/main");
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
  const a = await api("POST", `/projects/demo/items/${dropped}/abandon`, { note: "not needed", quote: "abandon it" });
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
function raw(path, headers, body, target = null) {
  return new Promise((ok, fail) => {
    const url = new URL(path, base);
    const req = httpRequest({ host: url.hostname, port: url.port, path: target ?? url.pathname, method: "PUT", headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json", "x-atelier-actor": "owner", "x-atelier-acting": "claude-code/opus-5.5", ...headers } }, (res) => {
      let text = "";
      res.on("data", (d) => { text += d; });
      res.on("end", () => { let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; } ok({ status: res.statusCode, body: parsed }); });
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

test("a request target that is not a path starting with one / is refused, and forwarding headers do not move the public remote", async () => {
  for (const target of ["http://evil.example/api/projects/demo", "//evil.example/api/projects/demo"]) {
    const r = await raw("/api/projects/demo", {}, {}, target);
    assert.equal(r.status, 400, `${target}: ${JSON.stringify(r.body)}`);
  }
  const forwarded = await raw("/api/projects/demo", { "x-forwarded-for": "203.0.113.9", "x-forwarded-host": "evil.example", "x-forwarded-proto": "https", host: "evil.example" });
  assert.equal(forwarded.status, 200, JSON.stringify(forwarded.body));
  assert.equal(forwarded.body.baseline.remote, `${server.settings.PUBLIC_ORIGIN}/git/demo.git`);
});

// A push whose request is let in while its grant is live, its pack held back
// while `during` runs: started 400 ms after the headers, given 400 ms more
// before the pack is sent. Answers whether `during` had finished by then.
async function heldPush(id, grant, during) {
  const dir = join(root, `held-${id}`);
  await git(root, ...bearer(OWNER), "clone", "-q", "--single-branch", "--branch", `t/${id.slice(1)}`, remote(), dir);
  const old = await git(dir, "rev-parse", "HEAD");
  writeFileSync(join(dir, "held.txt"), "held back\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-q", "-m", "held back");
  const sha = await git(dir, "rev-parse", "HEAD");
  const pack = execFileSync("git", ["pack-objects", "--stdout", "--revs"], { cwd: dir, input: `${sha}\n^${old}\n`, env: gitEnv });
  const line = `${old} ${sha} refs/heads/t/${id.slice(1)}\0report-status\n`;
  const body = Buffer.concat([Buffer.from(`${(line.length + 4).toString(16).padStart(4, "0")}${line}0000`), pack]);
  const url = new URL(`${remote()}/git-receive-pack`);
  let change, doneBeforePack = null, finished = false;
  const answer = await new Promise((ok, fail) => {
    const req = httpRequest({ host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { authorization: `Bearer ${grant}`, "content-type": "application/x-git-receive-pack-request", "content-length": body.length } }, (res) => {
      let text = "";
      res.on("data", (d) => { text += d; });
      res.on("end", () => ok({ status: res.statusCode, text }));
    });
    req.on("error", fail);
    req.flushHeaders();
    // The server authorises on the headers alone; the pack follows later.
    setTimeout(() => {
      change = during().then(() => { finished = true; });
      setTimeout(() => { doneBeforePack = finished; req.end(body); }, 400);
    }, 400);
  });
  await change;
  return { old, sha, doneBeforePack, ...answer };
}
const tipOf = async (id) => (await run("git", [...bearer(OWNER), "ls-remote", remote(), `refs/heads/t/${id.slice(1)}`])).stdout.split("\t")[0];

test("a change that ends a grant waits for the push in flight on its task, and the grant is dead once it returns", async () => {
  for (const [what, stop] of [
    ["released", async (id) => assert.equal((await api("POST", `/projects/demo/items/${id}/release`, { note: "mid-push" }, agentToken, BUILDER)).status, 200)],
    ["handed over", async (id) => assert.equal((await api("POST", `/projects/demo/items/${id}/handoff`, { to: OTHER, note: "mid-push" }, agentToken, BUILDER)).status, 200)],
    ["abandoned", async (id) => assert.equal((await api("POST", `/projects/demo/items/${id}/abandon`, { note: "mid-push", quote: "abandon it" })).status, 200)],
  ]) {
    const id = await newTask(`Held push, ${what}`);
    const grant = await claim(id);
    const r = await heldPush(id, grant, () => stop(id));
    assert.equal(r.doneBeforePack, false, `${what}: the change waited for the push`);
    assert.match(r.text, /ok refs\/heads\/t\//, `${what}: the push let in first lands: ${r.text}`);
    assert.equal(await tipOf(id), r.sha);
    assert.equal(await infoRefs(grant), 401, `${what}: then the grant is dead`);
  }
  // Revoking the agent token waits for its grant's push the same way.
  const made = await api("POST", "/tokens", { actor: "codex/gpt-6", projects: ["demo"] });
  const id = await newTask("Held push, token revoked");
  const grant = await claim(id, made.body.token, "codex/gpt-6");
  const r = await heldPush(id, grant, async () => assert.equal((await api("DELETE", `/tokens/${made.body.id}`)).body.revoked, true));
  assert.equal(r.doneBeforePack, false);
  assert.match(r.text, /ok refs\/heads\/t\//, r.text);
  assert.equal(await infoRefs(grant), 401);
});

test("a change made to the Ledger without the lock is still caught at hook time: the push is refused and the ref stays", async (t) => {
  // Every Ledger stub call that ends a grant takes the lock; with the
  // runtime's wrapper taken away, the change lands mid-push, as one made
  // inside the Ledger itself would, and only the hook's check stands.
  const around = server.namespace.around;
  server.namespace.around = null;
  t.after(() => { server.namespace.around = around; });
  for (const [what, stop] of [
    ["handed over", async (id) => { await L().handoff(id, BUILDER, OTHER, "behind the route", false, await L().tokenId(id)); }],
    ["abandoned", async (id) => { await L().abandon(id, "owner", "behind the route", await L().tokenId(id)); }],
  ]) {
    const id = await newTask(`Hook check, ${what}`);
    const grant = await claim(id);
    const r = await heldPush(id, grant, () => stop(id));
    assert.equal(r.doneBeforePack, true);
    assert.match(r.text, /ng refs\/heads\/t\/\d+ pre-receive hook declined/, `${what}: ${r.text}`);
    assert.equal(await tipOf(id), r.old, `${what}: the ref did not move`);
  }
});

test("the hook's grant check is a loopback listener of its own that answers only the hook's secret", async () => {
  const check = server.git.callback;
  assert.match(check, /^http:\/\/127\.0\.0\.1:\d+\/internal\/grant-live$/);
  assert.notEqual(new URL(check).port, new URL(base).port);
  const ask = (url, headers) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ grant: "owner" }) });
  assert.equal((await ask(check, {})).status, 404, "no secret");
  assert.equal((await ask(check, { "x-atelier-hook-secret": "0".repeat(64) })).status, 404, "a wrong secret");
  const right = await ask(check, { "x-atelier-hook-secret": server.git.hookSecret });
  assert.equal(right.status, 200);
  assert.deepEqual(await right.json(), { live: true });
  assert.equal((await fetch(check, { headers: { "x-atelier-hook-secret": server.git.hookSecret } })).status, 404, "a GET");
  const main = await ask(`${base}/internal/grant-live`, { "x-atelier-hook-secret": server.git.hookSecret });
  assert.notEqual(main.status, 200, "the public listener does not answer it");
});
