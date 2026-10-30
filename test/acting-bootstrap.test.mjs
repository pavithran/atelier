import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startServer } from "../src/runtime/server.mjs";
import worker, { Ledger } from "../src/index.ts";
import { Namespace } from "../src/runtime/namespace.mjs";
import { indexDump } from "../src/index-transfer.ts";
import { cleanEntry } from "../src/models/pool.ts";
import { registeredActing } from "../src/models/judgement.ts";

const OWNER = "atl_00112233445566778899aabbccddeeff00112233";
const OPUS = "claude-code/opus-5.5";
const model = (id = "opus-5.5", harness = "claude-code", aliases = []) =>
  cleanEntry({ id, harness, aliases, where: "home" }, "owner", "2026-10-30T00:00:00Z");
const GEMINI = model("gemini-4-argon-high", "gemini-cli");
const dumpOf = (...models) => indexDump({
  models: models.map((m) => ({ id: m.id, json: JSON.stringify(m) })),
  model_notes: [{ id: 1, model: "opus-5.5", json: JSON.stringify({ text: "Carried note", by: "owner", at: "2026-10-30T00:00:00Z" }) }],
  model_cards: [], model_assignments: [], runs: [],
}, null);

async function world(t, transport, pool = [GEMINI]) {
  const root = mkdtempSync(join(tmpdir(), "atelier-acting-bootstrap-"));
  let ns, request, close;
  t.after(async () => {
    try { await close?.(); } finally { rmSync(root, { recursive: true, force: true }); }
  });
  const env = { ATELIER_TOKEN: OWNER };
  if (transport === "HTTP") {
    const server = await startServer({ env: "test", dataDir: root, host: "127.0.0.1", vars: env, timers: false });
    ns = server.namespace;
    close = () => server.close();
    request = (path, options) => fetch(`${server.url}/api${path}`, options);
  } else {
    ns = new Namespace({ dir: root, Class: Ledger, env });
    env.LEDGER = ns;
    close = () => ns.close();
    request = (path, options) => worker.fetch(new Request(`http://localhost/api${path}`, options), env);
  }
  const I = ns.get(ns.idFromName("__index"));
  for (const m of pool) await I.putModel(m);
  const calls = [], around = ns.around;
  ns.around = async (name, method, args, go) => {
    calls.push({ name, method, args });
    return around ? around(name, method, args, go) : go();
  };
  const api = async (method, path, body, acting = OPUS) => {
    const res = await request(path, { method, headers: {
      authorization: `Bearer ${OWNER}`, "content-type": "application/json",
      "x-atelier-actor": "owner", "x-atelier-acting": acting,
    }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const attributed = (method, acting, name = "__index") => {
    const matches = calls.filter((c) => c.name === name && (c.method === method || c.method === "actingCall" && c.args[1] === method));
    assert.ok(matches.length, `${name}.${method} was called`);
    for (const c of matches) {
      assert.equal(c.method, "actingCall", `${method} carries acting attribution`);
      assert.equal(c.args[0], acting);
    }
  };
  return { I, api, calls, attributed, ns };
}

// Exercise identical cases through a real listener and directly through fetch,
// so the route and SQLite checks also run in sandboxes that forbid listeners.
for (const transport of ["HTTP", "in-process"]) {
  test(`${transport}: an import resolves its acting model from the resulting pool and attributes refreshed snapshots`, async (t) => {
    const w = await world(t, transport);
    const L = w.ns.get(w.ns.idFromName("project:demo"));
    await w.I.registerProject(await L.initProject({ name: "demo", repo: "demo" }, "owner"));
    const entry = model("opus-5.5", "claude-code", ["opus-bootstrap"]);
    for (const acting of [OPUS, "claude-code/opus-bootstrap", "CLAUDE-CODE/OPUS-5.5:high"]) {
      w.calls.length = 0;
      const res = await w.api("POST", "/index/import", { dump: dumpOf(entry) }, acting);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body.unreached, []);
      w.attributed("importIndex", OPUS);
      w.attributed("importIndexSnapshot", OPUS, "project:demo");
    }
    assert.equal((await w.I.models()).length, 2);
    assert.equal((await w.I.exportIndex()).counts.model_notes, 1);
  });

  test(`${transport}: an import missing the acting model refuses every row`, async (t) => {
    const w = await world(t, transport), before = await w.I.exportIndex();
    const res = await w.api("POST", "/index/import", { dump: dumpOf(model("gpt-6-astra", "codex")) });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "unregistered_acting");
    assert.deepEqual(await w.I.exportIndex(), before);
    assert.ok(!w.calls.some((c) => c.method === "actingCall" && c.args[1] === "importIndex"));
  });

  test(`${transport}: an import can use the current pool and refuses ambiguity across current and incoming aliases`, async (t) => {
    const held = model("first", "claude-code", ["shared"]);
    const incoming = model("second", "claude-code", ["shared"]);
    const w = await world(t, transport, [held]), before = await w.I.exportIndex();
    const refused = await w.api("POST", "/index/import", { dump: dumpOf(incoming) }, "claude-code/shared");
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error, "ambiguous_acting");
    assert.deepEqual(await w.I.exportIndex(), before);
    const accepted = await w.api("POST", "/index/import", { dump: dumpOf(incoming) }, "claude-code/first");
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    w.attributed("importIndex", "claude-code/first");
  });

  for (const method of ["POST", "PUT"]) {
    const path = method === "POST" ? "/models" : "/models/opus-5.5";
    test(`${transport}: ${method} models accepts its own id, alias and profile and records the exact entry`, async (t) => {
      const w = await world(t, transport);
      const entry = model("opus-5.5", "claude-code", ["opus-bootstrap"]);
      for (const acting of [OPUS, "claude-code/opus-bootstrap", "CLAUDE-CODE/OPUS-5.5:high"]) {
        await w.I.removeModel(entry.id);
        w.calls.length = 0;
        const res = await w.api(method, path, entry, acting);
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.id, entry.id);
        w.attributed("putModel", OPUS);
      }
    });

    test(`${transport}: ${method} models refuses another unregistered actor and preserves the pool`, async (t) => {
      const w = await world(t, transport), before = await w.I.exportIndex();
      const entry = model("opus-5.5", "codex");
      const res = await w.api(method, path, entry);
      assert.equal(res.status, 400);
      assert.equal(res.body.error, "unregistered_acting");
      assert.deepEqual(await w.I.exportIndex(), before);
    });

    test(`${transport}: ${method} models accepts another registered actor under the existing rules`, async (t) => {
      const w = await world(t, transport);
      const acting = "gemini-cli/gemini-4-argon-high";
      assert.equal((await w.api(method, path, model(), acting)).status, 200);
      w.attributed("putModel", acting);
    });
  }

  test(`${transport}: ambiguous import and model-add names retain the acting error details`, async (t) => {
    const entries = [model("first", "claude-code", ["shared"]), model("second", "claude-code", ["shared"])];
    const w = await world(t, transport, entries), before = await w.I.exportIndex();
    let expected;
    try { registeredActing("claude-code/shared", entries); } catch (err) { expected = err; }
    for (const [method, path, body] of [
      ["POST", "/index/import", { dump: dumpOf(model()) }],
      ["POST", "/models", model()],
      ["PUT", "/models/opus-5.5", model()],
    ]) {
      const res = await w.api(method, path, body, "claude-code/shared");
      assert.equal(res.status, 400);
      assert.equal(res.body.error, "ambiguous_acting");
      assert.equal(res.body.detail, expected.detail);
      assert.deepEqual(await w.I.exportIndex(), before);
    }
    // Ambiguity introduced by incoming rows must also refuse the entire dump.
    const fresh = await world(t, transport);
    const incoming = await fresh.api("POST", "/index/import", { dump: dumpOf(...entries) }, "claude-code/shared");
    assert.equal(incoming.body.error, "ambiguous_acting");
    assert.equal((await fresh.I.exportIndex()).counts.models, 1);
    assert.equal((await fresh.I.exportIndex()).counts.model_notes, 0);
  });

  test(`${transport}: an empty pool keeps a well-formed acting name when no entry resolves it`, async (t) => {
    for (const [method, path, body, write] of [
      ["POST", "/index/import", { dump: dumpOf() }, "importIndex"],
      ["POST", "/models", model("other"), "putModel"],
      ["PUT", "/models/other", model("other"), "putModel"],
    ]) {
      const w = await world(t, transport, []);
      const res = await w.api(method, path, body);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      w.attributed(write, OPUS);
    }
  });
}
