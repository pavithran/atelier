// Protected actions. A deploy, a device install, a paid model run, a Photos
// writeback, or another kind a project's own ship files name, runs only with
// the project owner's approval for one exact revision of the project's main
// line: a commit the baseline in Artifacts holds, which is the main line as
// Atelier sees it. An approval is recorded as an event, listed, withdrawn by
// the owner, used by exactly one run (one approval, one run) and refused for
// any other revision or kind. `atelier ship` (cli/ship.mjs) uses approvals
// and records each step it runs as an `action.ran` event. Pushing the
// project's branch to its own remotes is none of these: ship is owner-only
// and runs at one exact revision, so its `--push` is the owner's own act and
// takes no approval.
//
// The functions here hold the rules and the storage. The Ledger (one per
// project) calls them, so a project's approvals are serialised with the rest
// of its record. The CLI imports the same constants and the expiry parser, so
// a kind or an expiry the CLI accepts is one the Worker accepts.

import { RuleError } from "./rules.ts";

// The kinds Atelier knows by name. A project's own ship files may name others
// (cli/ship.mjs knownKinds); the Worker accepts any kind written this way.
export const ACTION_KINDS = ["deploy", "install", "paid-run", "photos-writeback"] as const;
export const KIND = /^[a-z][a-z0-9-]{0,62}$/;
export const REVISION = /^[a-f0-9]{40,64}$/;

// How long an approval stands unless the owner says otherwise, and the bounds
// on what the owner may say: from a minute to thirty days.
export const DEFAULT_EXPIRY = "24h";
const MIN_EXPIRY = 60, MAX_EXPIRY = 30 * 24 * 3600;
const NOTE_MAX = 500, TAIL_MAX = 4000, COMMAND_MAX = 1000;

// "90m", "24h" or "7d" as seconds. Anything else, or a span outside the
// bounds, is refused with a message saying what is taken.
export function expirySeconds(text: unknown): number {
  const m = typeof text === "string" ? /^(\d{1,5})([mhd])$/.exec(text.trim()) : null;
  const seconds = m ? Number(m[1]) * { m: 60, h: 3600, d: 86400 }[m[2] as "m" | "h" | "d"] : NaN;
  if (!(seconds >= MIN_EXPIRY && seconds <= MAX_EXPIRY)) {
    throw new Error(`an expiry is minutes, hours or days, such as 90m, 24h or 7d, from 1m to 30d; got ${JSON.stringify(text)}`);
  }
  return seconds;
}

export interface ActionApproval {
  id: string;            // a1, a2, ... in the order they were given
  kind: string;
  commit: string;        // the full revision of the main line it is bound to
  note: string;
  by: string;
  at: string;
  expiresAt: string;
  withdrawn?: { by: string; at: string; note: string };
  consumed?: { by: string; at: string };
}

export type ApprovalStatus = "active" | "consumed" | "withdrawn" | "expired";
export type ApprovalView = ActionApproval & { status: ApprovalStatus };

export function approvalStatus(a: ActionApproval, now: string): ApprovalStatus {
  if (a.consumed) return "consumed";
  if (a.withdrawn) return "withdrawn";
  return a.expiresAt <= now ? "expired" : "active";
}

// One step a ship ran, as the `action.ran` event records it.
export interface ActionRun {
  step: string;
  kind: string | null;       // the approval kind the step needed, or null
  approval: string | null;   // the approval it used, or null
  command: string | null;    // what ran, as one line; null for a step with no command
  commit: string;            // the revision being shipped
  exitStatus: number | null;
  signal: string | null;
  durationMs: number;
  passed: boolean;
  outputTail: string;        // the end of the output, redacted before it was sent
  ship: string;              // one id for every step of one ship
  note: string;
}

// Text a person typed, kept to one line without control characters.
const line = (v: unknown, max: number) =>
  typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";

const short = (sha: string) => sha.slice(0, 8);

// What an approval request says, checked before anything is read or written:
// a kind, the full revision, an optional note and an optional expiry.
export function cleanApprovalInput(body: Record<string, unknown>): { kind: string; commit: string; note: string; seconds: number } {
  const kind = typeof body.kind === "string" ? body.kind.trim() : "";
  if (!KIND.test(kind)) throw new RuleError("bad_kind", "name the action in lower case letters, digits and dashes, such as deploy, install, push, paid-run or photos-writeback", 400);
  const commit = typeof body.commit === "string" ? body.commit.trim().toLowerCase() : "";
  if (!REVISION.test(commit)) throw new RuleError("bad_revision", "an approval names the full revision of the main line it is for, 40 or 64 hex digits", 400);
  if (body.note !== undefined && typeof body.note !== "string") throw new RuleError("bad_note", "a note is text", 400);
  let seconds: number;
  try { seconds = expirySeconds(body.expires === undefined || body.expires === "" ? DEFAULT_EXPIRY : body.expires); }
  catch (err) { throw new RuleError("bad_expiry", (err as Error).message, 400); }
  return { kind, commit, note: line(body.note, NOTE_MAX), seconds };
}

