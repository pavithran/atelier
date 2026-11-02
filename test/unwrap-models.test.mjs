import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Namespace } from "../src/runtime/namespace.mjs";
import { Ledger } from "../src/ledger.ts";
import { parseStanding } from "../src/standing.ts";

const root = mkdtempSync(join(tmpdir(), "atelier-unwrap-models-"));
const token = "atl_00112233445566778899aabbccddeeff";
const workerEnv = { ATELIER_TOKEN: token, OWNER_ACTOR: "owner" };
const namespace = new Namespace({ dir: join(root, "data"), Class: Ledger, env: workerEnv });
workerEnv.LEDGER = namespace;
const preload = join(root, "requests.mjs");
writeFileSync(preload, `
import ${JSON.stringify(new URL("../src/runtime/loader.mjs", import.meta.url).href)};
import { appendFileSync } from "node:fs";
import { Namespace } from ${JSON.stringify(new URL("../src/runtime/namespace.mjs", import.meta.url).href)};
import worker, { Ledger } from ${JSON.stringify(new URL("../src/index.ts", import.meta.url).href)};
const env = { ATELIER_TOKEN: ${JSON.stringify(token)}, OWNER_ACTOR: "owner" };
env.LEDGER = new Namespace({ dir: ${JSON.stringify(join(root, "data"))}, Class: Ledger, env });
globalThis.fetch = (url, options) => {
  appendFileSync(${JSON.stringify(join(root, "requests.jsonl"))}, JSON.stringify({ method: options.method, path: new URL(url).pathname }) + "\\n");
  return worker.fetch(new Request(url, options), env);
};
`);
after(async () => { await namespace.close(); rmSync(root, { recursive: true, force: true }); });
const cli = resolve("cli/atelier.mjs");
const run = (project, ...args) => {
  writeFileSync(join(root, "requests.jsonl"), "");
  return new Promise((done) => execFile(process.execPath, ["--import", resolve("src/runtime/loader.mjs"), "--import", preload, cli, ...args, "--project", project, "--as", "claude-code/opus-5.5"], {
    cwd: root, timeout: 30_000, env: { ...process.env, ATELIER_CONFIG_DIR: join(root, "config"), ATELIER_CACHE: join(root, "cache"), ATELIER_SERVER: "https://atelier.test", ATELIER_TOKEN: token, ATELIER_ACTOR: "owner", ATELIER_ACTING: "codex/gpt-6-astra" },
  }, (error, stdout, stderr) => done({ code: error?.code ?? 0, stdout, stderr, requests: readFileSync(join(root, "requests.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) })));
};
async function project(name) {
  const L = namespace.get(namespace.idFromName(`project:${name}`));
  const record = { name, repo: name, policy: { checks: [], protected: [] }, createdAt: "2026-11-01T00:00:00Z" };
  await L.setProject(record, "owner");
  await namespace.get(namespace.idFromName("__index")).registerProject(record);
  return L;
}
const modelLines = (r) => {
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.requests.every((q) => q.method === "GET" && !q.path.includes("usage")));
  assert.ok(r.requests.filter((q) => /\/items\/t\d+$/.test(q.path)).length <= 5);
  return r.stdout.split("\n").filter((l) => l.startsWith("Models") || l.startsWith("  Build:") || l.startsWith("  Review:"));
};

test("decide --standing models records a free-text plan in full mode and unwrap prints it", async () => {
  const L = await project("model-plan");
  const plan = "Orchestrate: GPT high; build: Sonnet medium; review: Opus high";
  const recorded = await run("model-plan", "decide", "--standing", "models", plan, "--quote", "tell me the model plan");
  assert.equal(recorded.code, 0, recorded.stderr);
  assert.doesNotMatch(recorded.stdout, /acts while.*fast mode/);
  const [decision] = await L.decisions();
  assert.deepEqual(decision.standing, { key: "models", value: plan });
  const unwrapped = await run("model-plan", "unwrap");
  assert.deepEqual(modelLines(unwrapped), [`Models plan: ${plan}`]);
  assert.ok(!unwrapped.requests.some((q) => /\/items\//.test(q.path)));
  const listed = await run("model-plan", "decisions");
  assert.doesNotMatch(listed.stdout, /They act while.*fast mode/);
  const gated = await run("model-plan", "decide", "--standing", "queue-landable", "on", "--quote", "queue it");
  assert.equal(gated.code, 1);
  assert.match(gated.stderr, /not_fast/);
  assert.equal((await run("model-plan", "decisions", "withdraw", decision.id, "--note", "choose again")).code, 0);
  assert.deepEqual(modelLines(await run("model-plan", "unwrap")), ["Models: no plan set; build: none yet; review: none yet."]);
});

test("the models key requires readable text and keeps it on one line", () => {
  assert.deepEqual(parseStanding({ key: "models", value: " Build high\nReview medium\u001b " }), { key: "models", value: "Build high Review medium" });
  assert.throws(() => parseStanding({ key: "models", value: "\u0000\n " }), /models takes/);
});

test("without a plan unwrap says none yet for a project with no model work", async () => {
  await project("model-empty");
  assert.deepEqual(modelLines(await run("model-empty", "unwrap")), ["Models: no plan set; build: none yet; review: none yet."]);
});

test("without a plan unwrap reports actual recent builders and recorded reviewers, not a queued model", async () => {
  await project("model-recent");
  await namespace.object("project:model-recent").live.sql.exec(`INSERT INTO items (id, title, scope, state, head, created_at, updated_at, last_push_at) VALUES (?, ?, '[]', ?, ?, ?, ?, ?)`, "t1", "Built", "merged", "a".repeat(40), "2026-11-01", "2026-11-01", "2026-11-01");
  await namespace.object("project:model-recent").live.sql.exec(`INSERT INTO events (item_id, at, actor, kind, data) VALUES ('t1', '2026-11-01', 'codex/gpt-6-astra', 'push.observed', '{}')`);
  const review = { itemId: "t1", by: "claude-code/opus-5.5", head: "a".repeat(40), approve: true, note: "Reviewed", at: "2026-11-01" };
  await namespace.object("project:model-recent").live.sql.exec(`INSERT INTO reviews (item_id, json, head, approve) VALUES (?, ?, ?, ?)`, "t1", JSON.stringify(review), review.head, 1);
  await namespace.object("project:model-recent").live.sql.exec(`INSERT INTO items (id, title, scope, state, dispatch, created_at, updated_at) VALUES ('t2', 'Queued', '[]', 'open', ?, '2026-11-02', '2026-11-02')`, JSON.stringify({ to: "home", agent: "codex", model: "unused-model", at: "2026-11-02", by: "owner", note: "" }));
  for (let n = 3; n <= 7; n++) await namespace.object("project:model-recent").live.sql.exec(`INSERT INTO items (id, title, scope, state, created_at, updated_at) VALUES (?, 'Older', '[]', 'open', '2026-10-01', '2026-10-01')`, `t${n}`);
  const result = await run("model-recent", "unwrap");
  assert.equal(result.requests.filter((q) => /\/items\/t\d+$/.test(q.path)).length, 5);
  assert.deepEqual(modelLines(result), ["Models: no plan set; recent tasks used (last 5 updated tasks):", "  Build: codex/gpt-6-astra (t1)", "  Review: claude-code/opus-5.5 (t1)"]);
});
