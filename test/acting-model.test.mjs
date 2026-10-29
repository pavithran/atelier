// G18 (lessons-to-2.0, t16, t339): acts through the developer token record
// the acting model. Each test starts the real server under Node with a data
// directory of its own and drives it as the CLI does. Every credential here
// is a dummy.
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { startServer } from "../src/runtime/server.mjs";
import { ownerWriteRefusal } from "../src/models/judgement.ts";
import { pushActors } from "../src/rules.ts";

const run = promisify(execFile);
const OWNER = "atl_00112233445566778899aabbccddeeff";
const OPUS = "claude-code/opus-5.5";
const GPT = "codex/gpt-6";
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

async function world(t) {
  const root = mkdtempSync(join(tmpdir(), "atelier-acting-"));
  dirs.push(root);
  const secrets = join(root, "secrets");
  mkdirSync(secrets, { mode: 0o700 });
  writeFileSync(join(secrets, "ATELIER_TOKEN"), OWNER, { mode: 0o600 });
  const server = await startServer({ env: "staging", dataDir: join(root, "data"), host: "127.0.0.1", secretsDir: secrets });
  t.after(() => server.close());
  const api = async (method, path, body, headers = {}) => {
    const res = await fetch(`${server.url}/api${path}`, { method, headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json", "x-atelier-actor": "owner", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const config = join(root, "config");
  mkdirSync(config);
  const cli = async (argv, extra = {}) => {
    const env = { ...process.env, ATELIER_CONFIG_DIR: config, ATELIER_TOKEN: OWNER, ATELIER_SERVER: server.url, ATELIER_SECRET_STORE: "file", NO_COLOR: "1", ...extra };
    for (const k of ["ATELIER_PROJECT", "ATELIER_ACTOR", "ATELIER_ACTING", "ATELIER_JSON"]) if (!(k in extra)) delete env[k];
    try { const { stdout, stderr } = await run(process.execPath, ["cli/atelier.mjs", ...argv], { env, timeout: 60_000 }); return { code: 0, stdout, stderr }; }
    catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  };
  assert.equal((await api("PUT", "/projects/demo", {}, { "x-atelier-acting": OPUS })).status, 200);
  const detail = async (id) => (await api("GET", `/projects/demo/items/${id}`)).body;
  return { server, api, cli, detail };
}

test("a write on the developer token with no acting model is refused, naming --as; reads are free", async (t) => {
  const w = await world(t);
  // The raw route: no acting header, the developer's actor.
  const raw = await w.api("POST", "/projects/demo/items", { title: "Nobody named" });
  assert.equal(raw.status, 400);
  assert.equal(raw.body.error, "acting_required");
  assert.match(raw.body.next, /--as H\/M/);
  // The CLI: the refusal and its next, as text and as JSON.
  const text = await w.cli(["new", "Nobody named", "--project", "demo"]);
  assert.equal(text.code, 1, text.stdout);
  assert.match(text.stderr, /acting_required/);
  assert.match(text.stderr, /next: add --as H\/M/);
  const asJson = await w.cli(["new", "Nobody named", "--project", "demo", "--duplicate-ok"], { ATELIER_JSON: "1" });
  assert.equal(asJson.code, 1);
  const refusal = JSON.parse(asJson.stderr.trim().split("\n").at(-1));
  assert.equal(refusal.code, "acting_required");
  assert.match(refusal.next, /--as H\/M/);
  // Nothing was filed by either.
  assert.equal((await w.api("GET", "/projects/demo")).body.items.length, 0, "reads need no acting model");
  assert.equal((await w.cli(["ls", "--project", "demo"])).code, 0);
  // The same write naming the model is taken: with --as on an owner-only
  // verb, with ATELIER_ACTING, or under a model's own actor.
  assert.equal((await w.cli(["new", "Named by ATELIER_ACTING", "--project", "demo"], { ATELIER_ACTING: OPUS })).code, 0);
  assert.equal((await w.api("POST", "/projects/demo/items", { title: "A model's own actor" }, { "x-atelier-actor": OPUS })).status, 201);
});

test("the rule: reads free, a write names a model or is a runner's own report, and leaving it out never passes", () => {
  assert.equal(ownerWriteRefusal("GET", "owner", "owner", null, false), null);
  assert.equal(ownerWriteRefusal("HEAD", "owner", "owner", null, false), null);
  assert.equal(ownerWriteRefusal("POST", "owner", "owner", OPUS, false), null);
  assert.equal(ownerWriteRefusal("POST", OPUS, "owner", null, false), null, "a model's own actor names it");
  assert.equal(ownerWriteRefusal("POST", "owner", "owner", null, true), null, "a runner's report on a runner route");
  for (const [method, actor] of [["POST", "owner"], ["PUT", "owner"], ["DELETE", "owner"], ["POST", "atelier/integrator"], ["POST", "pavi"]]) {
    const r = ownerWriteRefusal(method, actor, "owner", null, false);
    assert.equal(r?.code, "acting_required", `${method} as ${actor}`);
    assert.match(r.next, /--as H\/M/);
  }
});

test("every write on the developer token records the acting model, the verbs that need words record them, and show lists both", async (t) => {
  const w = await world(t);
  const made = await w.cli(["new", "Acted on", "--project", "demo", "--scope", "src/**", "--accept", "the first criterion"], { ATELIER_ACTING: OPUS });
  assert.equal(made.code, 0, made.stderr);
  const id = /\bt\d+\b/.exec(made.stdout)[0];
  assert.equal((await w.cli(["edit", id, "--project", "demo", "--title", "Acted on, renamed", "--as", OPUS])).code, 0);
  const blocked = await w.cli(["block", id, "waiting on the developer", "--project", "demo", "--quote", "block it until Monday", "--as", OPUS]);
  assert.equal(blocked.code, 0, blocked.stderr);
  const events = (await w.detail(id)).events.filter((e) => e.itemId === id);
  for (const kind of ["item.created", "criteria.revised", "item.edited", "item.blocked"]) {
    const e = events.find((x) => x.kind === kind);
    assert.ok(e, `${kind} recorded`);
    assert.equal(e.data.acting, OPUS, `${kind} names the acting model`);
  }
  assert.equal(events.find((e) => e.kind === "item.created").actor, "owner", "the event stays the developer's, the model beside it");
  assert.equal(events.find((e) => e.kind === "item.blocked").data.quote, "block it until Monday");
  // A block on the developer token without the words is refused: the verb needs them.
  const unworded = await w.cli(["unblock", id, "--project", "demo", "--as", OPUS]);
  assert.equal(unworded.code, 1);
  assert.match(unworded.stderr, /direction_needed/);
  // show lists each act, the model and the words.
  const shown = await w.cli(["show", id, "--project", "demo"]);
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, /Acts on the developer token:/);
  assert.match(shown.stdout, new RegExp(`item\\.created by owner, acting ${OPUS}`));
  assert.match(shown.stdout, new RegExp(`item\\.blocked by owner, acting ${OPUS}, on the developer's words: “block it until Monday”`));
  const acted = JSON.parse((await w.cli(["show", id, "--project", "demo", "--json"])).stdout).acted;
  assert.deepEqual(acted.map((a) => a.kind), ["item.created", "criteria.revised", "item.edited", "item.blocked"]);
  assert.ok(acted.every((a) => a.acting === OPUS));
  assert.equal(acted.at(-1).quote, "block it until Monday");
});

test("criteria a model wrote through the developer token are its own: the same model is refused as their reviewer", async (t) => {
  const w = await world(t);
  const made = await w.cli(["new", "Criteria by a model", "--project", "demo", "--duplicate-ok"], { ATELIER_ACTING: OPUS });
  const id = /\bt\d+\b/.exec(made.stdout)[0];
  assert.equal((await w.cli(["edit", id, "--project", "demo", "--accept", "a criterion the model drafted", "--as", OPUS])).code, 0);
  const revised = (await w.detail(id)).events.find((e) => e.itemId === id && e.kind === "criteria.revised");
  assert.equal(revised.actor, OPUS, "the revision's author is the acting model, not the developer");
  for (const reviewer of [OPUS, "antigravity/claude-opus-5-5"]) {
    const r = await w.cli(["criteria-review", id, "--project", "demo", "--reviewer", reviewer, "--as", GPT]);
    assert.equal(r.code, 1, `${reviewer}: ${r.stdout}`);
    assert.match(r.stderr, /no_criteria_reviewer/);
    assert.match(r.stderr, new RegExp(`${reviewer} wrote these criteria, and nobody reviews their own work`));
  }
  // A model of another family may review them.
  const other = await w.cli(["criteria-review", id, "--project", "demo", "--reviewer", GPT, "--as", OPUS]);
  assert.equal(other.code, 0, other.stderr);
  assert.match(other.stdout, new RegExp(`Asked ${GPT}`));
});

test("a push recorded on the developer token on a model's word counts that model, not the developer, as a contributor", () => {
  const claimed = { actor: GPT, kind: "item.claimed", data: {} };
  const released = { actor: GPT, kind: "item.released", data: {} };
  const ownerPush = { actor: "owner", kind: "push.observed", data: { head: "a".repeat(40), acting: OPUS } };
  assert.deepEqual(pushActors([claimed, released, ownerPush]).sort(), [GPT, OPUS].sort());
  // Unchanged without an acting model: the pusher counts as before.
  assert.deepEqual(pushActors([{ actor: GPT, kind: "push.observed", data: {} }]), [GPT]);
  // A model's own actor with itself as acting is one contributor.
  assert.deepEqual(pushActors([{ actor: OPUS, kind: "push.observed", data: { acting: OPUS } }]), [OPUS]);
});
