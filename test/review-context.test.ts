import { test } from "node:test";
import assert from "node:assert/strict";
import { contextOf, reviewBrief } from "../src/review/brief.ts";
import { rejectionRequest, reviewNeeded, type ReviewRequired } from "../src/review/needed.ts";
import type { LedgerEvent } from "../src/ledger.ts";
import type { Evidence, Item, ProjectPolicy } from "../src/rules.ts";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

// Use the real ledger and SQLite, with only the Worker base class and cursor
// interface adapted for Node. Bundling writes no files.
const bundle = await build({ entryPoints: ["src/ledger.ts"], bundle: true, write: false, platform: "node", format: "esm", plugins: [{ name: "durable-object", setup(b) {
  b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "workers", namespace: "test" }));
  b.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" }));
} }] });
const { Ledger } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text + "\n//# sourceURL=ledger-context-test.mjs").toString("base64")}`);

function setup(t: import("node:test").TestContext) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const pending: Promise<unknown>[] = [];
  const storage = {
    sql: { exec(query: string, ...bindings: import("node:sqlite").SQLInputValue[]) {
      let rows: Record<string, unknown>[];
      if (query.trim().split(";").filter(s => s.trim()).length > 1) { db.exec(query); rows = []; }
      else rows = db.prepare(query).all(...bindings);
      return { toArray: () => rows, one: () => { assert.equal(rows.length, 1); return rows[0]; }, [Symbol.iterator]: () => rows[Symbol.iterator]() };
    } },
    transactionSync<T>(fn: () => T): T {
      db.exec("SAVEPOINT test");
      try { const result = fn(); db.exec("RELEASE test"); return result; }
      catch (error) { db.exec("ROLLBACK TO test; RELEASE test"); throw error; }
    },
  };
  const ctx = { storage, waitUntil(work: Promise<unknown>) { pending.push(work); } };
  const ledgerEnv = { NTFY_TOPIC: "test-topic" };
  const ledger = new Ledger(ctx, ledgerEnv);
  ledger.setProject({ name: "demo", repo: "demo--baseline", policy: { checks: [], protected: [] }, createdAt: T }, "owner");
  const task = ledger.newItem("Review context", ["src/**"], "owner");
  ledger.claim(task.id, GLM);
  db.prepare("UPDATE items SET state = 'submitted', head = ?, base = ? WHERE id = ?").run(H2, H0, task.id);
  db.prepare("INSERT INTO evidence (item_id, json) VALUES (?, ?)").run(task.id, JSON.stringify({ ...pass, itemId: task.id }));
  function request(reviewer: string) {
    const [agent, model] = reviewer.split("/");
    db.prepare("INSERT INTO review_requests (item, head, dispatch, state, wanted) VALUES (?, ?, ?, 'open', 1)")
      .run(task.id, H2, JSON.stringify({ to: "any", agent, model }));
  }
  return { ledger, db, pending, task, request, restore: () => new Ledger(ctx, ledgerEnv) };
}

// The task's context: decisions the orchestrator wrote for the reviewers, set
// and replaced by item.context events, rendered into every reviewer's brief.

const H0 = "0".repeat(40), H2 = "b".repeat(40), T = "2026-10-05T12:00:00.000Z";
const GLM = "zcode/glm-5.3";
const item: Item = {
  id: "t21", title: "Review rules", scope: ["src/review/**"], state: "submitted", owner: GLM,
  fork: "p--t21", base: H0, head: H2, acceptedHead: null, pushActors: [GLM], createdAt: T, updatedAt: T, lastPushAt: T,
};
const policy: ProjectPolicy = { checks: ["npm test"], protected: ["AGENTS.md"] };
const pass: Evidence = { itemId: "t21", claim: "npm test", grade: "observed", head: H2, passed: true, by: "atelier/sandbox", at: T, changedPaths: ["src/review/needed.ts"], where: "sandbox" };
const need = (): ReviewRequired => {
  const n = reviewNeeded({ item, part: true, policy, evidence: [pass], reviews: [], now: new Date("2026-10-05T13:00:00.000Z"), owner: "pavi" });
  assert.ok(n.needed, n.reason);
  return n;
};
const ctx = (seq: number, text: unknown): LedgerEvent => ({ seq, itemId: "t21", at: T, actor: "orchestrator", kind: "item.context", data: { text } });

test("contextOf: set, replaced by a later event, cleared by empty text, absent", () => {
  assert.equal(contextOf([]), null);
  assert.equal(contextOf([ctx(1, "Keep the ledger column out.")]), "Keep the ledger column out.");
  assert.equal(contextOf([ctx(1, "first"), ctx(5, "second"), ctx(3, "middle")]), "second");
  assert.equal(contextOf([ctx(5, "second"), ctx(1, "first")]), "second");
  assert.equal(contextOf([ctx(1, "first"), ctx(2, "  ")]), null);
  assert.equal(contextOf([{ ...ctx(1, "x"), kind: "item.edited" }]), null);
});

test("a brief carries the context for each of two reviewers, the same text", () => {
  const text = "The notice path is reused.\n```\nnot a new channel";
  const n = need();
  const a = reviewBrief({ need: n, item, events: [], owner: "pavi", context: contextOf([ctx(1, "old"), ctx(2, text)]) });
  const b = reviewBrief({ need: n, item, events: [], owner: "pavi", context: contextOf([ctx(1, "old"), ctx(2, text)]) });
  assert.equal(a, b);
  assert.match(a, /Context from the orchestrator/);
  assert.ok(a.includes("The notice path is reused.\n```\nnot a new channel"));
  assert.ok(!a.includes("old\n"));
});

