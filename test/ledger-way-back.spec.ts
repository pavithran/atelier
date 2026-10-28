import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import { tokenFromBytes, sha256 } from "../src/tokens.ts";
import { LEDGER_DUMP_FORMAT } from "../src/rules.ts";
// @ts-expect-error the dump's pages are plain JavaScript without declarations
import { collectDump, importDump, manifestOf } from "../cli/ledger-dump.mjs";

// The Ledger's way back from a switch of the server (t342): bookmark,
// restore, dump and import, the developer's alone. Every credential here is
// synthetic. A second server, as staging would be, is the same Worker over
// Ledgers named apart (staging below).

const OWNER = "way-back-owner";
const AGENT = "claude-code/opus-5.5";
const prod = { ...env, ATELIER_TOKEN: OWNER } as typeof env;
// Another server: its own Ledgers, its own index.
const staging = {
  ...env, ATELIER_TOKEN: OWNER,
  LEDGER: { idFromName: (name: string) => env.LEDGER.idFromName(`staging:${name}`), get: (id: DurableObjectId) => env.LEDGER.get(id) },
} as unknown as typeof env;

type Json = Record<string, any>;
const send = async (bindings: typeof env, method: string, path: string, body?: unknown, bearer: string | null = OWNER, actor: string | null = "owner", host = "atelier.test") => {
  const res = await worker.fetch(new Request(`https://${host}/api${path}`, {
    method,
    headers: { ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }), ...(actor ? { "x-atelier-actor": actor } : {}), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), bindings);
  return { status: res.status, body: await res.json() as Json };
};
// What `atelier ledger dump` and `import` send, through the routes.
const ok = async (r: Promise<{ status: number; body: Json }>) => {
  const { status, body } = await r;
  if (status >= 300) throw new Error(`${status} ${JSON.stringify(body)}`);
  return body;
};
const dumpOf = (bindings: typeof env, name: string) => collectDump((table?: string, after?: number) =>
  ok(send(bindings, "GET", table === undefined ? `/projects/${name}/ledger/dump` : `/projects/${name}/ledger/dump?table=${table}&after=${after}`)));
const importInto = (bindings: typeof env, name: string, dump: Json) => importDump(dump, (body: unknown) => ok(send(bindings, "POST", `/projects/${name}/ledger/import`, body)));

const ledgerOf = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
const INDEX = () => env.LEDGER.get(env.LEDGER.idFromName("__index"));

async function setup(name: string, pasted?: string) {
  const record = {
    name, repo: name, createdAt: new Date().toISOString(),
    ...(pasted ? { title: `The project, ${pasted} pasted`, policy: { checks: ["npm test", `deploy --token ${pasted}`], protected: [] } } : { policy: { checks: ["npm test"], protected: [] } }),
  };
  const L = ledgerOf(name);
  await L.setProject(record as never, "owner");
  await INDEX().registerProject(record as never);
  return L;
}

