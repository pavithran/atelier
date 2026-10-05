import { OBSERVED_UNDER, type ModelEntry, type ModelStatus } from "./models/pool";
import { DurableObject } from "cloudflare:workers";
import {
  assertClaimAllowed, assertEligible, assertOwner, assertRevision, assertLive, DEFAULT_OWNER, gate, inboxFor, RuleError, validActor,
  type Evidence, type InboxEntry, type Item, type ItemState, type ProjectPolicy, type Review,
} from "./rules";
import { cleanSummary } from "./brief";
import { notificationRequest } from "./notify.ts";
import { assertDispatchable, assertDispatchedClaim, makeDispatch, type Dispatch, type RunnerKind } from "./dispatch/rules";

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
  revision?: number;      // one more on every init; the index keeps the newest copy
  name: string;           // the key: storage, links, commands
  title?: string;         // what people read; the name when absent
  repo: string;
  policy: ProjectPolicy;
  createdAt: string;
}

type Row = Record<string, SqlStorageValue>;

// What an init asks for. A field present replaces the project's current
// value; a field absent keeps it. `reset` starts from the defaults, as a
// first init does. `title: null` clears the title.
export interface ProjectInit {
  name: string;
  repo: string;
  reset: boolean;
  title?: string | null;
  checks?: string[];
  protected?: string[];
  agents?: ProjectPolicy["agents"];
  execution?: ProjectPolicy["execution"];
  eligible?: string[];
  refuseOverlap?: boolean;
  sandboxOnly?: boolean;
  approval?: string | null;
}

export const DEFAULT_PROTECTED = ["AGENTS.md", "CLAUDE.md", "wrangler.*"];

// `reset` starts the policy over; the project's identity (its title, when the
// init does not name one, and when it was created) is kept either way.
export function mergeProject(current: ProjectRecord | null, i: ProjectInit, at: string): ProjectRecord {
  const p = i.reset ? undefined : current?.policy;
  const title = i.title === undefined ? current?.title : i.title ?? undefined;
  const approval = i.approval === undefined ? p?.approval : i.approval ?? undefined;
  return {
    revision: (current?.revision ?? 0) + 1,
    name: i.name,
    ...(title ? { title } : {}),
    repo: i.repo,
    policy: {
      ...((i.agents ?? p?.agents) !== undefined ? { agents: i.agents ?? p?.agents } : {}),
      ...((i.execution ?? p?.execution) !== undefined ? { execution: i.execution ?? p?.execution } : {}),
      checks: i.checks ?? p?.checks ?? [],
      protected: i.protected ?? p?.protected ?? [...DEFAULT_PROTECTED],
      eligible: i.eligible ?? p?.eligible ?? [],
      refuseOverlap: i.refuseOverlap ?? p?.refuseOverlap ?? false,
      sandboxOnly: i.sandboxOnly ?? p?.sandboxOnly ?? false,
      ...(approval ? { approval } : {}),
    },
    createdAt: current?.createdAt ?? at,
  };
}

export function assertRepoAvailable(projects: ProjectRecord[], name: string, repo: string): void {
  if (projects.some((p) => p.name === name)) return;
  const other = projects.find((p) => p.name !== name && p.repo === repo);
  if (other) throw new RuleError("repo_taken", `baseline ${repo} is already registered to ${other.name}`, 409);
}

export function assertProjectRemovable(items: Pick<Item, "state">[], force: boolean): void {
  if (!force && items.some((i) => ["claimed", "submitted", "accepted"].includes(i.state))) {
    throw new RuleError("live_work", "project has claimed, submitted or accepted work; use --force to remove it", 409);
  }
}

export class Ledger extends DurableObject<Env> {
  private sql: SqlStorage;

