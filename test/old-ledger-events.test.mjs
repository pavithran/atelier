// t518, criterion 2: a ledger written before the stuck-stage events and the
// tier review were deleted still loads, and `atelier show`, `atelier status`
// and `atelier events` read it without error. The fixture ledger holds what
// the server wrote then: stage.stuck, stage.told, stage.cleared and
// stage.rerouted events, a review.tier_needed event, a tier review request
// and a tier review with its tier and topTier marks.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Namespace } from "../src/runtime/namespace.mjs";
import { Ledger } from "../src/ledger.ts";

const root = mkdtempSync(join(tmpdir(), "atelier-old-ledger-"));
const token = "atl_00112233445566778899aabbccddeeff";
const workerEnv = { ATELIER_TOKEN: token, OWNER_ACTOR: "owner" };
const namespace = new Namespace({ dir: join(root, "data"), Class: Ledger, env: workerEnv });
workerEnv.LEDGER = namespace;
const preload = join(root, "requests.mjs");
writeFileSync(preload, `
import ${JSON.stringify(new URL("../src/runtime/loader.mjs", import.meta.url).href)};
import { Namespace } from ${JSON.stringify(new URL("../src/runtime/namespace.mjs", import.meta.url).href)};
import worker, { Ledger } from ${JSON.stringify(new URL("../src/index.ts", import.meta.url).href)};
const env = { ATELIER_TOKEN: ${JSON.stringify(token)}, OWNER_ACTOR: "owner" };
env.LEDGER = new Namespace({ dir: ${JSON.stringify(join(root, "data"))}, Class: Ledger, env });
globalThis.fetch = (url, options) => worker.fetch(new Request(url, options), env);
`);
after(async () => { await namespace.close(); rmSync(root, { recursive: true, force: true }); });

const cli = resolve("cli/atelier.mjs");
const run = (...args) => new Promise((done) => execFile(process.execPath, ["--import", resolve("src/runtime/loader.mjs"), "--import", preload, cli, ...args, "--project", "old", "--as", "claude-code/opus-5.5"], {
  cwd: root, timeout: 60_000, env: { ...process.env, ATELIER_CONFIG_DIR: join(root, "config"), ATELIER_CACHE: join(root, "cache"), ATELIER_SERVER: "https://atelier.test", ATELIER_TOKEN: token, NO_COLOR: "1" },
}, (error, stdout, stderr) => done({ code: error?.code ?? 0, stdout, stderr })));

const BUILDER = "claude-code/opus-5.5", GATE = "codex/gpt-6-astra", TIER = "antigravity/gemini-4-argon";
const HEAD = "a".repeat(40), AT = "2026-11-02T10:00:00.000Z";
let id;