// A Ledger holding items (one held, behind the owner triggers), a review, a
// plan and tokens: a write token's id on the item, a runner's Git grant and
// an agent token's record, each by its hash, and a token pasted into a brief.
async function seed(name: string) {
  const pasted = tokenFromBytes(new Uint8Array(32).fill(7));
  // A token pasted into the project's title and policy too.
  const L = await setup(name, pasted);
  const issued = await ok(send(prod, "POST", "/tokens", { actor: AGENT, projects: [name] }));
  const hash = await sha256(issued.token);
  await L.newItem("Build the thing", [], "owner");
  await L.newItem(`Brief with a pasted ${pasted} in it`, [], "owner");
  await runInDurableObject(L, async (_: unknown, state: DurableObjectState) => {
    const sql = state.storage.sql;
    sql.exec(`INSERT INTO owner_assignment (id, actor) VALUES ('t1', ?)`, AGENT);
    sql.exec(`UPDATE items SET owner = ?, claim_gen = 1, token_id = 'artifacts-token-1' WHERE id = 't1'`, AGENT);
    sql.exec(`DELETE FROM owner_assignment`);
    sql.exec(`INSERT INTO reviews (item_id, json, head, approve) VALUES ('t1', ?, ?, 1)`, JSON.stringify({ by: "codex/gpt-6-astra", approve: true, head: "a".repeat(40), note: "fine" }), "a".repeat(40));
    sql.exec(`INSERT INTO plans (plan_id, hash, json, actor, at) VALUES ('t3', 'h1', ?, ?, ?)`, JSON.stringify({ goal: "a plan", parts: [] }), AGENT, new Date().toISOString());
    sql.exec(`INSERT INTO agent_tokens (id, hash, json) VALUES (?, ?, ?)`, issued.id, hash, JSON.stringify({ id: issued.id, actor: AGENT, hash }));
    // A table a Ledger makes on first use, which a new Ledger has not made yet.
    sql.exec(`CREATE TABLE IF NOT EXISTS stuck_ticks (project TEXT PRIMARY KEY, at TEXT NOT NULL)`);
    sql.exec(`INSERT INTO stuck_ticks (project, at) VALUES (?, ?)`, name, new Date().toISOString());
    sql.exec(`INSERT INTO meta (key, value) VALUES (?, ?)`, `runner-git:${hash}`, JSON.stringify({ parent: hash, actor: AGENT, id: "t1", generation: 1 }));
  });
  return { L, token: issued.token, hash, pasted };
}

const rowsByTable = (dump: Json) => Object.fromEntries(dump.tables.map((t: Json) => [t.name, t.rows.map((r: unknown[]) => JSON.stringify(r)).sort()]));

it("dumps every table with its schema version, keeps token hashes as hashes, and writes no token", async () => {
  const { token, hash, pasted } = await seed("wb-dump");
  const dump = await dumpOf(prod, "wb-dump");
  expect(dump.format).toBe(LEDGER_DUMP_FORMAT);
  expect(dump.schemaVersion).toMatch(/^[0-9a-f]{16}$/);
  expect(dump.project).toBe("wb-dump");
  expect(dump.record.repo).toBe("wb-dump");
  const table = (n: string) => dump.tables.find((t: Json) => t.name === n);
  for (const n of ["items", "reviews", "plans", "events", "agent_tokens", "meta", "review_requests", "criteria_revisions"]) expect(table(n), n).toBeDefined();
  expect(table("items").rows).toHaveLength(2);
  expect(table("reviews").rows).toHaveLength(1);
  expect(table("plans").rows).toHaveLength(1);
  expect(table("events").rows.length).toBeGreaterThan(2);
  expect(table("items").columns.map((c: Json) => c.name)).toContain("owner");
  const text = JSON.stringify(dump);
  expect(text).toContain(hash);
  expect(text).not.toContain(token);
  expect(text).not.toContain(pasted);
  expect(text).toContain("[redacted]");
  expect(dump.redacted).toBeGreaterThan(0);
  // The project's record in the manifest is scrubbed as its meta row is.
  expect(dump.record.title).toBe("The project, [redacted] pasted");
  expect(dump.record.policy.checks).toEqual(["npm test", "deploy --token [redacted]"]);
  const manifestText = JSON.stringify(await ok(send(prod, "GET", "/projects/wb-dump/ledger/dump")));
  expect(manifestText).not.toContain(pasted);
  expect(manifestText).toContain("[redacted]");
  // The manifest's counts match the rows read.
  const manifest = await ok(send(prod, "GET", "/projects/wb-dump/ledger/dump"));
  expect(manifest.tables.find((t: Json) => t.name === "items").count).toBe(2);
  expect(manifest.schemaVersion).toBe(dump.schemaVersion);
  expect((await send(prod, "GET", "/projects/wb-dump/ledger/dump?table=sqlite_master&after=0")).status).toBe(404);
});

