import { cleanSession, type SessionNote } from "./sessions.ts";
import { type AgentToken } from "./tokens.ts";
import { OBSERVED_UNDER, type ModelEntry, type ModelStatus } from "./models/pool";
import { DurableObject } from "cloudflare:workers";
import {
  assertHandoffTarget, assertReviewAllowed, pushActors,
  assertClaimAllowed, assertEligible, assertOwner, assertRevision, assertLive, DEFAULT_OWNER, gate, inboxFor, reviewOverrideFor, RuleError, sameActor, validActor,
  type Evidence, type InboxEntry, type Item, type ItemState, type ProjectPolicy, type Review, type ReviewOverride,
} from "./rules";
import { cleanSummary } from "./brief";
import { notificationRequest, usageAlertRequest } from "./notify.ts";
import { assertDispatchable, assertDispatchedClaim, makeDispatch, type Dispatch, type RunnerKind } from "./dispatch/rules";
import { crossings, type Thresholds, type UsageReport } from "./usage/report.ts";

// One Ledger per project holds its items, evidence, reviews and an append-only
// event log. A Durable Object runs one request at a time, so "exactly one owner"
// is enforced by construction: two agents claiming the same item are serialised
// and the second is refused. The instance named "__index" also lists projects.

export interface LedgerEvent {
  seq: number;
  proved?: true;
  itemId: string | null;
  at: string;
  actor: string;
  kind: string;
  data: Record<string, unknown>;
}

export interface ProjectRecord {
  revision?: number;      // one more on every init; the index keeps the newest copy
  name: string;           // links, commands, and storage until the project is renamed
  title?: string;         // what people read; the name when absent
  repo: string;
  // The branch init registered: the checkout's branch, which init also made
  // the baseline's default branch. Every fork copies the baseline's HEAD, so
  // this is the branch a task's workspace pushes to and Atelier reads.
  // Absent when no init has named one; the baseline's info stands in then.
  branch?: string;
  policy: ProjectPolicy;
  createdAt: string;
  // The two below are set by the index on the records it lists, never stored.
  key?: string;           // where the ledger and repositories live, when that is not the name
  formerly?: string[];    // names the project answered to before; each still resolves to it
}

// What a requested project name resolves to: the name the project is
// registered under (the requested name itself when nothing is registered),
// the key its ledger and repositories live under, and every name that
// reaches that key. `former` says the request used a name the project no
// longer has, so a page can redirect and an API answer can say the new name.
export interface ProjectRef {
  name: string;
  key: string;
  names: string[];
  registered: boolean;
  former: boolean;
}

type Row = Record<string, SqlStorageValue>;