test("a brief without context is the brief it was before the field", () => {
  const n = need();
  const bare = reviewBrief({ need: n, item, events: [], owner: "pavi" });
  assert.equal(reviewBrief({ need: n, item, events: [], owner: "pavi", context: null }), bare);
  assert.equal(reviewBrief({ need: n, item, events: [], owner: "pavi", context: "" }), bare);
  assert.ok(!bare.includes("Context from the orchestrator"));
});

test("a rejection's message names the reviewer, the head and the note, on the ordinary notification", () => {
  const base = new Request("https://ntfy.sh/topic", { method: "POST", headers: { Title: "t", Click: "https://x.test/p/a/t21" }, body: "Accept t21" });
  const r = rejectionRequest(base, { by: "codex/gpt-6-astra", head: H2, note: "two\nlines  of note" });
  assert.equal(r.method, "POST");
  assert.equal(r.url, base.url);
  assert.equal(r.headers.get("Click"), "https://x.test/p/a/t21");
  return r.text().then((body) => assert.equal(body, `codex/gpt-6-astra rejected bbbbbbbb: two lines of note`));
});

test("ledger context replacements survive a restart and reach both review claims", async (t) => {
  const { ledger, db, task, request, restore } = setup(t);
  assert.throws(() => ledger.setContext(task.id, GLM, "unauthorized"), /not_project_owner/);
  ledger.setContext(task.id, "owner", "first");
  ledger.setContext(task.id, "atelier/orchestrator", "Use the existing notice path.");
  const events = db.prepare("SELECT actor, data FROM events WHERE item_id = ? AND kind = 'item.context' ORDER BY seq").all(task.id);
  assert.deepEqual(events.map(e => JSON.parse(e.data as string).text), ["first", "Use the existing notice path."]);
  for (const reviewer of ["codex/gpt-6-astra", "claude-code/sonnet-5.5"]) {
    request(reviewer);
    const claim = await restore().claimReview(task.id, reviewer, { runner: reviewer, kind: "home" });
    assert.equal(claim.context, "Use the existing notice path.");
    assert.ok(claim.need);
    const brief = reviewBrief({ ...claim, need: claim.need });
    assert.ok(brief.includes("Use the existing notice path."));
  }
});

test("unset and cleared ledger context produce no brief section", async (t) => {
  const { ledger, task, request, restore } = setup(t);
  for (const [index, reviewer] of ["codex/gpt-6-astra", "claude-code/sonnet-5.5"].entries()) {
    if (index) {
      ledger.setContext(task.id, "owner", "discarded");
      ledger.setContext(task.id, "owner", "");
    }
    request(reviewer);
    const claim = await restore().claimReview(task.id, reviewer, { runner: reviewer, kind: "home" });
    assert.equal(claim.context, null);
    assert.ok(claim.need);
    const brief = reviewBrief({ ...claim, need: claim.need });
    assert.equal(brief, reviewBrief({ ...claim, need: claim.need, context: undefined }));
    assert.ok(!brief.includes("Context from the orchestrator"));
  }
});

for (const merged of [false, true]) test(`recording a ${merged ? "post-merge" : "submitted"} rejection delivers immediately`, async (t) => {
  const { ledger, db, task, request, pending } = setup(t);
  const sent: Request[] = [];
  t.mock.method(globalThis, "fetch", async (req: Request) => { sent.push(req); return new Response(null); });
  ledger.setNotificationOrigin(task.id, "https://atelier.test");
  // A previous notice at the same head must not silence a rejection.
  db.prepare("INSERT INTO notifications (item_id, head) VALUES (?, ?)").run(task.id, H2);
  if (merged) {
    db.prepare("UPDATE items SET state = 'merged', accepted_head = ? WHERE id = ?").run(H2, task.id);
    db.prepare("INSERT INTO events (item_id, at, actor, kind, data) VALUES (?, ?, 'owner', 'item.merged', ?)")
      .run(task.id, T, JSON.stringify({ head: H2, mergeCommit: H2 }));
  }
  const reviewer = "codex/gpt-6-astra";
  request(reviewer);
  const claim = await ledger.claimReview(task.id, reviewer, { runner: "reviewer", kind: "home" });
  ledger.addReview({ itemId: task.id, by: reviewer, head: H2, criteria: claim.criteria, request: claim.request, approve: false, note: "Fix the notice", at: T });
  assert.equal(sent.length, 1, "delivery starts in addReview, before any poll or alarm");
  assert.equal(sent[0].url, "https://ntfy.sh/test-topic");
  assert.equal(await sent[0].text(), "codex/gpt-6-astra rejected bbbbbbbb: Fix the notice");
  await Promise.all(pending);
});