it("round-trips a dump through an import into an empty Ledger on another server, and refuses a non-empty one", async () => {
  await seed("wb-trip");
  const dump = await dumpOf(prod, "wb-trip");
  const done = await importInto(staging, "wb-trip", dump);
  expect(done.registered).toBe(true);
  expect(done.counts.items).toBe(2);
  expect(done.counts.stuck_ticks).toBe(1);
  const back = await dumpOf(staging, "wb-trip");
  expect(back.schemaVersion).toBe(dump.schemaVersion);
  expect(rowsByTable(back)).toEqual(rowsByTable(dump));
  // The guards on items' owner, dropped for the insert, stand again.
  expect(back.objects.filter((o: Json) => o.type === "trigger").map((o: Json) => o.name).sort()).toEqual(dump.objects.filter((o: Json) => o.type === "trigger").map((o: Json) => o.name).sort());
  expect(back.objects.some((o: Json) => o.name === "items_owner_insert")).toBe(true);
  // The imported project is served there: its tasks list.
  const items = await ok(send(staging, "GET", "/projects/wb-trip/items"));
  expect(JSON.stringify(items)).toContain("Build the thing");

  // The Ledger now holds rows: a second import is refused, and nothing changes.
  const again = await send(staging, "POST", "/projects/wb-trip/ledger/import", { step: "begin", manifest: manifestOf(dump) });
  expect(again.status).toBe(409);
  expect(again.body.error).toBe("ledger_not_empty");
  // As is an import into a project that holds anything on its own server.
  const own = await send(prod, "POST", "/projects/wb-trip/ledger/import", { step: "begin", manifest: manifestOf(dump) });
  expect(own.status).toBe(409);
  expect(own.body.error).toBe("ledger_not_empty");
  expect(rowsByTable(await dumpOf(staging, "wb-trip"))).toEqual(rowsByTable(dump));
  // A dump of another project, and a table whose columns differ, are refused.
  const other = await send(staging, "POST", "/projects/wb-elsewhere/ledger/import", { step: "begin", manifest: manifestOf(dump) });
  expect(other.body.error).toBe("project_mismatch");
  const changed = { ...manifestOf(dump), project: "wb-shape", record: { ...dump.record, name: "wb-shape", repo: "wb-shape" }, tables: manifestOf(dump).tables.map((t: Json) => t.name === "items" ? { ...t, columns: t.columns.slice(1) } : t) };
  const shape = await send(staging, "POST", "/projects/wb-shape/ledger/import", { step: "begin", manifest: changed });
  expect(shape.body.error).toBe("schema_mismatch");
  // A table definition that carries a second statement is refused.
  const smuggled = { ...changed, tables: [{ name: "wb_new", sql: "CREATE TABLE wb_new (a TEXT); DROP TABLE items", columns: [{ name: "a" }] }] };
  expect((await send(staging, "POST", "/projects/wb-shape/ledger/import", { step: "begin", manifest: smuggled })).body.error).toBe("bad_dump");
  // Rows without a begun import are refused.
  expect((await send(staging, "POST", "/projects/wb-shape/ledger/import", { step: "rows", import: "nope", table: "items", columns: ["id"], rows: [] })).body.error).toBe("no_import");
});

it("resumes an import that failed partway from its recorded progress, and aborts one", async () => {
  await seed("wb-part");
  const dump = await dumpOf(prod, "wb-part");
  const url = "/projects/wb-part/ledger/import";
  const items = dump.tables.find((t: Json) => t.name === "items");
  const begun = await ok(send(staging, "POST", url, { step: "begin", manifest: manifestOf(dump) }));
  const columns = items.columns.map((c: Json) => c.name);
  // The import fails after one row of items.
  await ok(send(staging, "POST", url, { step: "rows", import: begun.import, table: "items", columns, rows: items.rows.slice(0, 1) }));
  const retry = await send(staging, "POST", url, { step: "begin", manifest: manifestOf(dump) });
  expect(retry.body.error).toBe("import_in_progress");
  expect(retry.body.detail ?? JSON.stringify(retry.body)).toContain(begun.import);
  expect((await ok(send(staging, "POST", url, { step: "resume", import: begun.import }))).loaded).toEqual({ items: 1 });
  // A retry continues from it and the Ledger ends as the dump was.
  const done = await importDump(dump, (body: unknown) => ok(send(staging, "POST", url, body)), () => {}, begun.import);
  expect(done.counts.items).toBe(2);
  expect(rowsByTable(await dumpOf(staging, "wb-part"))).toEqual(rowsByTable(dump));
  // Another import fails partway and is aborted: what it wrote is gone, and a new import may begin.
  await seed("wb-abort");
  const second = await dumpOf(prod, "wb-abort");
  const first = await ok(send(staging, "POST", "/projects/wb-abort/ledger/import", { step: "begin", manifest: manifestOf(second) }));
  const table = second.tables.find((t: Json) => t.name === "items");
  await ok(send(staging, "POST", "/projects/wb-abort/ledger/import", { step: "rows", import: first.import, table: "items", columns: table.columns.map((c: Json) => c.name), rows: table.rows }));
  const aborted = await ok(send(staging, "POST", "/projects/wb-abort/ledger/import", { step: "abort", import: first.import }));
  expect(aborted.removed.items).toBe(2);
  expect((await send(staging, "POST", "/projects/wb-abort/ledger/import", { step: "resume", import: first.import })).body.error).toBe("no_import");
  const again = await importDump(second, (body: unknown) => ok(send(staging, "POST", "/projects/wb-abort/ledger/import", body)));
  expect(again.counts.items).toBe(2);
  expect(rowsByTable(await dumpOf(staging, "wb-abort"))).toEqual(rowsByTable(second));
});