// What an init asks for. A field present replaces the project's current
// value; a field absent keeps it. `reset` starts from the defaults, as a
// first init does. `title: null` clears the title.
export interface ProjectInit {
  name: string;
  repo: string;
  reset: boolean;
  branch?: string;
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

// What the Worker found in a fork's history for a push (see recordPush):
// whether the head it sees holds the head recorded before it, and the head
// the caller says `atelier update` rebased from, or null when it said nothing.
// What the Worker found in a fork's history for a push. holdsRecorded is
// null when its search stopped at its budget before finding the recorded
// head or reaching the end of the history; searched is how many commits it
// examined by then.
export interface PushLineage { holdsRecorded: boolean | null; searched?: number; rebasedFrom: string | null }

// `reset` starts the policy over; the project's identity (its title, when the
// init does not name one, its branch, and when it was created) is kept either way.
export function mergeProject(current: ProjectRecord | null, i: ProjectInit, at: string): ProjectRecord {
  const p = i.reset ? undefined : current?.policy;
  const title = i.title === undefined ? current?.title : i.title ?? undefined;
  const approval = i.approval === undefined ? p?.approval : i.approval ?? undefined;
  const branch = i.branch ?? current?.branch;
  return {
    revision: (current?.revision ?? 0) + 1,
    name: i.name,
    ...(title ? { title } : {}),
    repo: i.repo,
    ...(branch ? { branch } : {}),
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

// A project may take a name that reaches no other project's storage: not one
// a project is registered under, and not one a project was called before,
// whether that project is still registered or only retained.
export function assertNameFree(source: ProjectRef, to: string, target: ProjectRef): void {
  if (target.key === source.key) return;
  if (target.registered) {
    throw new RuleError("name_taken", `${to} is ${target.name === to ? "the name" : "a former name"} of ${target.name}, which still answers to it`, 409);
  }
  if (target.key !== to) throw new RuleError("name_taken", `${to} was a name of a removed project, stored under ${target.key}, which still answers to it`, 409);
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
      CREATE TABLE IF NOT EXISTS names (name TEXT PRIMARY KEY, key TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_tokens (id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS models (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage (tool TEXT NOT NULL, runner TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (tool, runner));
      CREATE TABLE IF NOT EXISTS usage_alerts (key TEXT PRIMARY KEY, tool TEXT NOT NULL, runner TEXT NOT NULL, since TEXT NOT NULL);
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
    const eventColumns = this.sql.exec(`PRAGMA table_info(events)`).toArray().map((c) => c.name);
    if (!eventColumns.includes("proved")) this.sql.exec(`ALTER TABLE events ADD COLUMN proved INTEGER`);
    // Added after the first deploy; existing ledgers gain the column once.
    const columns = this.sql.exec(`PRAGMA table_info(items)`).toArray().map((c) => c.name);
    if (!columns.includes("dispatch")) this.sql.exec(`ALTER TABLE items ADD COLUMN dispatch TEXT`);
    if (!columns.includes("runner")) this.sql.exec(`ALTER TABLE items ADD COLUMN runner TEXT`);
    if (!columns.includes("review_override")) this.sql.exec(`ALTER TABLE items ADD COLUMN review_override TEXT`);
  }

  // ── index instance ───────────────────────────────────────────────────────

  putAgentToken(token: AgentToken): void {
    this.sql.exec(`INSERT INTO agent_tokens (id, hash, json) VALUES (?, ?, ?)`, token.id, token.hash, JSON.stringify(token));
    this.log(null, this.owner, "token.issued", { id: token.id, actor: token.actor, projects: token.projects ?? null, expiresAt: token.expiresAt });
  }

  agentToken(hash: string): AgentToken | null {
    const row = this.sql.exec(`SELECT json FROM agent_tokens WHERE hash = ?`, hash).toArray()[0];
    return row ? JSON.parse(row.json as string) : null;
  }

  agentTokens(): Omit<AgentToken, "hash">[] {
    return this.sql.exec(`SELECT json FROM agent_tokens ORDER BY id`).toArray().map((row) => {
      const { hash, ...record } = JSON.parse(row.json as string) as AgentToken;
      return record;
    });
  }

  revokeAgentToken(id: string): boolean {
    const row = this.sql.exec(`SELECT json FROM agent_tokens WHERE id = ?`, id).toArray()[0];
    if (!row) return false;
    const token = JSON.parse(row.json as string) as AgentToken;
    if (token.revokedAt) return true;
    token.revokedAt = new Date().toISOString();
    this.sql.exec(`UPDATE agent_tokens SET json = ? WHERE id = ?`, JSON.stringify(token), id);
    this.log(null, this.owner, "token.revoked", { id: token.id, actor: token.actor, projects: token.projects ?? null, expiresAt: token.expiresAt });
    return true;
  }

  // Two inits finishing out of order must not leave the older copy listed.
  // What the index adds to a listed record (key, formerly) is read from the
  // names table each time, so it is left out of the stored copy.
  registerProject(record: ProjectRecord): void {
    this.assertRepoAvailable(record.name, record.repo);
    const row = this.sql.exec(`SELECT json FROM projects WHERE name = ?`, record.name).toArray()[0];
    const held = row ? (JSON.parse(row.json as string) as ProjectRecord).revision ?? 0 : -1;
    if ((record.revision ?? 0) < held) return;
    const { key: _key, formerly: _formerly, ...stored } = record;
    this.sql.exec(`INSERT OR REPLACE INTO projects (name, json) VALUES (?, ?)`, record.name, JSON.stringify(stored));
  }

  assertRepoAvailable(name: string, repo: string): void {
    assertRepoAvailable(this.projects(), name, repo);
  }

  // The names table is kept: the ledger is retained too, and a later init
  // under any of the project's names finds it again.
  removeProject(name: string): boolean {
    return this.sql.exec(`DELETE FROM projects WHERE name = ?`, name).rowsWritten > 0;
  }

  projects(): ProjectRecord[] {
    return this.sql.exec(`SELECT json FROM projects ORDER BY name`).toArray().map((r) => this.listed(JSON.parse(r.json as string)));
  }

  // ── names ────────────────────────────────────────────────────────────────
  // A project's ledger is the Durable Object named after it, and its
  // repositories are named after it too; neither can be renamed. So a renamed
  // project keeps its storage under the name it was created with, its key,
  // and the names table maps each name it has been given since to that key.
  // A name with no row is its own key. Which of a key's names is current is
  // whichever is registered, so renaming back needs no special case, and
  // every former name resolves in one step.

  private keyOf(name: string): string {
    const row = this.sql.exec(`SELECT key FROM names WHERE name = ?`, name).toArray()[0];
    return row ? (row.key as string) : name;
  }

  private namesOf(key: string): string[] {
    return [key, ...this.sql.exec(`SELECT name FROM names WHERE key = ? ORDER BY name`, key).toArray().map((r) => r.name as string)];
  }

  private listed(record: ProjectRecord): ProjectRecord {
    const key = this.keyOf(record.name);
    const formerly = this.namesOf(key).filter((n) => n !== record.name);
    return { ...record, ...(key !== record.name ? { key } : {}), ...(formerly.length ? { formerly } : {}) };
  }

  resolveProject(name: string): ProjectRef {
    const key = this.keyOf(name);
    const registered = this.sql.exec(`SELECT name FROM projects`).toArray().map((r) => r.name as string).find((n) => this.keyOf(n) === key);
    return { name: registered ?? name, key, names: this.namesOf(key), registered: registered !== undefined, former: registered !== undefined && registered !== name };
  }

  // The project registered as `from`, or that `from` was a name of, answers
  // to `to` from now on. Its storage stays under its key, and its former
  // names keep resolving to it, so renaming back is the same operation. A
  // name that reaches another project's key is refused: one registered under
  // it or that had it before.
  renameProject(from: string, to: string): { from: string; to: string; key: string; names: string[] } {
    const source = this.resolveProject(from);
    if (!source.registered) throw new RuleError("no_project", `no project ${from}`, 404);
    if (source.name === to) throw new RuleError("same_name", `${to} is already the project's name`, 400);
    assertNameFree(source, to, this.resolveProject(to));
    const row = this.sql.exec(`SELECT json FROM projects WHERE name = ?`, source.name).toArray()[0];
    const record = { ...(JSON.parse(row.json as string) as ProjectRecord), name: to };
    this.sql.exec(`DELETE FROM projects WHERE name = ?`, source.name);
    this.sql.exec(`INSERT INTO projects (name, json) VALUES (?, ?)`, to, JSON.stringify(record));
    if (to !== source.key) this.sql.exec(`INSERT OR REPLACE INTO names (name, key) VALUES (?, ?)`, to, source.key);
    this.log(null, this.owner, "project.renamed", { from: source.name, to, key: source.key });
    return { from: source.name, to, key: source.key, names: this.namesOf(source.key) };
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

  // ── usage ────────────────────────────────────────────────────────────────
  // Each tool's usage, limits and balances as a home runner last reported
  // them, on the index instance beside the model pool: one report per tool
  // and runner, replaced by the next from the same runner.

  usage(): UsageReport[] {
    return this.sql.exec(`SELECT json FROM usage ORDER BY tool, runner`).toArray().map((r) => JSON.parse(r.json as string));
  }

  // The alerts in force: each crossing that has been alerted and not yet cleared.
  usageAlerts(): { key: string; since: string }[] {
    return this.sql.exec(`SELECT key, since FROM usage_alerts ORDER BY since, key`).toArray().map((r) => ({ key: r.key as string, since: r.since as string }));
  }

  // Stores the report, then alerts once per crossing: a figure past its
  // threshold is recorded under its key the first time a report shows it,
  // and that key is dropped when a later report from the same runner shows
  // it back under, so the next crossing alerts again. The alert goes through
  // the notification topic when there is one; the crossing is recorded
  // either way, and the keys alerted now come back to the caller.
  putUsage(report: UsageReport, thresholds: Thresholds, origin: string): { report: UsageReport; alerts: string[] } {
    this.sql.exec(`INSERT OR REPLACE INTO usage (tool, runner, json) VALUES (?, ?, ?)`, report.tool, report.runner, JSON.stringify(report));
    const active = crossings(report, thresholds, Date.parse(report.at));
    const held = new Set(this.sql.exec(`SELECT key FROM usage_alerts WHERE tool = ? AND runner = ?`, report.tool, report.runner).toArray().map((r) => r.key as string));
    const topic = (this.env as Env & { NTFY_TOPIC?: string }).NTFY_TOPIC;
    const alerts: string[] = [];
    for (const c of active) {
      if (held.has(c.key)) continue;
      this.sql.exec(`INSERT INTO usage_alerts (key, tool, runner, since) VALUES (?, ?, ?, ?)`, c.key, report.tool, report.runner, report.at);
      this.log(null, this.owner, "usage.alert", { key: c.key, runner: report.runner, title: c.title });
      alerts.push(c.title);
      if (topic) this.deliver(usageAlertRequest(topic, origin, c.title, c.body));
    }
    const keys = new Set(active.map((c) => c.key));
    for (const key of held) {
      if (keys.has(key)) continue;
      this.sql.exec(`DELETE FROM usage_alerts WHERE key = ?`, key);
      this.log(null, this.owner, "usage.cleared", { key, runner: report.runner });
    }
    return { report, alerts };
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

  // The record's name follows a rename decided at the index: links and
  // commands on the project's pages, inbox entries and notifications read it.
  setName(to: string, actor: string): ProjectRecord {
    const current = this.project();
    if (current.name === to) return current;
    const record = { ...current, name: to };
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('project', ?)`, JSON.stringify(record));
    this.log(null, actor, "project.renamed", { from: current.name, to });
    return record;
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
    const events = this.sql.exec(`SELECT actor, kind, data FROM events WHERE item_id = ? AND kind IN ('item.claimed', 'item.handoff', 'item.released', 'push.observed') ORDER BY seq`, id).toArray();
    return { ...toItem(row), pushActors: pushActors(events.map((r) => ({ actor: r.actor as string, kind: r.kind as string, data: JSON.parse(r.data as string) }))) };
  }

  items(): Item[] {
    const events = this.sql.exec(`SELECT item_id, actor, kind, data FROM events WHERE kind IN ('item.claimed', 'item.handoff', 'item.released', 'push.observed') ORDER BY seq`).toArray();
    const histories = new Map<string, Parameters<typeof pushActors>[0]>();
    for (const row of events) {
      const id = row.item_id as string;
      const history = histories.get(id) ?? [];
      history.push({ actor: row.actor as string, kind: row.kind as string, data: JSON.parse(row.data as string) });
      histories.set(id, history);
    }
    return this.sql.exec(`SELECT * FROM items ORDER BY CAST(SUBSTR(id, 2) AS INTEGER)`).toArray()
      .map((row) => ({ ...toItem(row), pushActors: pushActors(histories.get(row.id as string) ?? []) }));
  }

  tokenId(id: string): string | null {
    const row = this.sql.exec(`SELECT token_id FROM items WHERE id = ?`, id).toArray()[0];
    return (row?.token_id as string | null) ?? null;
  }

  claim(id: string, actor: string, runner: { runner: string; kind: RunnerKind } | null = null, proved = false): { item: Item; needsFork: boolean } {
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
    this.log(id, actor, "item.claimed", runner ? { runner: runner.runner } : {}, proved);
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
  unclaim(id: string, actor: string, reason: string, proved = false): void {
    this.update(id, { owner: null, state: "open" });
    this.log(id, actor, "item.claim_failed", { reason }, proved);
  }

  setFork(id: string, fork: string, base: string | null, actor: string, proved = false): void {
    this.update(id, { fork, base, head: base });
    this.log(id, actor, "fork.created", { fork, base }, proved);
  }

  setToken(id: string, tokenId: string | null): void {
    this.sql.exec(`UPDATE items SET token_id = ? WHERE id = ?`, tokenId, id);
  }

  // The worker has already read the fork's head from Artifacts; what is logged
  // here is what Atelier saw, not what the agent said it pushed.
  // An accepted task can still take a new revision, as when its merge
  // conflicts and the owner rebases: the push withdraws the acceptance, and
  // the task is back in progress until it is checked and submitted again.
  //
  // A head that does not hold the recorded one has rewritten the fork's
  // history: the commits recorded before it are off the branch. That is
  // what `atelier update` does on purpose, rebasing every commit the fork
  // held onto the moved baseline, and `atelier push --force` then declares
  // the head it rebased from, after checking with git that each of those
  // commits survives by patch. The Ledger has no repository to repeat that
  // check in; what it can hold the caller to is the declaration naming the
  // recorded head, the same lease the git push was made under, so a
  // workspace that rebased from any other head, or declared nothing, is
  // refused and the recorded head stays. The declared rewrite is recorded
  // with the head it replaced, so the item's history shows both. `lineage`
  // is what the Worker found in the fork; a caller that has not looked
  // (the Ledger's own tests, which run without a repository) passes nothing
  // and is trusted.
  //
  // A search that stopped at its budget before finding the recorded head
  // has shown neither a rewrite nor a head that holds it. Such a push is
  // refused under its own code, so the caller can tell it from a rewrite,
  // unless it declares the rebase; the declaration is then taken as it
  // would be for a rewrite, and the record says the Worker could not
  // confirm it. Refusing is the safer side: a head that drops recorded
  // commits in a history too deep to read through is never recorded
  // undeclared, while a head that holds the recorded one has it a few
  // commits back on a chain the search reads first, well within the budget.
  recordPush(id: string, actor: string, observedHead: string, reportedHead: string | null, proved = false, lineage: PushLineage = { holdsRecorded: true, rebasedFrom: null }): Item {
    const item = this.item(id);
    if (item.state !== "accepted") assertLive(item);
    assertOwner(item, actor);
    const landing = this.landing(id);
    if (item.state === "accepted" && landing && item.head !== observedHead) {
      throw new RuleError("landing", `${id} is being merged at ${landing.slice(0, 8)}; push again once it has landed`, 409);
    }
    if (item.head === observedHead) return item;
    const rewritten = !!item.head && !lineage.holdsRecorded;
    const unverified = rewritten && lineage.holdsRecorded === null;
    if (rewritten && lineage.rebasedFrom !== item.head) {
      if (unverified) {
        throw new RuleError("ancestry_unverified", `${id}'s workspace is at ${observedHead.slice(0, 8)}, and Atelier could not verify ancestry within ${lineage.searched ?? 0} commits of the fork's history: ${item.head!.slice(0, 8)}, the head it recorded, is not among them, and the rest was not read. The recorded head stays. If atelier update rebased this workspace, push with atelier push --force, which declares the rebase`, 409);
      }
      throw new RuleError("history_rewritten", `${id}'s workspace is at ${observedHead.slice(0, 8)}, which does not hold ${item.head!.slice(0, 8)}, the head Atelier recorded: the commits pushed before are no longer on its branch. Put them back under your commits (git fetch origin, then rebase or merge), then push again; after atelier update, push with atelier push --force`, 409);
    }
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
      ...(rewritten ? { rebasedFrom: item.head } : {}),
      ...(unverified ? { unverified: true } : {}),
      ...(reopened ? { approvalInvalidated: true } : {}),
    }, proved);
    return this.item(id);
  }

  // A push seen on the fork whose head does not hold the recorded one came
  // from outside `atelier push`: a raw force push, or the git half of an
  // `atelier push --force` whose declaration has not arrived yet. The head
  // stays where it was, and the event names both commits, so the owner sees
  // that the branch no longer holds what was recorded and nothing is lost
  // unnoticed; the CLI's own call then records the push, or is refused. A
  // head the Worker could not place either way (holdsRecorded null, its
  // search having stopped at its budget) is left the same way, with the
  // reason saying so. The queue delivers an event at least once, so the
  // same sighting is noted once.
  observePush(id: string, observedHead: string, expectedHead: string | null, holdsRecorded: boolean | null = true): Item {
    const item = this.item(id);
    if (item.state === "merged" || item.state === "abandoned" || item.head !== expectedHead || item.head === observedHead) return item;
    // While the accepted revision is landing, a push to the fork does not
    // change what is merged; it is left for after the merge.
    if (item.state === "accepted" && this.landing(id)) return item;
    if (item.head && !holdsRecorded) {
      const last = this.sql.exec(`SELECT data FROM events WHERE item_id = ? AND kind = 'push.unrecorded' ORDER BY seq DESC LIMIT 1`, id).toArray()[0];
      const noted = last ? (JSON.parse(last.data as string) as { head?: string; recorded?: string }) : null;
      if (noted?.head !== observedHead || noted.recorded !== item.head) {
        this.log(id, "atelier/events", "push.unrecorded", { head: observedHead, recorded: item.head, source: "artifacts", reason: holdsRecorded === null ? "ancestry_unverified" : "history_rewritten" });
      }
      return item;
    }
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
      this.deliver(request);
    } catch {
      console.error("Atelier notification could not be scheduled");
    }
  }

  // Delivery runs in the background: a failure is logged without the
  // response body or the topic, and nothing is retried.
  private deliver(request: Request): void {
    this.ctx.waitUntil((async () => {
      try {
        const response = await fetch(request, { redirect: "error", signal: AbortSignal.timeout(10_000) });
        if (!response.ok) console.error("Atelier notification failed", response.status);
        await response.body?.cancel();
      } catch {
        console.error("Atelier notification failed");
      }
    })());
  }

  recordSandboxRequest(id: string, actor: string, runId: string): void {
    this.item(id);
    this.log(id, actor, "sandbox.requested", { runId }, true);
  }

  addEvidence(e: Evidence, origin?: string, proved = false): void {
    const item = this.item(e.itemId);
    if (e.head !== item.head) {
      throw new RuleError("stale_head", `evidence is for ${e.head.slice(0, 8)} but the item is at ${item.head?.slice(0, 8) ?? "nothing"}; push first`);
    }
    this.sql.exec(`INSERT INTO evidence (item_id, json) VALUES (?, ?)`, e.itemId, JSON.stringify(e));
    this.log(e.itemId, e.by, `evidence.${e.grade}`, { claim: e.claim, passed: e.passed, head: e.head, ...(e.where ? { where: e.where } : {}) }, proved);
    if (e.grade === "observed") this.notify(e.itemId, origin);
  }

  addReview(r: Review, origin?: string, proved = false): void {
    if (!validActor(r.by)) throw new RuleError("bad_actor", `"${r.by}" is not harness/model`, 400);
    // Under a role policy any agent may record a review, and the gate counts
    // only an assessor's; the executor role is for taking work, not reviewing.
    const policy = this.project().policy;
    if (!policy.agents) assertEligible(r.by, policy, this.owner);
    const item = this.item(r.itemId);
    assertReviewAllowed(item, proved);
    if (item.state !== "accepted") assertLive(item);
    else if (this.landing(item.id)) throw new RuleError("landing", "cancel the interrupted landing before reviewing again");
    // The holder under another letter case, profile or registered name is still the holder.
    if (item.owner && sameActor(item.owner, r.by)) throw new RuleError("self_review", "an owner cannot review their own item", 403);
    if (r.head !== item.head) throw new RuleError("stale_head", "review is for an older head", 409);
    this.sql.exec(`INSERT INTO reviews (item_id, json) VALUES (?, ?)`, r.itemId, JSON.stringify(r));
    // A new review of accepted work requires another acceptance.
    if (item.state === "accepted") this.update(item.id, { state: "submitted", accepted_head: null });
    this.log(r.itemId, r.by, r.approve ? "review.approved" : "review.rejected", { note: r.note, head: r.head }, proved);
    this.notify(r.itemId, origin);
  }

  // The summary is recorded in the event and nowhere else; a later submit
  // without one leaves the new revision with none.
  submit(id: string, actor: string, summary?: string, origin?: string, proved = false): Item {
    const item = this.item(id);
    assertLive(item);
    assertOwner(item, actor);
    if (!item.head || item.head === item.base) throw new RuleError("nothing_pushed", "push work before submitting");
    this.update(id, { state: "submitted" });
    const text = cleanSummary(summary);
    this.log(id, actor, "item.submitted", { head: item.head, ...(text ? { summary: text } : {}) }, proved);
    this.notify(id, origin);
    return this.item(id);
  }

  // Ownership moves; the work does not fork. The new owner inherits the same
  // workspace repo, and the old owner's write token is revoked by the caller.
  handoff(id: string, from: string, to: string, note: string, proved = false): Item {
    const item = this.item(id);
    if (from !== this.owner) assertOwner(item, from);
    assertHandoffTarget(to, this.owner);
    assertEligible(to, this.project().policy, this.owner);
    if (item.state !== "claimed" && item.state !== "submitted") throw new RuleError("closed", `${id} is ${item.state}`);
    this.update(id, { owner: to, state: "claimed" });
    this.log(id, from, "item.handoff", { from: item.owner, to, note }, proved);
    return this.item(id);
  }

  release(id: string, actor: string, note: string, proved = false): Item {
    const item = this.item(id);
    assertLive(item);
    if (actor !== this.owner) assertOwner(item, actor);
    this.update(id, { owner: null, state: "open" });
    this.log(id, actor, "item.released", { from: item.owner, note }, proved);
    return this.item(id);
  }

  // The owner accepts the item at its head, through the gate. With a reason
  // (overrideReason), the owner also overrides the independent review the
  // gate is missing, for when no reviewer qualifies: the override is checked
  // and the gate read with it in place before anything is written, then it
  // is stored on the item for this head and logged as review.overridden, an
  // event of its own, ahead of item.accepted. It waives that review and
  // nothing else: a failing or pending check, a rejection or a disallowed
  // class still refuses the acceptance, and so nothing is recorded.
  accept(id: string, actor: string, expected?: string, overrideReason?: string): Item {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner accepts", 403);
    const item = this.item(id);
    if (expected !== undefined) assertRevision(item, expected);
    const policy = this.project().policy;
    const evidence = this.evidenceFor(id), reviews = this.reviewsFor(id);
    const current: Item = item.state === "accepted" ? { ...item, state: "submitted" } : item;
    const override = overrideReason === undefined ? null
      : reviewOverrideFor(current, policy, evidence, reviews, this.owner, overrideReason, new Date().toISOString());
    const g = gate(override ? { ...current, reviewOverride: override.override } : current, policy, evidence, reviews, this.owner);
    if (!g.ready) throw new RuleError("not_ready", `not ready: ${g.blockers.join("; ")}`);
    if (override) {
      this.update(id, { review_override: JSON.stringify(override.override) });
      this.log(id, actor, "review.overridden", { head: item.head, reason: override.override.reason, waived: override.waived, contributors: override.contributors });
    }
    this.update(id, { state: "accepted", accepted_head: item.head });
    this.log(id, actor, "item.accepted", { head: item.head, protected: [...policy.protected], ...(override ? { reviewOverridden: true } : {}) });
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

  wrapSession(value: Record<string, unknown>, actor: string): SessionNote {
    this.project();
    if (!validActor(actor)) throw new RuleError("bad_actor", "a session needs a valid actor", 400);
    let data;
    try { data = cleanSession(value); }
    catch (err) { throw new RuleError("bad_session", (err as Error).message, 400); }
    this.log(null, actor, "session.wrapped", { ...data });
    return this.sessions(1)[0];
  }

  sessions(limit = 5): SessionNote[] {
    this.project();
    return this.sql.exec(`SELECT actor, at, data FROM events WHERE kind = 'session.wrapped' ORDER BY seq DESC LIMIT ?`, Math.max(1, Math.min(20, limit))).toArray()
      .map((r) => ({ actor: r.actor as string, at: r.at as string, data: JSON.parse(r.data as string) }));
  }

  events(id?: string, limit = 200): LedgerEvent[] {
    const rows = id
      ? this.sql.exec(`SELECT * FROM events WHERE item_id = ? ORDER BY seq DESC LIMIT ?`, id, limit).toArray()
      : this.sql.exec(`SELECT * FROM events ORDER BY seq DESC LIMIT ?`, limit).toArray();
    return rows.map((r) => ({
      seq: r.seq as number, itemId: r.item_id as string | null, at: r.at as string,
      ...(r.proved === 1 ? { proved: true as const } : {}),
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

  private log(itemId: string | null, actor: string, kind: string, data: Record<string, unknown>, proved = false): void {
    this.sql.exec(
      `INSERT INTO events (item_id, at, actor, kind, data, proved) VALUES (?, ?, ?, ?, ?, ?)`,
      itemId, new Date().toISOString(), actor, kind, JSON.stringify(data), proved ? 1 : null,
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
    // Only an item the owner has overridden carries the field.
    ...(r.review_override ? { reviewOverride: JSON.parse(r.review_override as string) as ReviewOverride } : {}),
  };
}