// What a run record says, checked field by field; a field out of shape is
// refused, naming it, rather than stored as it came.
export function cleanRun(body: Record<string, unknown>): ActionRun {
  const bad = (field: string, what: string): never => { throw new RuleError("bad_run", `a run record's ${field} must be ${what}`, 400); };
  const absent = (v: unknown) => v === null || v === undefined;
  const name = (v: unknown, field: string) => typeof v === "string" && KIND.test(v) ? v : bad(field, "a lower-case name such as deploy");
  const step = name(body.step, "step");
  const kind = absent(body.kind) ? null : name(body.kind, "kind");
  const approval = absent(body.approval) ? null : typeof body.approval === "string" && /^a\d{1,9}$/.test(body.approval) ? body.approval : bad("approval", "an approval id such as a3");
  if (approval && !kind) bad("kind", "given with an approval");
  const command = absent(body.command) ? null : typeof body.command === "string" ? line(body.command, COMMAND_MAX) : bad("command", "text");
  const commit = typeof body.commit === "string" && REVISION.test(body.commit) ? body.commit : bad("commit", "a full revision");
  const exitStatus = absent(body.exitStatus) ? null : Number.isInteger(body.exitStatus) ? body.exitStatus as number : bad("exitStatus", "an integer or null");
  const signal = absent(body.signal) ? null : typeof body.signal === "string" && /^[A-Z0-9]{1,20}$/.test(body.signal) ? body.signal : bad("signal", "a signal name or null");
  const ms = body.durationMs;
  const durationMs = typeof ms === "number" && Number.isInteger(ms) && ms >= 0 && ms <= 7 * 86400_000 ? ms : bad("durationMs", "a whole number of milliseconds");
  const passed = typeof body.passed === "boolean" ? body.passed : bad("passed", "true or false");
  if (body.outputTail !== undefined && typeof body.outputTail !== "string") bad("outputTail", "text");
  const ship = typeof body.ship === "string" && /^[A-Za-z0-9:.-]{1,40}$/.test(body.ship) ? body.ship : bad("ship", "the ship's id");
  return {
    step, kind, approval, command, commit, exitStatus, signal, durationMs, passed,
    outputTail: String(body.outputTail ?? "").slice(-TAIL_MAX), ship, note: line(body.note, NOTE_MAX),
  };
}

// The Ledger's side: its SQLite storage, the project owner's actor, and its
// event log. The table is made on first use, so a Ledger that never sees an
// approval never has one.
export interface ActionStore {
  sql: SqlStorage;
  owner: string;
  log(kind: string, data: Record<string, unknown>): void;
}

function rows(sql: SqlStorage): ActionApproval[] {
  sql.exec(`CREATE TABLE IF NOT EXISTS action_approvals (n INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, json TEXT NOT NULL)`);
  return sql.exec(`SELECT json FROM action_approvals ORDER BY n`).toArray().map((r) => JSON.parse(r.json as string) as ActionApproval);
}

function save(sql: SqlStorage, a: ActionApproval): void {
  sql.exec(`UPDATE action_approvals SET json = ? WHERE id = ?`, JSON.stringify(a), a.id);
}

function ownerOnly(store: ActionStore, actor: string, what: string): void {
  if (actor !== store.owner) throw new RuleError("not_project_owner", `only the project owner ${what}`, 403);
}

const view = (a: ActionApproval, now: string): ApprovalView => ({ ...a, status: approvalStatus(a, now) });

// The approvals, newest first, each with its status at `now`.
export function listApprovals(store: ActionStore, now: string): ApprovalView[] {
  return rows(store.sql).reverse().map((a) => view(a, now));
}