it("reads a table larger than one page a page at a time", async () => {
  const L = await setup("wb-pages");
  await runInDurableObject(L, async (_: unknown, state: DurableObjectState) => {
    for (let i = 0; i < 5; i++) state.storage.sql.exec(`INSERT INTO runs (json) VALUES (?)`, JSON.stringify({ n: i, text: "x".repeat(900_000) }));
  });
  const first = await ok(send(prod, "GET", "/projects/wb-pages/ledger/dump?table=runs&after=0"));
  expect(first.rows.length).toBeLessThan(5);
  expect(first.next).not.toBeNull();
  const dump = await dumpOf(prod, "wb-pages");
  expect(dump.tables.find((t: Json) => t.name === "runs").rows.map((r: unknown[]) => JSON.parse(r[1] as string).n)).toEqual([0, 1, 2, 3, 4]);
});

it("fails a dump whose rows were updated between pages though the count held", async () => {
  const L = await setup("wb-moved");
  await runInDurableObject(L, async (_: unknown, state: DurableObjectState) => {
    for (let i = 0; i < 3; i++) state.storage.sql.exec(`INSERT INTO runs (json) VALUES (?)`, JSON.stringify({ n: i, state: "old", text: "x".repeat(900_000) }));
  });
  let pages = 0;
  const read = async (table?: string, after?: number) => {
    if (table === "runs" && pages++ === 1) {
      // After the first page of runs, a write updates the first row and the
      // last, as a runner would: the count stays 3.
      await runInDurableObject(L, async (_: unknown, state: DurableObjectState) => {
        state.storage.sql.exec(`UPDATE runs SET json = replace(json, '"old"', '"new"') WHERE rowid IN (SELECT MIN(rowid) FROM runs UNION SELECT MAX(rowid) FROM runs)`);
      });
    }
    return ok(send(prod, "GET", table === undefined ? "/projects/wb-moved/ledger/dump" : `/projects/wb-moved/ledger/dump?table=${table}&after=${after}`));
  };
  await expect(collectDump(read)).rejects.toThrow(/runs changed while the dump read it/);
  expect(pages).toBe(2);
  // With nothing written meanwhile, the dump holds the new rows.
  const dump = await dumpOf(prod, "wb-moved");
  expect(dump.tables.find((t: Json) => t.name === "runs").rows.map((r: unknown[]) => JSON.parse(r[1] as string).state)).toEqual(["new", "old", "new"]);
});

