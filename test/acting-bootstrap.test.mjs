import { createHash } from "node:crypto";
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
  const api = async (method, path, body, acting = OPUS, { token = OWNER, actor = "owner" } = {}) => {
    const res = await request(path, { method, headers: {
      authorization: `Bearer ${token}`, "content-type": "application/json",
      "x-atelier-actor": actor, ...(acting === null ? {} : { "x-atelier-acting": acting }),
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
  const routes = [
    ["POST", "/index/import", { dump: dumpOf(model()) }],
    ["POST", "/models", model()],
    ["PUT", "/models/opus-5.5", model()],
    ["POST", "/model-roles", {}],
    ["POST", "/model-roles/a1/withdraw", { note: "Test withdrawal" }],
  ];
  test(`${transport}: deferred routes retain header and owner checks before writing`, async (t) => {
    const w = await world(t, transport), before = await w.I.exportIndex();
    for (const [method, path, body] of routes) {
      const missing = await w.api(method, path, body, null);
      assert.equal(missing.status, 400);
      assert.equal(missing.body.error, "acting_required");
      assert.match(missing.body.next, /--as/);
      const malformed = await w.api(method, path, body, "not-a-model");
      assert.equal(malformed.status, 400);
      assert.equal(malformed.body.error, "bad_acting");
      const other = await w.api(method, path, body, OPUS, { actor: "codex/gpt-6-astra" });
      assert.equal(other.status, 403);
      assert.equal(other.body.error, "not_project_owner");
    }
    for (const runner of [undefined, "home:test"]) {
      const token = runner ? "atl_runner_bootstrap" : "atl_agent_bootstrap";
      await w.I.putAgentToken({ id: runner ?? "agent", actor: "codex/gpt-6-astra",
        hash: createHash("sha256").update(token).digest("hex"), createdAt: "2026-10-30T00:00:00Z",
        expiresAt: "2099-01-01T00:00:00Z", ...(runner ? { runner, projects: ["demo"] } : {}) });
      for (const [method, path, body] of routes) {
        for (const acting of [null, OPUS]) {
          const res = await w.api(method, path, body, acting, { token, actor: "codex/gpt-6-astra" });
          assert.equal(res.status, 403, `${runner ?? "agent"}: ${path}`);
          if (acting) assert.equal(res.body.error, "acting_owner_only");
        }
      }
    }
    assert.deepEqual(await w.I.exportIndex(), before);
  });

  test(`${transport}: model-roles retries defer pool resolution and retain recorded event acting`, async (t) => {
    const w = await world(t, transport, [GEMINI, model()]);
    const L = w.ns.get(w.ns.idFromName("project:demo"));
    await w.I.registerProject(await L.initProject({ name: "demo", repo: "demo" }, "owner"));
    await L.newItem("Evidence", [], "owner");
    const body = { request: "bootstrap-role-retry", role: "review", choices: [OPUS],
      reason: "Review experience", quote: "Use opus", evidence: ["demo/t1"] };
    const first = await w.api("POST", "/model-roles", body);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal((await w.I.assignmentEvents())[0].data.acting, OPUS);
    await w.I.removeModel("opus-5.5");
    const retry = await w.api("POST", "/model-roles", body);
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(retry.body.retried, true);
    assert.equal((await w.I.assignmentEvents()).length, 1);
  });

  test(`${transport}: import validates before resolving an absent actor and accepts omitted legacy aliases`, async (t) => {
    const w = await world(t, transport), before = await w.I.exportIndex();
    for (const dump of [{}, dumpOf({ ...model(), harness: undefined }), dumpOf({ ...model(), harness: 42 }),
      dumpOf({ ...model(), aliases: null }), dumpOf({ ...model(), aliases: [42] })]) {
      const res = await w.api("POST", "/index/import", { dump });
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.equal(res.body.error, "bad_index");
      assert.deepEqual(await w.I.exportIndex(), before);
    }
    // Neither entry answers to the declared name: aliases must be safe to read.
    const legacy = { ...model("legacy"), aliases: undefined };
    const refused = await w.api("POST", "/index/import", { dump: dumpOf(legacy) });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error, "unregistered_acting");
    assert.deepEqual(await w.I.exportIndex(), before);
    const accepted = await w.api("POST", "/index/import", { dump: dumpOf(legacy, model()) });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.deepEqual((await w.I.models()).find((m) => m.id === "legacy").aliases, []);
    assert.equal((await w.api("POST", "/models", model("another"), "claude-code/absent")).body.error, "unregistered_acting");
  });

  for (const method of ["POST", "PUT"]) {
    test(`${transport}: ${method} resolves cross-entry aliases, case and profiles against the resulting pool`, async (t) => {
      for (const [held, incoming, acting] of [
        [model("first", "claude-code", ["shared"]), model("second", "claude-code", ["shared"]), "claude-code/shared"],
        [model("Opus-5.5"), model("OPUS-5.5"), "claude-code/opus-5.5"],
        [model("opus-5.5:low"), model("opus-5.5:high"), "claude-code/opus-5.5"],
      ]) {
        const w = await world(t, transport, [held]);
        const before = await w.I.exportIndex();
        const res = await w.api(method, method === "POST" ? "/models" : `/models/${incoming.id}`, incoming, acting);
        assert.equal(res.status, 400, JSON.stringify(res.body));
        assert.equal(res.body.error, "ambiguous_acting");
        assert.deepEqual(await w.I.exportIndex(), before);
      }
    });
    test(`${transport}: ${method} gives an existing exact id priority over a new alias and replaces same-id entries`, async (t) => {
      const w = await world(t, transport, [model("first")]);
      const incoming = model("second", "claude-code", ["first"]);
      const path = method === "POST" ? "/models" : "/models/second";
      assert.equal((await w.api(method, path, incoming, "claude-code/first")).status, 200);
      w.attributed("putModel", "claude-code/first");
      // A replacement must remove the old same-id entry before name resolution.
      w.calls.length = 0;
      assert.equal((await w.api(method, path, model("second", "claude-code", ["unique"]), "claude-code/unique")).status, 200);
      w.attributed("putModel", "claude-code/second");
    });
  }

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
      const object = w.ns.object("project:demo");
      const snapshot = await object.run(() => JSON.parse(object.sql.exec("SELECT value FROM meta WHERE key = 'pool'").one().value));
      assert.deepEqual(snapshot.find((m) => m.id === entry.id), entry);
      const written = await w.api("POST", "/projects/demo/items", { title: `Imported by ${acting}` }, acting);
      assert.equal(written.status, 201, JSON.stringify(written.body));
      assert.equal((await L.events()).find((e) => e.kind === "item.created").data.acting, OPUS);
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
      const L = w.ns.get(w.ns.idFromName("project:demo"));
      await w.I.registerProject(await L.initProject({ name: "demo", repo: "demo" }, "owner"));
      const entry = model("opus-5.5", "claude-code", ["opus-bootstrap"]);
      for (const acting of [OPUS, "claude-code/opus-bootstrap", "CLAUDE-CODE/OPUS-5.5:high"]) {
        await w.I.removeModel(entry.id);
        w.calls.length = 0;
        const res = await w.api(method, path, entry, acting);
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.id, entry.id);
        w.attributed("putModel", OPUS);
        const object = w.ns.object("project:demo");
        const snapshot = await object.run(() => JSON.parse(object.sql.exec("SELECT value FROM meta WHERE key = 'pool'").one().value));
        const { unreached, notes, ...stored } = res.body;
        assert.deepEqual(snapshot.find((m) => m.id === entry.id), stored);
        const written = await w.api("POST", "/projects/demo/items", { title: `Registered by ${acting}` }, acting);
        assert.equal(written.status, 201, JSON.stringify(written.body));
        assert.equal((await L.events()).find((e) => e.kind === "item.created").data.acting, OPUS);
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
