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
  assert.deepEqual(d.counts, { models: 1, model_notes: 1, model_cards: 2, model_assignments: 2, runs: 2 });
  assert.equal(d.limitations.length, 5);
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