it("records each Ledger's bookmark, restores only a recorded one on the next start, and records the undo", async () => {
  await setup("wb-mark");
  const recorded = await send(prod, "POST", "/projects/wb-mark/ledger/bookmark");
  expect(recorded.status).toBe(201);
  const b = recorded.body;
  expect(b.id).toBe("b1@atelier.test");
  expect(b.server).toBe("atelier.test");
  expect(b.ledgers.map((l: Json) => l.name)).toEqual(["project:wb-mark", "__index"]);
  for (const l of b.ledgers) expect(l.bookmark).toMatch(/^[0-9a-f]+(-[0-9a-f]+)+$/);

  // The local runtime keeps no history to restore, so each Ledger's storage
  // takes the restore here as Cloudflare's does: it answers the bookmark
  // that undoes it.
  const asked: string[] = [];
  for (const stub of [ledgerOf("wb-mark"), INDEX()]) {
    await runInDurableObject(stub, async (instance: Json, state: DurableObjectState) => {
      instance.standIn = true;
      state.storage.onNextSessionRestoreBookmark = async (bookmark: string) => { asked.push(bookmark); return `0000${asked.length}-00000001`; };
    });
  }

  const unknown = await send(prod, "POST", "/projects/wb-mark/ledger/restore", { bookmark: "b9@atelier.test", server: "atelier.test" });
  expect(unknown.status).toBe(404);
  expect(unknown.body.error).toBe("unknown_bookmark");
  // A raw bookmark, even this project's own, is not a recorded one, with a server or without.
  expect((await send(prod, "POST", "/projects/wb-mark/ledger/restore", { bookmark: b.ledgers[0].bookmark })).body.error).toBe("bad_bookmark");
  expect((await send(prod, "POST", "/projects/wb-mark/ledger/restore", { bookmark: `${b.ledgers[0].bookmark}@atelier.test`, server: "atelier.test" })).body.error).toBe("unknown_bookmark");
  expect(asked).toEqual([]);

  // The server's name is asked for, and a bookmark of another server or
  // with no server is refused, before any Ledger is touched.
  const unconfirmed = await send(prod, "POST", "/projects/wb-mark/ledger/restore", { bookmark: "b1@atelier.test" });
  expect(unconfirmed.status).toBe(409);
  expect(unconfirmed.body.error).toBe("confirm_server");
  expect(unconfirmed.body.detail).toMatch(/on atelier\.test also rolls back the index, which is every project's/);
  expect((await send(prod, "POST", "/projects/wb-mark/ledger/restore", { bookmark: "b1@atelier.test", server: "staging.atelier.test" })).body.error).toBe("confirm_server");
  const elsewhere = await send(prod, "POST", "/projects/wb-mark/ledger/restore", { bookmark: "b1@staging.atelier.test", server: "atelier.test" });
  expect([elsewhere.status, elsewhere.body.error]).toEqual([409, "wrong_server"]);
  expect(elsewhere.body.detail).toMatch(/recorded on staging\.atelier\.test, and this server is atelier\.test/);
  const bare = await send(prod, "POST", "/projects/wb-mark/ledger/restore", { bookmark: "b1", server: "atelier.test" });
  expect([bare.status, bare.body.error]).toEqual([400, "bad_bookmark"]);
  expect(asked).toEqual([]);

  const restored = await send(prod, "POST", "/projects/wb-mark/ledger/restore", { bookmark: "b1@atelier.test", server: "atelier.test" });
  expect(restored.status).toBe(200);
  expect(restored.body.server).toBe("atelier.test");
  expect(restored.body.restoring).toEqual(b.ledgers);
  expect(asked).toEqual(b.ledgers.map((l: Json) => l.bookmark));
  expect(restored.body.detail).toMatch(/restore to b1@atelier\.test .* on their next start/);
  // One undo bookmark per Ledger as each accepts, then the one that undoes both.
  expect(restored.body.undo).toBe("b4@atelier.test");
  // Each Ledger restarts once idle; wait until both have, so no later call
  // meets the restart. A stub that saw the restart stays broken, so each try
  // takes a fresh one, and a restarted Ledger no longer has the stand-in.
  for (const fresh of [() => ledgerOf("wb-mark"), INDEX]) {
    for (let i = 0; ; i++) {
      const restarted = await runInDurableObject(fresh(), async (instance: Json) => !instance.standIn).catch(() => false);
      if (restarted) break;
      if (i > 200) throw new Error("the Ledger did not restart");
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  // Another project cannot restore this one's bookmark.
  await setup("wb-other");
  expect((await send(prod, "POST", "/projects/wb-other/ledger/restore", { bookmark: "b1@atelier.test", server: "atelier.test" })).status).toBe(404);
});

it("refuses every bookmark, restore, dump and import request without the developer's token with 403", async () => {
  await setup("wb-guard");
  await ok(send(prod, "POST", "/projects/wb-guard/ledger/bookmark"));
  const agent = await ok(send(prod, "POST", "/tokens", { actor: AGENT, projects: ["wb-guard"] }));
  const runner = await ok(send(prod, "POST", "/tokens", { runner: "home:guard", projects: ["wb-guard"] }));
  const routes: [string, string, unknown?][] = [
    ["POST", "/projects/wb-guard/ledger/bookmark"],
    ["POST", "/projects/wb-guard/ledger/restore", { bookmark: "b1@atelier.test", server: "atelier.test" }],
    ["GET", "/projects/wb-guard/ledger/dump"],
    ["GET", "/projects/wb-guard/ledger/dump?table=items&after=0"],
    ["POST", "/projects/wb-guard/ledger/import", { step: "begin", manifest: { format: LEDGER_DUMP_FORMAT, project: "wb-guard", tables: [] } }],
    ["POST", "/projects/wb-guard/ledger/import", { step: "finish", import: "x" }],
  ];
  for (const [method, path, body] of routes) {
    const callers: [string, string | null, string | null][] = [
      ["no token", null, null],
      ["no token, the developer's actor", null, "owner"],
      ["an agent token", agent.token, null],
      ["a runner token", runner.token, null],
      ["the developer token for an agent", OWNER, AGENT],
    ];
    for (const [who, bearer, actor] of callers) {
      const res = await send(prod, method, path, body, bearer, actor);
      expect(res.status, `${method} ${path} with ${who}`).toBe(403);
    }
  }
  // The developer's own: the bookmark recorded above stands, and nothing else was recorded.
  expect((await send(prod, "POST", "/projects/wb-guard/ledger/bookmark")).body.id).toBe("b2@atelier.test");
});

it("records the first Ledger's undo bookmark when the second refuses the restore", async () => {
  await setup("wb-partial");
  const b = (await send(prod, "POST", "/projects/wb-partial/ledger/bookmark")).body;
  // The project's Ledger takes the bookmark; the index's storage refuses.
  await runInDurableObject(ledgerOf("wb-partial"), async (instance: Json, state: DurableObjectState) => {
    instance.standIn = true;
    state.storage.onNextSessionRestoreBookmark = async () => "00001-00000001";
  });
  await runInDurableObject(INDEX(), async (instance: Json, state: DurableObjectState) => {
    instance.standIn = true;
    state.storage.onNextSessionRestoreBookmark = async () => { throw new Error("older than 30 days"); };
  });
  const failed = await send(prod, "POST", "/projects/wb-partial/ledger/restore", { bookmark: b.id, server: "atelier.test" });
  expect([failed.status, failed.body.error]).toEqual([500, "restore_partial"]);
  expect(failed.body.detail).toMatch(/__index did not take the bookmark/);
  expect(failed.body.detail).toContain("project:wb-partial b2@atelier.test");
  // The undo is on record, not only in the error text.
  const recorded = await runInDurableObject(env.LEDGER.get(env.LEDGER.idFromName("__ledger-bookmarks")), async (instance: Json) => instance.bookmarkRecord("wb-partial", "b2"));
  expect(recorded.ledgers).toEqual([{ name: "project:wb-partial", bookmark: "00001-00000001" }]);
  expect(recorded.undoes).toBe("b1");
  expect(recorded.restores).toBeUndefined();
  const first = await runInDurableObject(env.LEDGER.get(env.LEDGER.idFromName("__ledger-bookmarks")), async (instance: Json) => instance.bookmarkRecord("wb-partial", "b1"));
  expect(first.restores).toHaveLength(1);
  for (let i = 0; ; i++) {
    const restarted = await runInDurableObject(ledgerOf("wb-partial"), async (instance: Json) => !instance.standIn).catch(() => false);
    if (restarted) break;
    if (i > 200) throw new Error("the Ledger did not restart");
    await new Promise((r) => setTimeout(r, 50));
  }
});
