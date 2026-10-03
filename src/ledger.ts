import { DurableObject } from "cloudflare:workers";
import {
  assertClaimable, assertOwner, gate, inboxFor, PAVI, RuleError, validActor,
  type Evidence, type InboxEntry, type Item, type ItemState, type ProjectPolicy, type Review,
} from "./rules";

// One Ledger per project holds its items, evidence, reviews and an append-only
// event log. A Durable Object runs one request at a time, so "exactly one owner"
// is enforced by construction: two agents claiming the same item are serialised
// and the second is refused. The instance named "__index" also lists projects.

export interface LedgerEvent {
  seq: number;
  itemId: string | null;
  at: string;
  actor: string;
  kind: string;
  data: Record<string, unknown>;
}

export interface ProjectRecord {
  name: string;
  repo: string;
  policy: ProjectPolicy;
  createdAt: string;
}

type Row = Record<string, SqlStorageValue>;

export class Ledger extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (name TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, scope TEXT NOT NULL, state TEXT NOT NULL,
        owner TEXT, fork TEXT, base TEXT, head TEXT, accepted_head TEXT, token_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_push_at TEXT
      );
      CREATE TABLE IF NOT EXISTS evidence (
        id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL, json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL, json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT, at TEXT NOT NULL,
        actor TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL
      );
    `);
  }

  // ── index instance ───────────────────────────────────────────────────────

  registerProject(record: ProjectRecord): void {
    this.sql.exec(`INSERT OR REPLACE INTO projects (name, json) VALUES (?, ?)`, record.name, JSON.stringify(record));
  }

  projects(): ProjectRecord[] {
    return this.sql.exec(`SELECT json FROM projects ORDER BY name`).toArray().map((r) => JSON.parse(r.json as string));
  }

  // ── project instance ─────────────────────────────────────────────────────

  setProject(record: ProjectRecord, actor: string): void {
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('project', ?)`, JSON.stringify(record));
    this.log(null, actor, "project.set", { policy: record.policy });
  }

  project(): ProjectRecord {
    const row = this.sql.exec(`SELECT value FROM meta WHERE key = 'project'`).toArray()[0];
    if (!row) throw new RuleError("no_project", "project not initialised; run `atelier init`", 404);
    return JSON.parse(row.value as string);
  }

  newItem(title: string, scope: string[], actor: string): Item {
    if (!title.trim()) throw new RuleError("bad_title", "an item needs a title", 400);
    const n = this.sql.exec(`SELECT COUNT(*) AS n FROM items`).one().n as number;
    const id = `t${n + 1}`;
    const now = new Date().toISOString();
    this.sql.exec(
      `INSERT INTO items (id, title, scope, state, created_at, updated_at) VALUES (?, ?, ?, 'open', ?, ?)`,
      id, title.trim(), JSON.stringify(scope), now, now,
    );
    this.log(id, actor, "item.created", { title, scope });
    return this.item(id);
  }

  item(id: string): Item {
    const row = this.sql.exec(`SELECT * FROM items WHERE id = ?`, id).toArray()[0];
    if (!row) throw new RuleError("no_item", `no item ${id}`, 404);
    return toItem(row);
  }

  items(): Item[] {
    return this.sql.exec(`SELECT * FROM items ORDER BY CAST(SUBSTR(id, 2) AS INTEGER)`).toArray().map(toItem);
  }

  tokenId(id: string): string | null {
    const row = this.sql.exec(`SELECT token_id FROM items WHERE id = ?`, id).toArray()[0];
    return (row?.token_id as string | null) ?? null;
  }

  claim(id: string, actor: string): { item: Item; needsFork: boolean } {
    const item = this.item(id);
    assertClaimable(item, actor);
    if (item.owner === actor) return { item, needsFork: !item.fork };
    this.update(id, { owner: actor, state: "claimed" });
    this.log(id, actor, "item.claimed", {});
    return { item: this.item(id), needsFork: !item.fork };
  }

  // A failed fork must not leave an owner holding nothing.
  unclaim(id: string, actor: string, reason: string): void {
    this.update(id, { owner: null, state: "open" });
    this.log(id, actor, "item.claim_failed", { reason });
  }

  setFork(id: string, fork: string, base: string | null, actor: string): void {
    this.update(id, { fork, base, head: base });
    this.log(id, actor, "fork.created", { fork, base });
  }

  setToken(id: string, tokenId: string | null): void {
    this.sql.exec(`UPDATE items SET token_id = ? WHERE id = ?`, tokenId, id);
  }

  // The worker has already read the fork's head from Artifacts; what is logged
  // here is what Atelier saw, not what the agent said it pushed.
  recordPush(id: string, actor: string, observedHead: string, reportedHead: string | null): Item {
    const item = this.item(id);
    assertOwner(item, actor);
    const now = new Date().toISOString();
    this.update(id, { head: observedHead, last_push_at: now, state: item.state === "submitted" ? "submitted" : "claimed" });
    this.log(id, actor, "push.observed", {
      head: observedHead,
      ...(reportedHead && reportedHead !== observedHead ? { reportedHead, mismatch: true } : {}),
    });
    return this.item(id);
  }

  addEvidence(e: Evidence): void {
    const item = this.item(e.itemId);
    if (e.head !== item.head) {
      throw new RuleError("stale_head", `evidence is for ${e.head.slice(0, 8)} but the item is at ${item.head?.slice(0, 8) ?? "nothing"}; push first`);
    }
    this.sql.exec(`INSERT INTO evidence (item_id, json) VALUES (?, ?)`, e.itemId, JSON.stringify(e));
    this.log(e.itemId, e.by, `evidence.${e.grade}`, { claim: e.claim, passed: e.passed, head: e.head });
  }

  addReview(r: Review): void {
    if (!validActor(r.by)) throw new RuleError("bad_actor", `"${r.by}" is not harness/model`, 400);
    const item = this.item(r.itemId);
    if (item.owner === r.by) throw new RuleError("self_review", "an owner cannot review their own item", 403);
    if (r.head !== item.head) throw new RuleError("stale_head", "review is for an older head", 409);
    this.sql.exec(`INSERT INTO reviews (item_id, json) VALUES (?, ?)`, r.itemId, JSON.stringify(r));
    this.log(r.itemId, r.by, r.approve ? "review.approved" : "review.rejected", { note: r.note, head: r.head });
  }

  submit(id: string, actor: string): Item {
    const item = this.item(id);
    assertOwner(item, actor);
    if (!item.head || item.head === item.base) throw new RuleError("nothing_pushed", "push work before submitting");
    this.update(id, { state: "submitted" });
    this.log(id, actor, "item.submitted", { head: item.head });
    return this.item(id);
  }

  // Ownership moves; the work does not fork. The new owner inherits the same
  // workspace repo, and the old owner's write token is revoked by the caller.
  handoff(id: string, from: string, to: string, note: string): Item {
    const item = this.item(id);
    if (from !== PAVI) assertOwner(item, from);
    if (!validActor(to)) throw new RuleError("bad_actor", `"${to}" is not harness/model`, 400);
    if (item.state !== "claimed" && item.state !== "submitted") throw new RuleError("closed", `${id} is ${item.state}`);
    this.update(id, { owner: to, state: "claimed" });
    this.log(id, from, "item.handoff", { from: item.owner, to, note });
    return this.item(id);
  }

  release(id: string, actor: string, note: string): Item {
    const item = this.item(id);
    if (actor !== PAVI) assertOwner(item, actor);
    this.update(id, { owner: null, state: "open" });
    this.log(id, actor, "item.released", { from: item.owner, note });
    return this.item(id);
  }

  accept(id: string, actor: string): Item {
    if (actor !== PAVI) throw new RuleError("not_pavi", "only PAVI accepts", 403);
    const item = this.item(id);
    const g = gate(item, this.project().policy, this.evidenceFor(id), this.reviewsFor(id));
    if (!g.ready) throw new RuleError("not_ready", `not ready: ${g.blockers.join("; ")}`);
    this.update(id, { state: "accepted", accepted_head: item.head });
    this.log(id, actor, "item.accepted", { head: item.head });
    return this.item(id);
  }

  merged(id: string, actor: string, mergeCommit: string, observed: boolean): Item {
    if (actor !== PAVI) throw new RuleError("not_pavi", "only PAVI merges", 403);
    const item = this.item(id);
    if (item.state !== "accepted") throw new RuleError("not_accepted", `${id} is ${item.state}`);
    this.update(id, { state: "merged", owner: null });
    this.log(id, actor, "item.merged", { mergeCommit, head: item.acceptedHead, observedOnBaseline: observed });
    return this.item(id);
  }

  abandon(id: string, actor: string, note: string): Item {
    if (actor !== PAVI) throw new RuleError("not_pavi", "only PAVI abandons", 403);
    this.update(id, { state: "abandoned", owner: null });
    this.log(id, actor, "item.abandoned", { note });
    return this.item(id);
  }

  evidenceFor(id: string): Evidence[] {
    return this.sql.exec(`SELECT json FROM evidence WHERE item_id = ? ORDER BY id`, id).toArray().map((r) => JSON.parse(r.json as string));
  }

  reviewsFor(id: string): Review[] {
    return this.sql.exec(`SELECT json FROM reviews WHERE item_id = ? ORDER BY id`, id).toArray().map((r) => JSON.parse(r.json as string));
  }

  events(id?: string, limit = 200): LedgerEvent[] {
    const rows = id
      ? this.sql.exec(`SELECT * FROM events WHERE item_id = ? ORDER BY seq DESC LIMIT ?`, id, limit).toArray()
      : this.sql.exec(`SELECT * FROM events ORDER BY seq DESC LIMIT ?`, limit).toArray();
    return rows.map((r) => ({
      seq: r.seq as number, itemId: r.item_id as string | null, at: r.at as string,
      actor: r.actor as string, kind: r.kind as string, data: JSON.parse(r.data as string),
    }));
  }

  detail(id: string) {
    const item = this.item(id);
    const policy = this.project().policy;
    const evidence = this.evidenceFor(id);
    const reviews = this.reviewsFor(id);
    return { item, policy, evidence, reviews, gate: gate(item, policy, evidence, reviews), events: this.events(id) };
  }

  inbox(now: string): InboxEntry[] {
    const p = this.project();
    const all = this.sql.exec(`SELECT json FROM evidence`).toArray().map((r) => JSON.parse(r.json as string));
    const rv = this.sql.exec(`SELECT json FROM reviews`).toArray().map((r) => JSON.parse(r.json as string));
    return inboxFor(p.name, this.items(), p.policy, all, rv, new Date(now));
  }

  private update(id: string, fields: Record<string, string | null>): void {
    const keys = Object.keys(fields);
    const set = keys.map((k) => `${k} = ?`).join(", ");
    this.sql.exec(`UPDATE items SET ${set}, updated_at = ? WHERE id = ?`, ...keys.map((k) => fields[k]), new Date().toISOString(), id);
  }

  private log(itemId: string | null, actor: string, kind: string, data: Record<string, unknown>): void {
    this.sql.exec(
      `INSERT INTO events (item_id, at, actor, kind, data) VALUES (?, ?, ?, ?, ?)`,
      itemId, new Date().toISOString(), actor, kind, JSON.stringify(data),
    );
  }
}

function toItem(r: Row): Item {
  return {
    id: r.id as string,
    title: r.title as string,
    scope: JSON.parse(r.scope as string),
    state: r.state as ItemState,
    owner: (r.owner as string | null) ?? null,
    fork: (r.fork as string | null) ?? null,
    base: (r.base as string | null) ?? null,
    head: (r.head as string | null) ?? null,
    acceptedHead: (r.accepted_head as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    lastPushAt: (r.last_push_at as string | null) ?? null,
  };
}
