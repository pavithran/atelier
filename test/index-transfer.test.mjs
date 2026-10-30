import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import worker, { Ledger, takeModelSnapshots } from "../src/index.ts";
import { Namespace } from "../src/runtime/namespace.mjs";
import { collectIndex, safeIndex } from "../cli/index-transfer.mjs";
import { canonical, validateIndex } from "../src/index-transfer.ts";
import { OWNER_INDEX_ROUTES, agentRoute, runnerRoute } from "../src/tokens.ts";
import { cleanCardModel } from "../src/models/cards.ts";
import { stuckReport, REPORT_DEFAULTS } from "../src/stuck/report.ts";

export const OWNER = "atl_00112233445566778899aabbccddeeff00112233";
const fixture = JSON.parse(readFileSync(new URL("./fixtures/index-v1.0-answers.json", import.meta.url), "utf8"));
export async function legacyDump() {
  return collectIndex(async (path) => {
    if (fixture[path]) return structuredClone(fixture[path]);
    if (path.endsWith("/trend")) return { model: decodeURIComponent(path.split("/")[2]).split("/").at(-1), from: "2026-10-16", to: "2026-10-29", days: 14, snapshots: 0, measures: [] };
    assert.match(path, /^\/models\/[^/]+\/cards$/);
    return path.includes("astra") ? structuredClone(fixture["/models/gpt-6-astra/cards"]) : { cards: [], withdrawals: [] };
  });
}
const root = mkdtempSync(join(tmpdir(), "atelier-index-unit-")), namespaces = [];
after(async () => { for (const ns of namespaces) await ns.close(); rmSync(root, { recursive: true, force: true }); });
function fresh() {
  const env = { ATELIER_TOKEN: OWNER, DEPLOYED_MAIN: "a".repeat(40) };
  const ns = new Namespace({ dir: join(root, String(namespaces.length)), Class: Ledger, env });
  namespaces.push(ns); env.LEDGER = ns;
  const I = ns.get(ns.idFromName("__index"));
  const request = (method, path, body, token = OWNER) => worker.fetch(new Request(`http://localhost/api${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-atelier-actor": token === OWNER ? "owner" : "codex/gpt-6-astra", ...(token === OWNER ? { "x-atelier-acting": "codex/gpt-6-astra" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  return { I, request, env };
}

test("1.0 read answers carry notes, ended cards, withdrawals, absent-model assignments and duplicate reports", async () => {
  const d = validateIndex(await legacyDump());
  assert.equal(d.commit, fixture["/version"].commit);
  assert.deepEqual(d.counts, { models: 1, model_notes: 1, model_cards: 2, model_assignments: 2, runs: 2, snapshot_takes: 0, model_snapshots: 0 });
  assert.equal(d.limitations.length, 6);
  assert.deepEqual(d.tables.runs.map((r) => r.id), [1, 2]);
  assert.deepEqual(d.answers.runs, fixture["/runs"]);
  assert.deepEqual(d.answers.roles, fixture["/model-roles"]);
  assert.equal(JSON.parse(d.tables.model_cards[0].json).state, undefined);
  assert.equal(d.tables.model_cards[0].id, 7);
  assert.equal(d.tables.model_assignments[1].id, "a4");
  const { I, request } = fresh();
  assert.deepEqual(await I.importIndex(d), { added: 8, held: 0 });
  assert.deepEqual(await I.importIndex(d), { added: 0, held: 8 });
  assert.equal((await I.models())[0].notes[0].text, "Keep this dated note.");
  assert.equal((await I.modelCards("gpt-6-astra")).cards[0].state, "withdrawn");
  assert.equal((await I.roleAssignments()).assignments[0].status, "withdrawn");
  assert.equal((await I.runs()).length, 2);
  assert.equal((await request("GET", "/models/gpt-6-astra/trend")).status, 200);
  const report = stuckReport("p", "http://localhost", new Date("2026-10-30T12:00:00Z"), REPORT_DEFAULTS, {
    items: [{ id: "t1", title: "Work", state: "open", scope: [], createdAt: "2026-10-29T00:00:00Z", updatedAt: "2026-10-29T00:00:00Z" }], events: [], lease: null, reviews: [],
  }, [], await I.runs(), []);
  assert.match(JSON.stringify(report), /runner-give-up/);
});

function pagedSource(page, seen = []) {
  return async (path) => {
    seen.push(path);
    if (path === "/version") return { commit: "936ed2bd", capabilities: ["runs.paging.v1"] };
    if (path.startsWith("/runs?")) return page(new URL(path, "http://localhost").searchParams);
    if (path === "/models") return [];
    if (path === "/model-roles") return { assignments: [] };
    if (path.endsWith("/trend")) return { model: decodeURIComponent(path.split("/")[2]), from: "2026-10-16", to: "2026-10-29", days: 14, snapshots: 0, measures: [] };
    assert.match(path, /^\/models\/[^/]+\/cards$/);
    return { cards: [], withdrawals: [] };
  };
}

test("paged 1.0 export carries all 10,549 reports with sparse SQL ids and discovers oldest actors", async () => {
  const report = fixture["/runs"][0], seen = [];
  const rows = Array.from({ length: 10549 }, (_, i) => ({ id: (10549 - i) * 3,
    report: i === 10548 ? { ...report, actor: "codex/oldest-only", model: "retired-only" } : report }));
  const dump = validateIndex(await collectIndex(pagedSource((params) => {
    assert.equal(params.get("limit"), "1000");
    const available = rows.filter((r) => !params.has("before") || r.id < Number(params.get("before")));
    const runs = available.slice(0, 1000);
    return { runs, next: available.length > runs.length ? runs.at(-1).id : null };
  }, seen)));
  assert.equal(seen.filter((p) => p.startsWith("/runs?")).length, 11);
  assert.deepEqual(dump.tables.runs, rows.slice().reverse().map((r) => ({ id: r.id, json: JSON.stringify(r.report) })));
  assert.deepEqual(dump.answers.runs, rows);
  assert.equal(dump.counts.runs, 10549);
  assert.ok(seen.includes("/models/codex%2Foldest-only/cards"));
  assert.ok(seen.includes("/models/retired-only/trend"));
  assert.ok(!dump.limitations.some((s) => /newest 1000|run database ids/.test(s)));
  assert.ok(dump.limitations.some((s) => /note database ids/.test(s)));
  const { I } = fresh();
  assert.deepEqual(await I.importIndex(dump), { added: 10549, held: 0 });
  assert.deepEqual(await I.importIndex(dump), { added: 0, held: 10549 });
  assert.deepEqual((await I.exportIndex()).tables.runs, dump.tables.runs);
  const conflict = structuredClone(dump);
  conflict.tables.runs[0].json = JSON.stringify({ ...report, reason: "changed" });
  conflict.tables.runs.push({ id: 99999, json: JSON.stringify(report) }); conflict.counts.runs++;
  await assert.rejects(I.importIndex(conflict), /runs:3.*nothing imported/);
  assert.deepEqual((await I.exportIndex()).tables.runs, dump.tables.runs);
});

test("paged 1.0 export accepts empty history and an exact page boundary", async () => {
  const empty = await collectIndex(pagedSource(() => ({ runs: [], next: null })));
  assert.deepEqual(empty.tables.runs, []);
  const seen = [], report = fixture["/runs"][0];
  const dump = await collectIndex(pagedSource(() => ({ runs: Array.from({ length: 1000 }, (_, i) => ({ id: 1000 - i, report })), next: null }), seen));
  assert.equal(dump.counts.runs, 1000);
  assert.equal(seen.filter((p) => p.startsWith("/runs?")).length, 1);
});

test("paged 1.0 export refuses malformed pages, repeated ids and stalled cursors", async () => {
  const report = fixture["/runs"][0];
  for (const page of [[], { runs: [], next: 1 }, { runs: [] },
    { runs: [{ id: 0, report }], next: null }, { runs: [{ id: 1, report: null }], next: null },
    { runs: [{ id: 2, report }, { id: 2, report }], next: null },
    { runs: [{ id: 2, report }], next: 3 }]) {
    await assert.rejects(collectIndex(pagedSource(() => page)), /unexpected 1.0 run page/);
  }
  await assert.rejects(collectIndex(pagedSource(() => ({ runs: [{ id: 2, report }], next: 2 }))), /unexpected 1.0 run page/);
  await assert.rejects(collectIndex(pagedSource((params) => {
    if (params.has("before")) throw new Error("page read failed");
    return { runs: [{ id: 2, report }], next: 2 };
  })), /page read failed/);
});

test("2.0 export keeps all raw ids, and a conflict refuses even unrelated rows", async () => {
  const { I } = fresh();
  const dump = await legacyDump();
  await I.importIndex(dump);
  const copy = await collectIndex(async (path) => path === "/version" ? { commit: "a".repeat(40), capabilities: ["index.transfer.v1"] } : I.exportIndex());
  assert.deepEqual(copy.tables, (await I.exportIndex()).tables);
  const target = fresh();
  const conflicting = structuredClone(copy);
  conflicting.tables.models[0].json = JSON.stringify({ ...JSON.parse(conflicting.tables.models[0].json), note: "Other" });
  const onlyModel = structuredClone(conflicting);
  for (const name of Object.keys(onlyModel.tables)) if (name !== "models") { onlyModel.tables[name] = []; onlyModel.counts[name] = 0; }
  await target.I.importIndex(onlyModel);
  const before = await target.I.exportIndex();
  await assert.rejects(target.I.importIndex(copy), /models:gpt-6-astra.*nothing imported/);
  assert.equal(canonical(await target.I.exportIndex()), canonical(before));
  assert.deepEqual(await target.I.assignmentEvents(), [], "conflicts must not write assignment events either");
});

test("gateway imports with owner only; agent and runner credentials are refused for reads and writes", async () => {
  const { I, request } = fresh(), dump = await legacyDump();
  for (const runner of [undefined, "home:test"]) {
    const token = runner ? "atl_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" : "atl_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    await I.putAgentToken({ id: runner ? "runner" : "agent", actor: "codex/gpt-6-astra", hash: createHash("sha256").update(token).digest("hex"), createdAt: "2026-10-30T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z", ...(runner ? { runner, projects: ["p"] } : {}) });
    for (const { method, path } of OWNER_INDEX_ROUTES) {
      assert.equal((await request(method, path, method === "POST" ? { dump } : undefined, token)).status, 403, `${method} ${path}`);
    }
  }
  assert.equal((await request("POST", "/index/import", { dump })).status, 200);
  assert.equal((await I.assignmentEvents())[0].data.acting, undefined, "the importing request must not become the original acting model");
  assert.equal((await request("GET", "/index/export")).status, 200);
});

test("credentials pasted in free text and nested JSON are redacted; invalid formats and counts are refused", async () => {
  const dump = await legacyDump();
  const row = JSON.parse(dump.tables.models[0].json);
  row.note = `Pasted ${OWNER}`; row.secret = "ordinary history"; row.longText = "x".repeat(10000); row.commit = fixture["/version"].commit;
  dump.tables.models[0].json = JSON.stringify(row);
  const safe = safeIndex(dump, [OWNER]);
  assert.ok(!JSON.stringify(safe).includes(OWNER));
  assert.equal(JSON.parse(safe.tables.models[0].json).secret, "ordinary history");
  validateIndex(safe);
  assert.equal(safe.commit, dump.commit);
  assert.equal(JSON.parse(safe.tables.models[0].json).commit, dump.commit);
  assert.equal(JSON.parse(safe.tables.models[0].json).longText.length, 10000);
  assert.throws(() => validateIndex({ ...safe, version: 2 }), /version 1/);
  safe.counts.runs++;
  assert.throws(() => validateIndex(safe), /count does not match/);
});

test("2.0 exports orphan histories and more than the legacy run limit with their SQL ids", async () => {
  const { I } = fresh(), d = await legacyDump();
  d.tables.models = []; d.counts.models = 0;
  const run = d.tables.runs[0].json;
  d.tables.runs = Array.from({ length: 1002 }, (_, n) => ({ id: n + 100, json: run }));
  d.counts.runs = 1002;
  await I.importIndex(d);
  const exported = await I.exportIndex();
  assert.deepEqual(exported.tables, d.tables);
  assert.equal(exported.tables.model_notes[0].model, "gpt-6-astra");
  assert.equal((await I.modelCards("gpt-6-astra")).cards[0].id, "c7");
  const target = fresh();
  assert.equal((await target.I.importIndex(exported)).added, 1007);
  assert.deepEqual((await target.I.exportIndex()).tables, exported.tables);
});

test("restoring project selector copies neither records events nor changes them on retry", async () => {
  const { I } = fresh();
  await I.importIndex(await legacyDump());
  const pool = await I.models(), snapshot = await I.assignmentSnapshotFor("p");
  const events = await I.dumpRows("events");
  await I.importIndexSnapshot(pool, snapshot);
  const before = await I.dumpRows("meta");
  await I.importIndexSnapshot(pool, snapshot);
  assert.deepEqual(await I.dumpRows("meta"), before);
  assert.deepEqual(await I.dumpRows("events"), events);
});


test("owner index inventory matches the transfer routes and excludes both restricted credentials", () => {
  assert.deepEqual(OWNER_INDEX_ROUTES, [
    { method: "GET", path: "/index/export", credential: "owner" },
    { method: "POST", path: "/index/import", credential: "owner" },
  ]);
  for (const { method, path } of OWNER_INDEX_ROUTES) {
    const parts = path.split("/").filter(Boolean);
    assert.equal(agentRoute(method, parts, {}), false);
    assert.equal(runnerRoute(method, parts, {}), false);
  }
});

test("sparse assignment history allocates the next sequence and updates higher project snapshots", async () => {
  const { I } = fresh(), project = fresh().I;
  await I.importIndex(await legacyDump()); // a3, a4, rather than a1, a2
  const initial = await I.assignmentSnapshotFor("p");
  assert.equal(initial.version, 4);
  await project.importIndexSnapshot([], { version: 3, assignments: [] });
  await project.importIndexSnapshot([], initial);
  assert.equal(JSON.parse((await project.dumpRows("meta")).rows.find((r) => r[0] === "assignments")[1]).version, 4);
  const assigned = await I.assignRole("owner", {
    request: "after-import", scope: "*", role: "build", choices: [{ actor: "codex/gpt-6-astra", model: "gpt-6-astra" }],
    reason: "New judgement", quote: "Move them", evidence: [], replaces: null,
  });
  assert.equal(assigned.id, "a5");
  assert.equal((await I.withdrawRoleAssignment(assigned.id, "owner", "Stopped")).id, "a6");
  assert.equal((await I.assignmentSnapshotFor("p")).version, 6);
  const exported = validateIndex(await I.exportIndex());
  assert.deepEqual(exported.tables.model_assignments.map(({ n, id }) => [n, id]), [[3, "a3"], [4, "a4"], [5, "a5"], [6, "a6"]]);
});

test("assignment import restores acting judgement events with original attribution, once", async () => {
  const { I, request, env } = fresh(), dump = await legacyDump();
  const date = new Date(), day = new Date(date.getTime() - 86400000).toISOString().slice(0, 10);
  for (const row of dump.tables.model_assignments) {
    const r = JSON.parse(row.json);
    row.json = JSON.stringify({ ...r, by: "original-owner", at: `${day}T10:00:00.000Z`, acting: "codex/gpt-6-astra" });
  }
  await I.importIndex(dump);
  const events = await I.assignmentEvents();
  assert.deepEqual(events.map((e) => [e.kind, e.actor, e.at, e.data.id, e.data.acting]), [
    ["assignment.recorded", "original-owner", `${day}T10:00:00.000Z`, "a3", "codex/gpt-6-astra"],
    ["assignment.withdrawn", "original-owner", `${day}T10:00:00.000Z`, "a4", "codex/gpt-6-astra"],
  ]);
  await I.importIndex(dump);
  assert.deepEqual(await I.assignmentEvents(), events);
  const reliability = await (await request("GET", "/reliability")).json();
  const judgement = reliability.judgement.models.find((r) => r.model === "gpt-6-astra");
  assert.equal(judgement.decisionsRecorded, 1);
  assert.equal(judgement.decisionsWithdrawn, 1);
  const compared = await (await request("GET", "/models/gpt-6-astra/compare")).json();
  assert.equal(compared.roles.flatMap((r) => r.figures).find((f) => f.measure === "decisions").value, 1);
  const review = await (await request("GET", "/model-review")).json();
  assert.equal(review.roles.find((r) => r.role === "build").ended[0].id, "a3");
  await takeModelSnapshots(env, date.getTime());
  const snapshot = await I.modelSnapshot(day);
  assert.equal(snapshot.rows.flatMap((r) => r.figures).find((f) => f.measure === "decisions").value, 1);
  const trend = await (await request("GET", "/models/gpt-6-astra/trend")).json();
  assert.equal(trend.measures.find((f) => f.measure === "decisions").points.find((p) => p.day === day).value, 1);
  const target = fresh();
  await target.I.importIndex(await I.exportIndex());
  assert.deepEqual(await target.I.assignmentEvents(), events);
});

test("credential redaction preserves prose, metadata, project keys and serialized fingerprints on a same-server round trip", async () => {
  const dump = await legacyDump(), text = 'Good at basic tasks; tokens: 128k; max_tokens=8192; said "yes".';
  dump.answers.roles.names = { "token-service": "Token service", "secret-project": "Secret project" };
  for (const table of Object.values(dump.tables)) for (const row of table) {
    row.json = JSON.stringify({ ...JSON.parse(row.json), reason: text, quote: text, fingerprint: JSON.stringify({ reason: text, quote: text }), secret: "ordinary prose" });
  }
  assert.deepEqual(safeIndex(dump), dump);
  const { I } = fresh();
  await I.importIndex(dump);
  assert.deepEqual(await I.importIndex(safeIndex(await I.exportIndex())), { added: 0, held: 8 });
  const pasted = `${text} ${OWNER}`;
  const safe = safeIndex({ reason: pasted, quote: pasted, fingerprint: JSON.stringify({ reason: pasted, quote: pasted }) }, [OWNER]);
  assert.equal(JSON.parse(safe.fingerprint).reason, safe.reason);
  assert.equal(JSON.parse(safe.fingerprint).quote, safe.quote);
  assert.equal(safe.reason, `${text} [redacted]`);
});

test("direct index export redacts pasted tokens on the server", async () => {
  const { I, request } = fresh(), dump = await legacyDump();
  const token = `atl_${"ab".repeat(32)}`;
  dump.tables.model_notes[0].json = JSON.stringify({ text: `Pasted ${token}`, at: "2026-10-30T00:00:00Z", by: "owner" });
  await I.importIndex(dump);
  assert.ok(!JSON.stringify(await I.exportIndex()).includes(token));
  const response = await request("GET", "/index/export");
  assert.equal(response.status, 200);
  const exported = await response.json();
  assert.ok(!JSON.stringify(exported).includes(token));
  assert.equal(JSON.parse(exported.tables.model_notes[0].json).text, "Pasted [redacted]");
});

test("legacy card discovery includes aliases and skips names 1.0 cannot store as cards", async () => {
  const answers = structuredClone(fixture), queried = [];
  answers["/models"][0].aliases = ["astra-old"];
  const invalidNames = ["claude/opus-4", `codex/${"x".repeat(65)}`, ["sk", "proj", "12345678901234567890"].join("-")];
  answers["/runs"].push(...invalidNames.map((actor) => ({ ...answers["/runs"][0], actor, model: actor })));
  answers["/model-roles"].assignments[0].choices.push({ actor: "claude/opus-4", model: "opus-4" });
  const dump = await collectIndex(async (path) => {
    if (answers[path] && !path.endsWith("/cards")) return answers[path];
    if (path.endsWith("/trend")) return { model: decodeURIComponent(path.split("/")[2]).split("/").at(-1), from: "2026-10-16", to: "2026-10-29", days: 14, snapshots: 0, measures: [] };
    const name = decodeURIComponent(path.slice("/models/".length, -"/cards".length));
    cleanCardModel(name); // The real 1.0 route's validation, before reading cards.
    queried.push(name);
    return name === "astra-old" ? { cards: [{ ...fixture["/models/gpt-6-astra/cards"].cards[0], id: "c9", model: "astra-old" }], withdrawals: [] } : { cards: [], withdrawals: [] };
  });
  assert.ok(queried.includes("astra-old"));
  assert.ok(queried.includes("codex/astra-old"));
  assert.ok(invalidNames.every((n) => !queried.includes(n)));
  assert.equal(dump.tables.model_cards[0].id, 9);
  assert.equal(dump.counts.runs, 5);
  assert.equal(JSON.parse(dump.tables.model_assignments[0].json).choices[1].actor, "claude/opus-4");
  await assert.rejects(collectIndex(async (path) => {
    if (path.endsWith("/cards")) throw new Error("server unavailable");
    return answers[path];
  }), /server unavailable/);
});


test("CLI file failures use clean errors for existing exports, missing imports and bad JSON", async () => {
  const dump = await legacyDump(), file = join(root, "private-index.json"), invalid = join(root, "invalid-index.json");
  dump.tables.model_notes[0].json = JSON.stringify({ text: `Pasted ${OWNER}`, at: "2026-10-30T00:00:00Z", by: "owner" });
  writeFileSync(file, "keep these bytes", { mode: 0o600 });
  writeFileSync(invalid, "{broken JSON");
  // Replace HTTP at the transport boundary; these file errors need no listener.
  const preload = `globalThis.fetch = async (url) => Response.json(String(url).endsWith('/api/version') ? { commit: 'abc', capabilities: ['index.transfer.v1'] } : ${JSON.stringify(dump)});`;
  const childEnv = { ...process.env };
  for (const k of Object.keys(childEnv)) if (k.startsWith("ATELIER_")) delete childEnv[k];
  Object.assign(childEnv, { ATELIER_TOKEN: OWNER, ATELIER_SERVER: "http://localhost:1", ATELIER_CONFIG_DIR: join(root, "cli-config"), ATELIER_SECRET_STORE: "file", NO_COLOR: "1" });
  for (const [sub, path, message] of [["export", file, /EEXIST/], ["import", join(root, "missing.json"), /ENOENT/], ["import", invalid, /JSON/]]) {
    let failed;
    try {
      execFileSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, join(process.cwd(), "cli/atelier.mjs"), "index", sub, "--file", path], { env: childEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) { failed = e; }
    assert.equal(failed?.status, 1);
    assert.match(failed.stderr, /^atelier: /);
    assert.match(failed.stderr, message);
    assert.doesNotMatch(failed.stderr, /\n\s+at |node:fs|SyntaxError:/);
  }
  assert.equal(readFileSync(file, "utf8"), "keep these bytes");
  const created = join(root, "created-index.json");
  execFileSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, join(process.cwd(), "cli/atelier.mjs"), "index", "export", "--file", created], { env: childEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(statSync(created).mode & 0o777, 0o600);
  assert.ok(!readFileSync(created, "utf8").includes(OWNER));
});

test("CLI paged export sends the existing developer headers on every page", () => {
  const file = join(root, "paged-index.json"), report = fixture["/runs"][0];
  const preload = `
    import assert from "node:assert/strict";
    let headers;
    globalThis.fetch = async (url, options) => {
      const path = new URL(url).pathname, params = new URL(url).searchParams;
      if (path === "/api/config") return Response.json({});
      if (path === "/api/version") {
        headers = options.headers;
        assert.equal(headers.authorization, "Bearer ${OWNER}");
        assert.equal(headers["x-atelier-actor"], "owner");
        return Response.json({ capabilities: ["runs.paging.v1"] });
      }
      assert.deepEqual(options.headers, headers);
      if (path === "/api/runs") {
        assert.equal(params.get("limit"), "1000");
        assert.ok(params.get("before") === null || params.get("before") === "20");
        return Response.json({ runs: [{ id: params.has("before") ? 5 : 20, report: ${JSON.stringify(report)} }], next: params.has("before") ? null : 20 });
      }
      if (path === "/api/models") return Response.json([]);
      if (path === "/api/model-roles") return Response.json({ assignments: [] });
      if (path.endsWith("/trend")) return Response.json({ model: decodeURIComponent(path.split("/")[3]), from: "2026-10-16", to: "2026-10-29", days: 14, snapshots: 0, measures: [] });
      assert.ok(path.endsWith("/cards"));
      return Response.json({ cards: [], withdrawals: [] });
    };
  `;
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("ATELIER_")) delete env[k];
  Object.assign(env, { ATELIER_TOKEN: OWNER, ATELIER_OWNER: "owner", ATELIER_SERVER: "http://localhost:1", ATELIER_CONFIG_DIR: join(root, "paged-cli-config"), ATELIER_SECRET_STORE: "file", NO_COLOR: "1" });
  const output = execFileSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, join(process.cwd(), "cli/atelier.mjs"), "index", "export", "--file", file], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const dump = validateIndex(JSON.parse(readFileSync(file, "utf8")));
  assert.deepEqual(dump.tables.runs.map((r) => r.id), [5, 20]);
  assert.doesNotMatch(output, /newest 1000|run database ids/);
});

test("legacy trends preserve every printed point, discover card names, and refuse changed alias reads", async () => {
  const { computeSnapshot, trendOf, trendLines, addDays } = await import("../src/models/snapshot.ts");
  const to = addDays(new Date().toISOString().slice(0, 10), -1);
  const computed = computeSnapshot({ day: to, takenAt: `${addDays(to, 1)}T00:05:00Z`, owner: "owner",
    pool: fixture["/models"], ledgers: [], runs: { through: 0, reports: [] }, index: { through: 0, events: [] } });
  const takes = [], rows = [];
  for (let n = 0; n < 14; n++) {
    const day = addDays(to, n - 13);
    takes.push({ ...computed.take, day, takenAt: `${addDays(day, 1)}T00:05:00Z`, rev: 2, revises: 1,
      complete: n !== 7, coverage: { projects: 1, events: n, unread: n === 7 ? ["unread-project"] : [] } });
    for (const source of computed.rows) {
      const row = structuredClone(source);
      const f = row.figures[0];
      if (f.kind === "share") Object.assign(f, { value: n === 4 ? null : 0.5, numerator: 3, denominator: 6, n: 6, minSamples: 5, state: n === 4 ? "too-few" : "measured" });
      rows.push({ ...row, day, rev: 2 });
    }
  }
  const projected = trendOf("gpt-6-astra", takes, rows, to);
  assert.ok(projected.measures.length);
  const point = projected.measures[0].points.at(-1);
  point.breaks = "the names its figures are read under changed";
  point.earlier = [{ rev: 1, takenAt: `${to}T01:00:00Z`, origin: "reconstructed", complete: false, text: "0 of 1; under 5, too few for a share" }];
  const queried = [];
  const get = async (path) => {
    if (path.endsWith("/trend")) {
      const name = decodeURIComponent(path.split("/")[2]); queried.push(name);
      return name.includes("astra") ? structuredClone(projected) : { ...projected, model: name, snapshots: 0, measures: [] };
    }
    if (fixture[path]) {
      const answer = structuredClone(fixture[path]);
      if (path.endsWith("/cards")) answer.cards[0].named = "card-only";
      return answer;
    }
    const answer = path.endsWith("/cards") && path.includes("astra") ? structuredClone(fixture["/models/gpt-6-astra/cards"]) : { cards: [], withdrawals: [] };
    if (answer.cards.length) answer.cards[0].named = "card-only";
    return answer;
  };
  const dump = validateIndex(await collectIndex(get));
  assert.ok(queried.includes("codex/removed-model"));
  assert.ok(queried.includes("card-only"));
  assert.ok(queried.includes("codex/gpt-6-astra"));
  assert.equal(dump.counts.model_snapshots, 1, "aliases deduplicate by canonical model");
  assert.match(dump.limitations.join(" "), /not stored snapshot rows/);
  const { I, request } = fresh();
  const imported = await I.importIndex(dump);
  assert.deepEqual(await I.importIndex(dump), { added: 0, held: imported.added });
  const shown = await (await request("GET", "/models/gpt-6-astra/trend")).json();
  assert.deepEqual(shown, projected);
  assert.deepEqual(trendLines(shown), trendLines(projected));
  const target = fresh();
  await target.I.importIndex(await I.exportIndex());
  assert.deepEqual(await (await target.request("GET", "/models/gpt-6-astra/trend")).json(), projected);
  const shifted = trendOf(projected.model, [], await I.modelSnapshotRows(projected.model, projected.from, addDays(to, 1)), addDays(to, 1));
  assert.deepEqual(shifted.measures[0].points.find((p) => p.day === to), point);
  assert.equal(shifted.measures[0].points.at(-1).gap, "no snapshot was taken");
  assert.equal(trendOf(projected.model, [], await I.modelSnapshotRows(projected.model, addDays(to, 1), addDays(to, 14)), addDays(to, 14)).measures.length, 0);
  const nativeTake = { ...takes.at(-1), day: addDays(to, 1) };
  const nativeRows = computed.rows.map((r) => ({ ...r, day: nativeTake.day, rev: nativeTake.rev }));
  const mixed = trendOf(projected.model, [nativeTake], [...await I.modelSnapshotRows(projected.model, projected.from, nativeTake.day), ...nativeRows], nativeTake.day);
  assert.equal(mixed.snapshots, 14);
  assert.equal(mixed.measures[0].points.at(-1).day, nativeTake.day);
  const before = await I.exportIndex(), conflict = structuredClone(dump);
  const conflictingRow = JSON.parse(conflict.tables.model_snapshots[0].json);
  conflictingRow.projection.measures[0].points.at(-1).note = "different projection";
  conflict.tables.model_snapshots[0].json = JSON.stringify(conflictingRow);
  conflict.tables.runs.push({ id: 99, json: dump.tables.runs[0].json }); conflict.counts.runs++;
  await assert.rejects(I.importIndex(conflict), /model_snapshots:.*nothing imported/);
  assert.deepEqual(await I.exportIndex(), before);
  await assert.rejects(collectIndex(async (path) => {
    const answer = await get(path);
    if (path === "/models/codex%2Fgpt-6-astra/trend") answer.measures[0].points.at(-1).note = "changed during export";
    return answer;
  }), /changed while exporting/);
  await assert.rejects(collectIndex(async (path) => {
    if (path.endsWith("/trend")) throw new Error("trend unavailable");
    return get(path);
  }), /trend unavailable/);
  const malformed = structuredClone(dump);
  const invalidRow = JSON.parse(malformed.tables.model_snapshots[0].json);
  invalidRow.projection.measures[0].points[0].through = "9999-12-31";
  malformed.tables.model_snapshots[0].json = JSON.stringify(invalidRow);
  await assert.rejects(I.importIndex(malformed), /invalid trend projection/);
  assert.equal((await I.putModelSnapshot(computed)).stored, false);
  assert.equal(await I.modelSnapshot(to), null, "a stale timer must not write a carried day");
  assert.equal((await I.putModelSnapshot(computed)).stored, false);
});

test("native snapshot takes and composite keys round trip, validate and conflict atomically", async () => {
  const { computeSnapshot } = await import("../src/models/snapshot.ts");
  const source = fresh();
  await source.I.importIndex(await legacyDump());
  const computed = computeSnapshot({ day: "2026-10-29", takenAt: "2026-10-30T00:05:00Z", owner: "owner",
    pool: fixture["/models"], ledgers: [], runs: { through: 0, reports: [] }, index: { through: 0, events: [] } });
  await source.I.putModelSnapshot(computed);
  const dump = validateIndex(await source.I.exportIndex()), target = fresh();
  assert.equal(dump.counts.snapshot_takes, 1);
  assert.ok(dump.counts.model_snapshots > 1);
  const result = await target.I.importIndex(dump);
  assert.deepEqual(await target.I.importIndex(dump), { added: 0, held: result.added });
  assert.deepEqual(await target.I.modelSnapshot("2026-10-29"), await source.I.modelSnapshot("2026-10-29"));
  assert.deepEqual((await target.I.exportIndex()).tables, dump.tables);
  for (const table of ["snapshot_takes", "model_snapshots"]) {
    const invalid = structuredClone(dump);
    invalid.tables[table].push(invalid.tables[table][0]); invalid.counts[table]++;
    assert.throws(() => validateIndex(invalid), /repeated id/);
    const bad = structuredClone(dump); bad.tables[table][0].rev = 0;
    assert.throws(() => validateIndex(bad), /invalid snapshot key/);
    const conflict = structuredClone(dump);
    conflict.tables[table][0].json = JSON.stringify({ ...JSON.parse(conflict.tables[table][0].json), extra: true });
    await assert.rejects(target.I.importIndex(conflict), /nothing imported/);
    assert.deepEqual((await target.I.exportIndex()).tables, dump.tables);
  }
  const old = await legacyDump();
  delete old.tables.snapshot_takes; delete old.tables.model_snapshots;
  delete old.counts.snapshot_takes; delete old.counts.model_snapshots;
  assert.deepEqual(validateIndex(old).tables.model_snapshots, []);
});

// A fixed span makes scheduler/import ordering independent of the wall clock.
async function carriedFixture() {
  const { computeSnapshot, trendOf, addDays } = await import("../src/models/snapshot.ts");
  const to = "2026-10-29";
  const computed = computeSnapshot({ day: to, takenAt: "2026-10-30T00:05:00Z", owner: "owner",
    pool: fixture["/models"], ledgers: [], runs: { through: 0, reports: [] }, index: { through: 0, events: [] } });
  const takes = Array.from({ length: 14 }, (_, i) => ({ ...computed.take, day: addDays(to, i - 13), rev: 1, revises: null }));
  const rows = takes.flatMap((t) => computed.rows.map((r) => ({ ...structuredClone(r), day: t.day, rev: 1 })));
  const projection = trendOf("gpt-6-astra", takes, rows, to);
  const dump = await legacyDump();
  dump.tables.model_snapshots = [{ day: to, schema: 1, rev: 1, model: projection.model, role: "@trend",
    json: JSON.stringify({ model: projection.model, role: "@trend", figures: [], projection }) }];
  dump.counts.model_snapshots = 1;
  const carried = { day: to, rev: 1, model: projection.model, role: "@trend", figures: [], projection };
  return { computed, takes, rows, projection, dump, carried };
}

for (const timerFirst of [false, true]) for (const removed of [false, true]) test(`carried days survive the timer ${timerFirst ? "before" : "after"} import (${removed ? "retired" : "active"} model)`, async () => {
  const { trendOf, trendLines } = await import("../src/models/snapshot.ts");
  const { dump, projection } = await carriedFixture();
  // Keep the projection after its model has left the pool.
  if (removed) { dump.tables.models = []; dump.counts.models = 0; }
  const { I, env } = fresh(), now = Date.parse("2026-10-30T06:00:00Z");
  if (timerFirst) assert.equal((await takeModelSnapshots(env, now)).length, 7);
  await I.importIndex(dump);
  const before = (await I.exportIndex()).tables;
  assert.deepEqual(await takeModelSnapshots(env, now), []);
  assert.deepEqual((await I.exportIndex()).tables, before);
  const shown = trendOf(projection.model, await I.modelSnapshotTakes(projection.from, projection.to),
    await I.modelSnapshotRows(projection.model, projection.from, projection.to), projection.to);
  assert.deepEqual(trendLines(shown), trendLines(projection));
});

test("shifted projections clear a break without a predecessor and check every boundary difference", async () => {
  const { trendOf, addDays } = await import("../src/models/snapshot.ts");
  const { projection, computed, carried } = await carriedFixture();
  // Use a count, which is valued even with no recorded work.
  const m = projection.measures.find((m) => m.kind === "count");
  projection.measures = [m];
  m.points[1].breaks = "expired predecessor";
  const day = addDays(projection.to, 1);
  const nativeRows = computed.rows.map((r) => ({ ...structuredClone(r), day, rev: 1 }));
  const f = nativeRows.find((r) => r.role === m.role).figures.find((f) => f.measure === m.measure);
  f.version = 9; f.window.days = 3; f.minSamples = 11;
  const take = { ...computed.take, day, rev: 1, revises: null };
  const mixed = trendOf(projection.model, [take], [carried, ...nativeRows], day);
  const points = mixed.measures.find((x) => x.measure === m.measure).points;
  assert.equal(points.find((p) => !p.gap).breaks, null);
  assert.match(points.at(-1).breaks, /measure version 1 to 9/);
  assert.match(points.at(-1).breaks, /window .* to 3 days/);
  assert.match(points.at(-1).breaks, /threshold .* to 11/);
  assert.match(points.at(-1).breaks, /does not expose its cohort/);
});

test("mixed projection and native roles remain contiguous in comparison order", async () => {
  const { trendOf, addDays, trendLines } = await import("../src/models/snapshot.ts");
  const { COMPARE_ROLES } = await import("../src/models/compare.ts");
  const { projection, computed, carried } = await carriedFixture();
  projection.measures = projection.measures.filter((m) => ["build", "review", "acting"].includes(m.role));
  const day = addDays(projection.to, 1);
  const mixed = trendOf(projection.model, [{ ...computed.take, day, rev: 1, revises: null }],
    [carried, ...computed.rows.map((r) => ({ ...r, day, rev: 1 }))], day);
  const order = mixed.measures.map((m) => COMPARE_ROLES.indexOf(m.role));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.ok(trendLines(mixed).length);
});

test("assignment canonical choices and all exposed acting names discover retired trends", async () => {
  const seen = new Set();
  await collectIndex(async (path) => {
    if (path.endsWith("/trend")) {
      const name = decodeURIComponent(path.split("/")[2]); seen.add(name);
      return { model: name, from: "2026-10-16", to: "2026-10-29", days: 14, snapshots: 0, measures: [] };
    }
    if (path === "/model-roles") {
      const roles = structuredClone(fixture[path]), a = roles.assignments[0];
      a.choices = [{ actor: "codex/old-alias", model: "custom-id" }, { actor: "claude/legacy-id", model: "legacy-id" }];
      a.acting = "codex/acting-only"; a.actingDeclared = "codex/declared-only";
      a.withdrawal.acting = "codex/withdrawal-only";
      return roles;
    }
    if (fixture[path]) return structuredClone(fixture[path]);
    return { cards: [], withdrawals: [] };
  });
  for (const name of ["custom-id", "legacy-id", "codex/acting-only", "codex/declared-only", "codex/withdrawal-only"]) assert.ok(seen.has(name), name);
});

test("duplicate snapshot errors name every composite key component", async () => {
  const { INDEX_KEYS } = await import("../src/index-transfer.ts");
  const { I } = fresh(), { computed } = await carriedFixture();
  await I.putModelSnapshot(computed);
  for (const table of ["snapshot_takes", "model_snapshots"]) {
    const d = await I.exportIndex(), r = d.tables[table][0];
    d.tables[table].push(r); d.counts[table]++;
    assert.throws(() => validateIndex(d), (e) => e.message.includes(canonical(INDEX_KEYS[table].map((k) => r[k]))) && !e.message.includes("undefined"));
  }
});

for (const nativeTake of [false, true]) test(`model review admits carried points by recording time (${nativeTake ? "with" : "without"} native take)`, async () => {
  const { reviewModels } = await import("../src/models/review.ts");
  const { projection, computed, carried, dump } = await carriedFixture();
  // All days have a real count. Half were reconstructed after the review time.
  projection.measures = [projection.measures.find((m) => m.kind === "count")];
  for (let i = 0; i < 14; i++) projection.measures[0].points[i].takenAt = i < 7 ? "2026-10-29T01:00:00Z" : "2026-10-30T13:00:00Z";
  const base = { asOf: "2026-10-30T12:00:00Z", pool: fixture["/models"], sources: [], runs: [], assignmentEvents: [], owner: "owner", cards: [], assignments: [], rows: [carried], unread: [] };
  const takes = nativeTake ? [{ ...computed.take, rev: 1, revises: null }] : [];
  const review = reviewModels({ ...base, takes });
  assert.match(review.models[0].snapshots, /7 with a figure/);
  const { I, request } = fresh();
  if (nativeTake) await I.putModelSnapshot({ ...computed, rows: [] });
  dump.tables.model_snapshots[0].json = JSON.stringify(carried);
  await I.importIndex(dump);
  for (const at of [base.asOf, "2026-10-29T12:00:00Z"]) {
    const response = await request("GET", `/model-review?as-of=${encodeURIComponent(at)}`);
    assert.equal(response.status, 200);
    const shown = await response.json();
    assert.match(shown.models[0].snapshots, /7 with a figure/);
  }
});


test("a carried first value loses its old break when earlier values become gaps", async () => {
  const { trendOf } = await import("../src/models/snapshot.ts");
  const { projection, carried } = await carriedFixture();
  projection.measures = [projection.measures.find((m) => m.kind === "count")];
  const points = projection.measures[0].points;
  points[0].gap = "none yet"; points[0].value = null;
  points[1].breaks = "threshold from an unavailable predecessor";
  const shown = trendOf(projection.model, [], [carried], projection.to);
  assert.equal(shown.measures[0].points[1].breaks, null);
});