// The owner approves one kind at one revision. The caller has already found
// the revision on the main line (actionsApi in src/actions-api.ts); a second
// active approval for the same kind and revision is refused, so what one
// approval allows is never in doubt.
export function approveAction(store: ActionStore, actor: string, body: Record<string, unknown>, now: string): ApprovalView {
  ownerOnly(store, actor, "approves a protected action");
  const { kind, commit, note, seconds } = cleanApprovalInput(body);
  const all = rows(store.sql);
  const same = all.find((a) => a.kind === kind && a.commit === commit && approvalStatus(a, now) === "active");
  if (same) {
    throw new RuleError("already_approved", `${kind} at ${short(commit)} is already approved as ${same.id}, until ${same.expiresAt}. To change its note or expiry, withdraw it first: atelier approvals withdraw ${same.id}`, 409);
  }
  const n = all.length + 1;
  const approval: ActionApproval = { id: `a${n}`, kind, commit, note, by: actor, at: now, expiresAt: new Date(Date.parse(now) + seconds * 1000).toISOString() };
  store.sql.exec(`INSERT INTO action_approvals (n, id, json) VALUES (?, ?, ?)`, n, approval.id, JSON.stringify(approval));
  store.log("action.approved", { id: approval.id, kind, commit, note, expiresAt: approval.expiresAt });
  return view(approval, now);
}

export function withdrawAction(store: ActionStore, actor: string, id: string, note: unknown, now: string): ApprovalView {
  ownerOnly(store, actor, "withdraws an approval");
  const a = rows(store.sql).find((x) => x.id === id);
  if (!a) throw new RuleError("no_approval", `no approval ${id}; atelier approvals lists them`, 404);
  const status = approvalStatus(a, now);
  if (status !== "active") throw new RuleError("not_active", `${id} is ${status}, so there is nothing to withdraw`, 409);
  a.withdrawn = { by: actor, at: now, note: line(note, NOTE_MAX) };
  save(store.sql, a);
  store.log("action.withdrawn", { id, kind: a.kind, commit: a.commit, note: a.withdrawn.note });
  return view(a, now);
}

// A run takes the oldest active approval for its kind at its revision and
// marks it used, before it runs, so two runs never share one. With none, the
// refusal says what is approved instead and the command that approves this.
export function consumeAction(store: ActionStore, actor: string, body: Record<string, unknown>, now: string): ApprovalView {
  ownerOnly(store, actor, "runs a protected action");
  const kind = typeof body.kind === "string" && KIND.test(body.kind) ? body.kind : null;
  const commit = typeof body.commit === "string" && REVISION.test(body.commit) ? body.commit : null;
  if (!kind || !commit) throw new RuleError("bad_request", "name the kind and the full revision the action runs at", 400);
  const forKind = rows(store.sql).filter((a) => a.kind === kind);
  const match = forKind.find((a) => a.commit === commit && approvalStatus(a, now) === "active");
  if (!match) {
    const elsewhere = forKind.filter((a) => a.commit !== commit && approvalStatus(a, now) === "active").map((a) => `${a.id} at ${short(a.commit)}`);
    const lapsed = forKind.filter((a) => a.commit === commit).at(-1);
    const why = [
      elsewhere.length ? `${kind} is approved only at another revision (${elsewhere.join(", ")})` : "",
      lapsed ? `${lapsed.id} for it is ${approvalStatus(lapsed, now)}` : "",
    ].filter(Boolean).join("; ");
    throw new RuleError("not_approved", `no active approval for ${kind} at ${short(commit)}${why ? `: ${why}` : ""}. The project owner approves it with: atelier approve ${kind} --head ${commit}`, 409);
  }
  match.consumed = { by: actor, at: now };
  save(store.sql, match);
  store.log("action.consumed", { id: match.id, kind, commit });
  return view(match, now);
}

// A step a ship ran. A run that names an approval must name one this
// revision and kind used, so the record cannot claim an approval it did not have.
export function recordActionRun(store: ActionStore, actor: string, body: Record<string, unknown>): ActionRun {
  ownerOnly(store, actor, "records a protected action");
  const run = cleanRun(body);
  if (run.approval) {
    const a = rows(store.sql).find((x) => x.id === run.approval);
    if (!a?.consumed || a.kind !== run.kind || a.commit !== run.commit) {
      throw new RuleError("bad_run", `${run.approval} was not used for ${run.kind} at ${short(run.commit)}`, 400);
    }
  }
  store.log("action.ran", { ...run });
  return run;
}

// The latest runs, newest first, as the event log holds them.
export function actionRuns(sql: SqlStorage, limit = 20): (ActionRun & { at: string; actor: string })[] {
  return sql.exec(`SELECT at, actor, data FROM events WHERE kind = 'action.ran' ORDER BY seq DESC LIMIT ?`, Math.max(1, Math.min(200, limit))).toArray()
    .map((r) => ({ ...(JSON.parse(r.data as string) as ActionRun), at: r.at as string, actor: r.actor as string }));
}
