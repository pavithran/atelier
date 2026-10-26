import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ROUTE_LEVEL, SERVER_CAPABILITIES } from "../src/route-level.ts";

// t178: `atelier block|unblock|abandon|clear-secret --quote WORDS --as H/M`
// against a stand-in server. With the words, the command sends them in the
// body, the developer's actor and the acting model in X-Atelier-Acting; a
// quote without a model, or an agent's own token with a quote, ends the
// command before any request; without --quote the request is the one it was
// before, and a server that does not publish the capability is told so.

const cli = resolve("cli/atelier.mjs");
const OPUS = "claude-code/opus-5.5";
const WORDS = "yes, do it";
const CAPABILITY = "items.developer-direction.v1";

async function fixture(t, { capabilities = SERVER_CAPABILITIES, agentActor } = {}) {
  const root = mkdtempSync(join(tmpdir(), "atelier-item-direction-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout");
  mkdirSync(checkout);
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const answer = (status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.url === "/api/version") return answer(200, { commit: "abc", routeLevel: ROUTE_LEVEL, capabilities });
    if (req.url === "/api/config") return answer(200, { ownerActor: "owner", ...(agentActor ? { actor: agentActor } : {}) });
    requests.push({ method: req.method, path: req.url, actor: req.headers["x-atelier-actor"], acting: req.headers["x-atelier-acting"], body: raw ? JSON.parse(raw) : undefined });
    if (req.method === "GET") return answer(200, { item: { id: "t1", owner: "claude-code/opus-5.5" } });
    answer(200, { id: "t1", state: "claimed", blocked: { reason: "waiting" }, head: "1".repeat(40), secret: [], secretClearances: [] });
  });
  t.after(() => server.close());
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  writeFileSync(join(root, "config.json"), JSON.stringify({ projects: { proj: { path: checkout } } }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function run(argv, env = {}) {
    const { ATELIER_ACTOR: _, ATELIER_OWNER: __, ...inherited } = process.env;
    const child = spawn(process.execPath, [cli, ...argv, "--project", "proj"], {
      cwd: checkout, env: { ...inherited, ATELIER_CONFIG_DIR: root, ATELIER_CACHE: join(root, "cache"), ATELIER_TOKEN: "fake", ATELIER_SERVER: origin, ...env },
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (s) => stdout += s); child.stderr.on("data", (s) => stderr += s);
    const status = await new Promise((done) => child.on("close", done));
    return { status, stdout, stderr };
  }
  return { run, requests, posts: () => requests.filter((r) => r.method === "POST") };
}

const FORMS = [
  { verb: "block", argv: ["block", "t1", "waiting on the schema"], body: { reason: "waiting on the schema" } },
  { verb: "unblock", argv: ["unblock", "t1"], body: {} },
  { verb: "abandon", argv: ["abandon", "t1", "--note", "superseded"], body: { note: "superseded" } },
  { verb: "clear-secret", argv: ["clear-secret", "t1", "--note", "a fixture"], body: { reason: "a fixture" } },
];

for (const form of FORMS) {
  test(`atelier ${form.verb} --quote sends the words under the developer's actor with the acting model`, async (t) => {
    const f = await fixture(t);
    const r = await f.run([...form.argv, "--quote", WORDS, "--as", OPUS]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(f.posts(), [{ method: "POST", path: `/api/projects/proj/items/t1/${form.verb}`, actor: "owner", acting: OPUS, body: { ...form.body, quote: WORDS } }]);
    if (form.verb !== "clear-secret") assert.match(r.stdout, new RegExp(`Recorded on the developer's words, relayed by ${OPUS.replace("/", "\\/")}`));
  });

  test(`atelier ${form.verb} without --quote sends no words`, async (t) => {
    const f = await fixture(t);
    const r = await f.run(form.argv);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(f.posts(), [{ method: "POST", path: `/api/projects/proj/items/t1/${form.verb}`, actor: "owner", acting: undefined, body: form.body }]);
    assert.doesNotMatch(r.stdout, /developer's words/);
  });

  test(`atelier ${form.verb} --quote needs the model acting on the words, before any request`, async (t) => {
    const f = await fixture(t);
    const r = await f.run([...form.argv, "--quote", WORDS]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--quote needs the model acting on the developer's words: add --as H\/M/);
    assert.deepEqual(f.requests, []);
    const blank = await f.run([...form.argv, "--quote", "  ", "--as", OPUS]);
    assert.equal(blank.status, 1);
    assert.match(blank.stderr, /--quote needs the developer's words/);
    assert.deepEqual(f.requests, []);
  });

  test(`atelier ${form.verb} --quote is refused on a server without the capability, and with an agent's own token`, async (t) => {
    const old = await fixture(t, { capabilities: SERVER_CAPABILITIES.filter((n) => n !== CAPABILITY) });
    const r = await old.run([...form.argv, "--quote", WORDS, "--as", OPUS]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /lacks capabilities items\.developer-direction\.v1/);
    assert.deepEqual(old.requests, []);
    // Without --quote the older server is still used, as before.
    assert.equal((await old.run(form.argv)).status, 0);

    const agent = await fixture(t, { agentActor: OPUS });
    const own = await agent.run([...form.argv, "--quote", WORDS, "--as", OPUS], { ATELIER_TOKEN: "atl_agent-token" });
    assert.equal(own.status, 1);
    assert.deepEqual(agent.posts(), []);
  });
}

test("a model's call without --quote reaches the server as the model's own actor, with its acting header on abandon and clear-secret, which stops it", async (t) => {
  const f = await fixture(t);
  for (const form of FORMS) {
    const r = await f.run(form.argv, { ATELIER_ACTOR: OPUS });
    assert.equal(r.status, 0, r.stderr);
  }
  // Block and unblock name the model as the actor; the server stops a
  // developer-token call under any actor but the developer's.
  assert.deepEqual(f.posts().map((p) => [p.actor, p.acting]), [[OPUS, undefined], [OPUS, undefined], ["owner", OPUS], ["owner", OPUS]]);
  assert.ok(f.posts().every((p) => p.body.quote === undefined));
});