  private get owner(): string {
    return (this.env as unknown as { OWNER_ACTOR?: string }).OWNER_ACTOR || DEFAULT_OWNER;
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (name TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS models (id TEXT PRIMARY KEY, json TEXT NOT NULL);
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
      CREATE TABLE IF NOT EXISTS notifications (
        item_id TEXT NOT NULL, head TEXT NOT NULL, PRIMARY KEY (item_id, head)
      );
      CREATE TABLE IF NOT EXISTS notification_origins (item_id TEXT PRIMARY KEY, origin TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT, at TEXT NOT NULL,
        actor TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL
      );
    `);
    // Added after the first deploy; existing ledgers gain the column once.
    const columns = this.sql.exec(`PRAGMA table_info(items)`).toArray().map((c) => c.name);
    if (!columns.includes("dispatch")) this.sql.exec(`ALTER TABLE items ADD COLUMN dispatch TEXT`);
    if (!columns.includes("runner")) this.sql.exec(`ALTER TABLE items ADD COLUMN runner TEXT`);
  }

  // ── index instance ───────────────────────────────────────────────────────

  // Two inits finishing out of order must not leave the older copy listed.
  registerProject(record: ProjectRecord): void {
    this.assertRepoAvailable(record.name, record.repo);
    const row = this.sql.exec(`SELECT json FROM projects WHERE name = ?`, record.name).toArray()[0];
    const held = row ? (JSON.parse(row.json as string) as ProjectRecord).revision ?? 0 : -1;
    if ((record.revision ?? 0) < held) return;
    this.sql.exec(`INSERT OR REPLACE INTO projects (name, json) VALUES (?, ?)`, record.name, JSON.stringify(record));
  }

  assertRepoAvailable(name: string, repo: string): void {
    assertRepoAvailable(this.projects(), name, repo);
  }

  removeProject(name: string): boolean {
    return this.sql.exec(`DELETE FROM projects WHERE name = ?`, name).rowsWritten > 0;
  }

  projects(): ProjectRecord[] {
    return this.sql.exec(`SELECT json FROM projects ORDER BY name`).toArray().map((r) => JSON.parse(r.json as string));
  }

  // The model pool, on the index instance like the project list: shared by
  // every project, written by the owner, read by runners.
  models(): ModelEntry[] {
    return this.sql.exec(`SELECT json FROM models ORDER BY id`).toArray().map((r) => JSON.parse(r.json as string));
  }

  putModel(entry: ModelEntry): ModelEntry {
    const row = this.sql.exec(`SELECT json FROM models WHERE id = ?`, entry.id).toArray()[0];
    // A status is kept only while the entry is reached the way it was when
    // the status was observed; a change there makes it a new, unchecked model.
    const kept = row ? (JSON.parse(row.json as string) as ModelEntry) : undefined;
    const status = kept && OBSERVED_UNDER.every((k) => kept[k] === entry[k]) ? kept.status : undefined;
    const record = { ...entry, ...(status ? { status } : {}) };
    this.sql.exec(`INSERT OR REPLACE INTO models (id, json) VALUES (?, ?)`, entry.id, JSON.stringify(record));
    return record;
  }

  removeModel(id: string): boolean {
    return this.sql.exec(`DELETE FROM models WHERE id = ?`, id).rowsWritten > 0;
  }

  // Only a runner of the kind the model runs on may report it: a home model
  // by a home runner, a cloud model by a cloud runner.
  setModelStatus(id: string, status: ModelStatus, kind: "home" | "cloud"): ModelEntry {
    const row = this.sql.exec(`SELECT json FROM models WHERE id = ?`, id).toArray()[0];
    if (!row) throw new RuleError("no_model", `${id} is not in the model pool`, 404);
    const entry = JSON.parse(row.json as string) as ModelEntry;
    if (entry.where !== kind) throw new RuleError("wrong_runner", `${id} runs ${entry.where === "home" ? "at home" : "in the cloud"}; a ${kind} runner cannot report it`, 403);
    const record = { ...entry, status };
    this.sql.exec(`UPDATE models SET json = ? WHERE id = ?`, JSON.stringify(record), id);
    return record;
  }

  // ── project instance ─────────────────────────────────────────────────────

  // An init, merged into the current record in one step: the Durable Object
  // runs one call at a time, so no other init can change the project between
  // the read and the write.
  initProject(init: ProjectInit, actor: string): ProjectRecord {
    const row = this.sql.exec(`SELECT value FROM meta WHERE key = 'project'`).toArray()[0];
    const record = mergeProject(row ? JSON.parse(row.value as string) : null, init, new Date().toISOString());
    this.setProject(record, actor);
    return record;
  }

  setProject(record: ProjectRecord, actor: string): void {
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('project', ?)`, JSON.stringify(record));
    this.log(null, actor, "project.set", { policy: record.policy, ...(record.policy.approval ? { approval: record.policy.approval } : {}) });
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

  claim(id: string, actor: string, runner: { runner: string; kind: RunnerKind } | null = null): { item: Item; needsFork: boolean } {
    const item = this.item(id);
    assertDispatchedClaim(item, actor, runner);
    assertClaimAllowed(item, this.items(), this.project().policy, actor, this.owner);
    if (item.owner === actor) {
      // Re-claiming refreshes the write token, so it is allowed only from where
      // the claim is held: two runners offering the same agent and model share
      // an actor name, and the second must not take over the first's fork.
      const held = item.runner ?? null, asking = runner?.runner ?? null;
      if (held && held !== asking) {
        throw new RuleError("owned", `${id} is held by ${actor} on ${held}, not ${asking ?? "a claim made without a runner"}`);
      }
      // After a handoff the new owner holds no runner yet; the first runner to
      // claim as that owner takes the claim, and any other is refused above.
      if (!held && asking) this.update(id, { owner: actor, runner: asking });
      return { item: this.item(id), needsFork: !item.fork };
    }
    this.update(id, { owner: actor, state: "claimed", runner: runner?.runner ?? null });
    this.log(id, actor, "item.claimed", runner ? { runner: runner.runner } : {});
    return { item: this.item(id), needsFork: !item.fork };
  }

  // The project owner puts an open task in the queue for a kind of runner.
  // Only the owner, for now; an orchestrator with an approved plan comes later.
  dispatch(id: string, actor: string, input: Record<string, unknown>): Item {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner dispatches", 403);
    const item = this.item(id);
    assertDispatchable(item);
    const d = makeDispatch(input, actor, new Date().toISOString());
    this.sql.exec(`UPDATE items SET dispatch = ?, updated_at = ? WHERE id = ?`, JSON.stringify(d), d.at, id);
    this.log(id, actor, "item.dispatched", { to: d.to, agent: d.agent, model: d.model, note: d.note });
    return this.item(id);
  }

  undispatch(id: string, actor: string): Item {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner withdraws a dispatch", 403);
    const item = this.item(id);
    if (!item.dispatch || item.state !== "open") throw new RuleError("not_dispatched", `${id} is not waiting for a runner`);
    this.sql.exec(`UPDATE items SET dispatch = NULL, updated_at = ? WHERE id = ?`, new Date().toISOString(), id);
    this.log(id, actor, "item.undispatched", {});
    return this.item(id);
  }

  // Open tasks waiting for a runner, oldest dispatch first. Not named queue():
  // that is a reserved handler name, which Durable Object RPC will not call.
  waiting(): Item[] {
    return this.items()
      .filter((i) => i.state === "open" && !i.owner && i.dispatch)
      .sort((a, b) => a.dispatch!.at.localeCompare(b.dispatch!.at));
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
  // An accepted task can still take a new revision, as when its merge
  // conflicts and the owner rebases: the push withdraws the acceptance, and
  // the task is back in progress until it is checked and submitted again.
  recordPush(id: string, actor: string, observedHead: string, reportedHead: string | null): Item {
    const item = this.item(id);
    if (item.state !== "accepted") assertLive(item);
    assertOwner(item, actor);
    const landing = this.landing(id);
    if (item.state === "accepted" && landing && item.head !== observedHead) {
      throw new RuleError("landing", `${id} is being merged at ${landing.slice(0, 8)}; push again once it has landed`, 409);
    }
    if (item.head === observedHead) return item;
    const now = new Date().toISOString();
    const reopened = item.state === "accepted";
    this.update(id, {
      head: observedHead, last_push_at: now,
      state: item.state === "submitted" ? "submitted" : "claimed",
      ...(reopened ? { accepted_head: null } : {}),
    });
    this.log(id, actor, "push.observed", {
      head: observedHead,
      ...(reportedHead && reportedHead !== observedHead ? { reportedHead, mismatch: true } : {}),
      ...(reopened ? { approvalInvalidated: true } : {}),
    });
    return this.item(id);
  }

  observePush(id: string, observedHead: string, expectedHead: string | null): Item {
    const item = this.item(id);
    if (item.state === "merged" || item.state === "abandoned" || item.head !== expectedHead || item.head === observedHead) return item;
    // While the accepted revision is landing, a push to the fork does not
    // change what is merged; it is left for after the merge.
    if (item.state === "accepted" && this.landing(id)) return item;
    const now = new Date().toISOString();
    this.update(id, { head: observedHead, accepted_head: null, last_push_at: now,
      state: item.state === "accepted" ? "submitted" : item.state });
    this.log(id, "atelier/events", "push.observed", { head: observedHead, source: "artifacts", approvalInvalidated: item.state === "accepted" });
    return this.item(id);
  }

  // Cloud checks arrive without an HTTP request, so retain the initiating origin.
  setNotificationOrigin(id: string, origin: string): void {
    this.item(id);
    this.sql.exec(`INSERT OR REPLACE INTO notification_origins (item_id, origin) VALUES (?, ?)`, id, new URL(origin).origin);
  }

  private notify(id: string, origin?: string): void {
    try {
      if (origin) this.setNotificationOrigin(id, origin);
      const topic = (this.env as Env & { NTFY_TOPIC?: string }).NTFY_TOPIC;
      if (!topic) return;
      const item = this.item(id);
      if (item.state !== "submitted" || !item.head || !this.inbox(new Date().toISOString()).some((e) => e.itemId === id)) return;
      const saved = this.sql.exec(`SELECT origin FROM notification_origins WHERE item_id = ?`, id).toArray()[0];
      if (!saved) return;
      const request = notificationRequest(topic, saved.origin as string, this.project().name, this.detail(id));
      // Reserve before network I/O. A failed attempt is not retried at this head.
      const claimed = this.sql.exec(`INSERT OR IGNORE INTO notifications (item_id, head) VALUES (?, ?) RETURNING item_id`, id, item.head).toArray();
      if (!claimed.length) return;
      this.ctx.waitUntil((async () => {
        try {
          const response = await fetch(request, { redirect: "error", signal: AbortSignal.timeout(10_000) });
          if (!response.ok) console.error("Atelier notification failed", response.status);
          await response.body?.cancel();
        } catch {
          console.error("Atelier notification failed");
        }
      })());
    } catch {
      console.error("Atelier notification could not be scheduled");
    }
  }

  addEvidence(e: Evidence, origin?: string): void {
    const item = this.item(e.itemId);
    if (e.head !== item.head) {
      throw new RuleError("stale_head", `evidence is for ${e.head.slice(0, 8)} but the item is at ${item.head?.slice(0, 8) ?? "nothing"}; push first`);
    }
    this.sql.exec(`INSERT INTO evidence (item_id, json) VALUES (?, ?)`, e.itemId, JSON.stringify(e));
    this.log(e.itemId, e.by, `evidence.${e.grade}`, { claim: e.claim, passed: e.passed, head: e.head, ...(e.where ? { where: e.where } : {}) });
    if (e.grade === "observed") this.notify(e.itemId, origin);
  }

  addReview(r: Review, origin?: string): void {
    if (!validActor(r.by)) throw new RuleError("bad_actor", `"${r.by}" is not harness/model`, 400);
    // Under a role policy any agent may record a review, and the gate counts
    // only an assessor's; the executor role is for taking work, not reviewing.
    const policy = this.project().policy;
    if (!policy.agents) assertEligible(r.by, policy, this.owner);
    const item = this.item(r.itemId);
    if (item.state !== "accepted") assertLive(item);
    else if (this.landing(item.id)) throw new RuleError("landing", "cancel the interrupted landing before reviewing again");
    if (item.owner === r.by) throw new RuleError("self_review", "an owner cannot review their own item", 403);
    if (r.head !== item.head) throw new RuleError("stale_head", "review is for an older head", 409);
    this.sql.exec(`INSERT INTO reviews (item_id, json) VALUES (?, ?)`, r.itemId, JSON.stringify(r));
    // A new review of accepted work requires another acceptance.
    if (item.state === "accepted") this.update(item.id, { state: "submitted", accepted_head: null });
    this.log(r.itemId, r.by, r.approve ? "review.approved" : "review.rejected", { note: r.note, head: r.head });
    this.notify(r.itemId, origin);
  }

  // The summary is recorded in the event and nowhere else; a later submit
  // without one leaves the new revision with none.
  submit(id: string, actor: string, summary?: string, origin?: string): Item {
    const item = this.item(id);
    assertLive(item);
    assertOwner(item, actor);
    if (!item.head || item.head === item.base) throw new RuleError("nothing_pushed", "push work before submitting");
    this.update(id, { state: "submitted" });
    const text = cleanSummary(summary);
    this.log(id, actor, "item.submitted", { head: item.head, ...(text ? { summary: text } : {}) });
    this.notify(id, origin);
    return this.item(id);
  }

  // Ownership moves; the work does not fork. The new owner inherits the same
  // workspace repo, and the old owner's write token is revoked by the caller.
  handoff(id: string, from: string, to: string, note: string): Item {
    const item = this.item(id);
    if (from !== this.owner) assertOwner(item, from);
    if (!validActor(to)) throw new RuleError("bad_actor", `"${to}" is not harness/model`, 400);
    assertEligible(to, this.project().policy, this.owner);
    if (item.state !== "claimed" && item.state !== "submitted") throw new RuleError("closed", `${id} is ${item.state}`);
    this.update(id, { owner: to, state: "claimed" });
    this.log(id, from, "item.handoff", { from: item.owner, to, note });
    return this.item(id);
  }

  release(id: string, actor: string, note: string): Item {
    const item = this.item(id);
    assertLive(item);
    if (actor !== this.owner) assertOwner(item, actor);
    this.update(id, { owner: null, state: "open" });
    this.log(id, actor, "item.released", { from: item.owner, note });
    return this.item(id);
  }

  accept(id: string, actor: string, expected?: string): Item {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner accepts", 403);
    const item = this.item(id);
    if (expected !== undefined) assertRevision(item, expected);
    const policy = this.project().policy;
    const g = gate(item.state === "accepted" ? { ...item, state: "submitted" } : item, policy, this.evidenceFor(id), this.reviewsFor(id), this.owner);
    if (!g.ready) throw new RuleError("not_ready", `not ready: ${g.blockers.join("; ")}`);
    this.update(id, { state: "accepted", accepted_head: item.head });
    this.log(id, actor, "item.accepted", { head: item.head, protected: [...policy.protected] });
    return this.item(id);
  }

  // A merge lands the accepted revision under a lease: while it is held,
  // the task's owner cannot push a new revision over the one being merged.
  // It has no expiry, because a merge may have published the revision even
  // if it never recorded it. Recording the merge ends it; the project owner
  // can cancel it only while the merge is not on the baseline (see the
  // landing route), and running the merge again resumes it.
  private landing(id: string): string | null {
    const row = this.sql.exec(`SELECT value FROM meta WHERE key = ?`, `landing:${id}`).toArray()[0];
    return row ? (JSON.parse(row.value as string) as { head: string }).head : null;
  }

  cancelLanding(id: string, actor: string): Item {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner merges", 403);
    this.sql.exec(`DELETE FROM meta WHERE key = ?`, `landing:${id}`);
    return this.item(id);
  }

  beginLanding(id: string, actor: string, head: string): Item {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner merges", 403);
    const item = this.item(id);
    if (item.state !== "accepted" || item.acceptedHead !== head) {
      throw new RuleError("acceptance_changed", `${id} is no longer accepted at ${head.slice(0, 8)}; review it again before merging`, 409);
    }
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, `landing:${id}`, JSON.stringify({ head, at: Date.now() }));
    return item;
  }

  merged(id: string, actor: string, mergeCommit: string, observed: boolean, acceptedHead?: string | null): Item {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner merges", 403);
    const item = this.item(id);
    if (item.state === "merged" && this.events(id).some((e) => e.kind === "item.merged" && e.data.mergeCommit === mergeCommit)) return item;
    if (!observed) throw new RuleError("unverified_merge", "merge commit is not on the baseline");
    if (item.state !== "accepted") throw new RuleError("not_accepted", `${id} is ${item.state}`);
    // The merge commit was verified against one accepted revision; if the
    // acceptance has moved since, this record would name the wrong one.
    if (acceptedHead !== undefined && item.acceptedHead !== acceptedHead) {
      throw new RuleError("acceptance_changed", `${id} was accepted again at another revision while this merge was checked; merge again`, 409);
    }
    this.sql.exec(`DELETE FROM meta WHERE key = ?`, `landing:${id}`);
    this.update(id, { state: "merged", owner: null });
    this.log(id, actor, "item.merged", { mergeCommit, head: item.acceptedHead, observedOnBaseline: observed });
    return this.item(id);
  }

  abandon(id: string, actor: string, note: string): Item {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner abandons", 403);
    const item = this.item(id);
    if (item.state === "merged" || item.state === "abandoned") throw new RuleError("closed", `${id} is ${item.state}`);
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

  // Who holds what, without titles, scopes or paths: safe to hand to a
  // metadata consumer such as ControlPlane's Observatory publication.
  owners() {
    return this.items()
      .filter((i) => i.state === "claimed" || i.state === "submitted" || i.state === "accepted")
      .map((i) => ({ item: i.id, state: i.state, owner: i.owner, head: i.head, since: i.updatedAt }));
  }

  detail(id: string) {
    const item = this.item(id);
    const policy = this.project().policy;
    const evidence = this.evidenceFor(id);
    const reviews = this.reviewsFor(id);
    // Read acceptance separately so later events cannot hide its snapshot.
    const row = this.sql.exec(`SELECT data FROM events WHERE item_id = ? AND kind = 'item.accepted' ORDER BY seq DESC LIMIT 1`, id).toArray()[0];
    const acceptance = row ? JSON.parse(row.data as string) : null;
    const acceptanceProtected: string[] | null = acceptance?.head === item.acceptedHead ? acceptance.protected ?? null : null;
    return { item, policy, acceptanceProtected, evidence, reviews, ownerActor: this.owner, gate: gate(item, policy, evidence, reviews, this.owner), events: this.events(id) };
  }

  inbox(now: string): InboxEntry[] {
    const p = this.project();
    const all = this.sql.exec(`SELECT json FROM evidence`).toArray().map((r) => JSON.parse(r.json as string));
    const rv = this.sql.exec(`SELECT json FROM reviews`).toArray().map((r) => JSON.parse(r.json as string));
    return inboxFor(p.name, this.items(), p.policy, all, rv, new Date(now), this.owner);
  }

  private update(id: string, fields: Record<string, string | null>): void {
    // A change of owner always ends the previous holder's runner.
    if ("owner" in fields && !("runner" in fields)) fields = { ...fields, runner: null };
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
    dispatch: r.dispatch ? (JSON.parse(r.dispatch as string) as Dispatch) : null,
    runner: (r.runner as string | null) ?? null,
  };
}