test("a ledger holding stage.stuck, stage.cleared, stage.told, stage.rerouted and tier_needed events and a tier review loads", async () => {
  const L = namespace.get(namespace.idFromName("project:old"));
  const record = { name: "old", repo: "old", policy: { checks: ["npm test"], protected: ["src/**"], reviewTier: [TIER], exactNames: ["reviewTier"] }, createdAt: "2026-11-01T00:00:00Z" };
  await L.setProject(record, "owner");
  await namespace.get(namespace.idFromName("__index")).registerProject(record);
  id = (await L.newItem("Old work", ["src/a.ts"], "owner", { accept: ["It works"] })).id;
  await L.claim(id, BUILDER);
  await L.setWorkspace(id, "old", "0".repeat(40), BUILDER);
  await L.recordPush(id, BUILDER, HEAD, HEAD);
  const sql = namespace.object("project:old").live.sql;
  const event = (kind, data, actor = "atelier") => sql.exec(`INSERT INTO events (item_id, at, actor, kind, data) VALUES (?, ?, ?, ?, ?)`, id, AT, actor, kind, JSON.stringify(data));
  event("stage.stuck", { stage: "built", head: HEAD, enteredAt: AT, limitMs: 1_200_000, overMs: 60_000, note: `${BUILDER}: run atelier check ${id}` });
  event("stage.told", { stage: "built", head: HEAD, note: "the tick cannot act on this stage" });
  event("stage.cleared", { stage: "built", head: HEAD });
  event("stage.rerouted", { stage: "queued", head: "", from: "codex/gpt-6", to: "codex/gpt-6-astra" });
  event("stage.stuck", { stage: "checked-tier", head: HEAD, enteredAt: AT, limitMs: 600_000, overMs: 1000, note: `the tier's review request 1 asked of ${TIER} is unclaimed since ${AT}` });
  event("review.tier_needed", { head: HEAD, criteria: "c".repeat(64), gate: GATE, candidates: [{ actor: TIER, refusal: null }, { actor: BUILDER, refusal: "contributed to it" }], next: `atelier review-request ${id} --reviewer H/M --tier-review` });
  event("review.requested", { head: HEAD, reviewer: TIER, tier: true, reason: "Named by the developer" }, "owner");
  event("review.requested", { head: HEAD, reviewer: GATE, topTier: true }, "owner");
  event("review.approved", { head: HEAD, note: "Tier: fine.", tier: true }, TIER);
  sql.exec(`INSERT INTO review_requests (item, head, dispatch, state, tier) VALUES (?, ?, ?, 'answered', 1)`, id, HEAD, JSON.stringify({ to: "home", agent: "antigravity", model: "gemini-4-argon", job: "review" }));
  sql.exec(`INSERT INTO reviews (item_id, json, head, approve) VALUES (?, ?, ?, 1)`, id, JSON.stringify({ itemId: id, by: TIER, head: HEAD, approve: true, note: "Tier: fine.", at: AT, tier: true, claimed: true, recordedBy: "owner", proved: true }), HEAD);
  sql.exec(`INSERT INTO reviews (item_id, json, head, approve) VALUES (?, ?, ?, 0)`, id, JSON.stringify({ itemId: id, by: GATE, head: HEAD, approve: false, note: "Gate and tier: no.", at: AT, topTier: true, claimed: true, recordedBy: "owner", proved: true }), HEAD);
  // The ledger reads: the item, its events and its reviews come back whole.
  const kinds = (await L.events(id, 1000)).map((e) => e.kind);
  for (const kind of ["stage.stuck", "stage.told", "stage.cleared", "stage.rerouted", "review.tier_needed"]) assert.ok(kinds.includes(kind), kind);
  assert.equal((await L.reviewsFor(id)).length, 2);
});

const clean = (r) => {
  assert.equal(r.code, 0, `${r.stderr}\n${r.stdout}`);
  assert.equal(r.stderr, "");
  assert.doesNotMatch(r.stdout, /undefined|\[object Object\]|NaN/);
  return r.stdout;
};

test("atelier show renders a task whose ledger holds the old events and a tier review, as text and as JSON", async () => {
  const text = clean(await run("show", id));
  assert.match(text, new RegExp(`${id}`));
  assert.doesNotMatch(text, /--tier-review/, "show suggests no command that no longer exists");
  const reviews = clean(await run("show", id, "--reviews"));
  assert.match(reviews, /Tier review: antigravity\/gemini-4-argon approved/);
  assert.match(reviews, /Gate review, top tier: codex\/gpt-6-astra rejected/);
  const json = JSON.parse(clean(await run("show", id, "--json")));
  assert.equal(json.id ?? json.item?.id ?? id, id);
  assert.equal(json.tierReview, undefined);
});

test("atelier events lists the old stage and tier events, and atelier status reads the project", async () => {
  const events = JSON.parse(clean(await run("events"))).filter((e) => e.item === id).map((e) => e.kind);
  for (const kind of ["stage.stuck", "stage.cleared", "stage.told", "stage.rerouted", "review.tier_needed"]) assert.ok(events.includes(kind), kind);
  const byKind = JSON.parse(clean(await run("events", "--kind", "stage.stuck", "--kind", "stage.cleared")));
  assert.deepEqual([...new Set(byKind.map((e) => e.kind))].sort(), ["stage.cleared", "stage.stuck"]);
  const status = clean(await run("status"));
  assert.match(status, /old/);
  assert.doesNotMatch(status, /stage\.stuck/);
  clean(await run("status", "--json"));
});

test("the stage tick on a ledger holding old stage events records nothing and clears nothing", async () => {
  const L = namespace.get(namespace.idFromName("project:old"));
  const before = (await L.events(id, 1000)).length;
  const result = await L.stageTick(new Date(Date.now() + 3 * 24 * 3_600_000));
  assert.equal(result.complete, true);
  assert.equal((await L.events(id, 1000)).length, before, "the old stuck record is neither cleared nor repeated");
});
