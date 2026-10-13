// Role assignments (t622): which model does what, as the developer's dated
// judgements with evidence, which routing reads. "security review goes to
// codex/gpt-6-astra, because of what it caught on atelier/t592" was a line in
// an orchestrator's private notes; now it is a record on the index ledger,
// beside the pool and its notes, that every selector reads.
//
// A record is a standing decision (src/decisions.ts) with structure: the
// developer's authority (only the developer's token records or withdraws
// one), the developer's own words it rests on, the date the server gave it,
// and the acting harness/model that recorded it for the developer
// (src/models/judgement.ts, --as), plus what a decision's text cannot carry
// in a form routing can read:
//
//   scope      every project ("*"), or one project by its stable key, so a
//              rename never detaches it
//   role       build, review, security-review, claims-review or plan
//   choices    an ordered list of harness/model, each a pool entry, each
//              kept with its canonical model (canonicalModel): a model
//              under two harnesses is one model, the harness its condition
//   reason     why, in the orchestrator's words
//   evidence   the tasks or events it rests on, PROJECT/tN or PROJECT/tN#SEQ,
//              each checked to exist and kept by the project's key
//
// Records are never changed. A new assignment for the same scope and role
// supersedes the one standing, naming it (supersedes); a withdrawal is a
// record of its own naming the one it withdraws. Either way the old record
// keeps its evidence, author and date. Withdrawing the standing assignment
// restores the reader's documented fallback (FALLBACK), never an assignment
// it had superseded: a superseded judgement was replaced on purpose.
//
// Concurrency and retries. The ledger runs one request at a time, so the
// check and the write cannot interleave; what is guarded is a stale view.
// An assignment that would supersede one must name it (replaces), so two
// sessions that both read "a1 stands" cannot both replace it: the second is
// refused, naming the one that stands now. Each request carries an id the
// client makes once (the CLI, per command), kept on the record: a request
// sent again (a retry after a lost answer, however late) finds its record by
// that id and gets it back marked retried, whatever happened since, so a
// delayed retry never reactivates an assignment withdrawn in between
// (gpt-6-astra's review of t622, finding 2). A new decision is a new id.
//
// Each project's ledger holds a copy of the assignments bearing on it, sent
// as a snapshot whose version is the number of records written (withdrawals
// included, so it only grows). Two snapshots read at different times may
// arrive in either order; a copy never takes one older than the one it holds
// (snapshotApplies; gpt-6-astra's review of t622, finding 1).
//
// ── Precedence ──────────────────────────────────────────────────────────
// Pool roles (build, review, plan on a pool entry) say what a model may do;
// they are eligibility, set with atelier models set --roles. Assignment roles
// say who the developer judges best at a job, and order. Pool `tier`
// (frontier, execution, budget) is informational and read by no selector,
// this one included. A project's reviewTier (atelier init --review-tier) is
// project policy that does change selection. From strongest to weakest:
//
// 1. The rules. Every selector filters first: the developer's standing
//    (paused, reserved, without the pool role), a refused or unavailable
//    model, one no live runner offers, paid models not allowed, project
//    policy (eligible harnesses, governed roles, single-family mode),
//    reviewer admissions, independence from every contributor, the size of
//    a part. An assignment orders only what passes; it never makes a model
//    eligible.
// 2. An explicit choice for this one job: a dispatch naming --model or --to,
//    a reviewer the developer named, a plan part's prefer, the previous
//    round's reviewer on a re-review.
// 3. The project's reviewTier: for a protected change its models are asked
//    before the rest of the pool. An assignment orders the tier's own
//    models among themselves and never adds a model to the tier.
// 4. Assignments: the most specific first. A role's own assignment before
//    the general review one it falls back to (security-review, then
//    review), and within a role this project's before every project's. The
//    first whose choices include an eligible candidate is applied; its
//    eligible choices come first, in its order. One with no eligible choice
//    is skipped, and the next is tried.
// 5. The reader's own order (FALLBACK): measured outcomes, review precision,
//    reliability, speed, spread and model id, as before.
//
// Plans: a plan's routing is fixed at its approval. A plan approved before
// an assignment keeps it; the assignment applies when a plan is previewed,
// approved or rerouted, and when its tick picks a reviewer the routing no
// longer gives.

import { DECISION_NOTE_MAX, DECISION_QUOTE_MAX, DECISION_TEXT_MAX, line } from "../decisions.ts";
import { RuleError, sameActor } from "../rules.ts";
import { canonicalModel, type PoolNames } from "./judgement.ts";
import { entryRuns, standingRefusal, type ModelEntry, type ModelRole } from "./pool.ts";

export const ASSIGNMENT_ROLES = ["build", "review", "security-review", "claims-review", "plan"] as const;
export type AssignmentRole = (typeof ASSIGNMENT_ROLES)[number];
export const ALL_PROJECTS = "*";
export const ASSIGNMENT_ID = /^a[1-9]\d{0,8}$/;
export const MAX_CHOICES = 8;
export const MAX_EVIDENCE = 20;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

// The pool role a model needs to take an assignment role.
export const POOL_ROLE: Record<AssignmentRole, ModelRole> = {
  build: "build", review: "review", "security-review": "review", "claims-review": "review", plan: "plan",
};

// What a reader does when no assignment applies: the documented fallback a
// withdrawal restores.
export const FALLBACK: Record<AssignmentRole, string> = {
  build: "dispatch suggestions rank eligible builders by recorded outcomes; plan routing ranks them by evidence, the project's record and reliability, spreading tied models across the plan's parts",
  review: "the reviewer selector asks the previous round's reviewer, the project's review tier for a protected change, the plan's routing, then the pool by review precision, outcome record and model id",
  "security-review": "the review assignment applies, and without one the review fallback",
  "claims-review": "the review assignment applies, and without one the review fallback",
  plan: "the planner is the first eligible pool model in routing order for research work",
};

// The roles a review reads, most specific first: security or gate work
// reads security-review, docs work claims-review, and both fall back to review.
export function reviewRoles(opts: { sensitive?: boolean; docs?: boolean }): AssignmentRole[] {
  return [...(opts.sensitive ? ["security-review" as const] : []), ...(opts.docs ? ["claims-review" as const] : []), "review"];
}

// Whether a task's scope is documentation alone (Markdown, or under docs/),
// so its review reads claims-review: what it claims against the code.
export function docsOnly(paths: readonly string[]): boolean {
  return paths.length > 0 && paths.every((p) => /\.md$/i.test(p) || /^docs\//.test(p));
}

export interface AssignmentChoice {
  actor: string;              // harness/id of the pool entry, as the pool names it
  model: string;              // its canonical model (canonicalModel)
}

export interface Assignment {
  id: string;                 // a1, a2, ... shared with withdrawals, in the order recorded
  request?: string;           // the id the client gave the request that recorded it
  kind: "assigned";
  scope: string;              // ALL_PROJECTS or a project's stable key
  role: AssignmentRole;
  choices: AssignmentChoice[];
  reason: string;
  quote: string;              // the developer's own words it rests on
  evidence: string[];         // KEY/tN or KEY/tN#SEQ, each checked when recorded
  by: string;
  at: string;                 // the server's time
  acting?: string;            // the harness/model that recorded it for the developer
  supersedes?: string;        // the assignment that stood for this scope and role
}

export interface AssignmentWithdrawal {
  id: string;
  kind: "withdrawn";
  withdraws: string;
  scope: string;
  role: AssignmentRole;
  note: string;
  by: string;
  at: string;
  acting?: string;
}

export type AssignmentRecord = Assignment | AssignmentWithdrawal;

export type AssignmentStatus = "current" | "superseded" | "withdrawn";
export interface AssignmentView extends Assignment {
  status: AssignmentStatus;
  supersededBy?: { id: string; at: string };
  withdrawal?: { id: string; by: string; at: string; note: string; acting?: string };
}

// ── input ───────────────────────────────────────────────────────────────

export interface EvidenceRef { project: string; item: string; seq?: number }

const REF = /^([^\s/#@]{1,100})\/(t[1-9]\d{0,8})(?:#([1-9]\d{0,11}))?$/;

// One evidence reference: PROJECT/tN for a task, PROJECT/tN#SEQ for one of
// its events. Task ids repeat across projects, so a bare tN is refused.
export function parseEvidenceRef(raw: unknown): EvidenceRef {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (/^t[1-9]\d*(#\d+)?$/.test(text)) {
    throw new RuleError("bad_evidence", `evidence ${text} names no project, and task ids repeat across projects: name it PROJECT/${text}, such as atelier/${text}`, 400);
  }
  const m = REF.exec(text);
  if (!m) throw new RuleError("bad_evidence", `evidence ${text ? `"${text.slice(0, 60)}"` : "(empty)"} is not PROJECT/tN or PROJECT/tN#SEQ`, 400);
  return { project: m[1], item: m[2], ...(m[3] ? { seq: Number(m[3]) } : {}) };
}

export const refText = (r: EvidenceRef) => `${r.project}/${r.item}${r.seq ? `#${r.seq}` : ""}`;

// The evidence checked against the record and kept by each project's stable
// key: the project is registered (under its name now or a former one), the
// task is in its ledger, and an event named is one of that task's. `project`
// resolves a name as the index does; `exists` asks the project's ledger and
// says what is missing, or null. The same reference given twice is kept once.
export async function checkEvidence(
  refs: readonly EvidenceRef[],
  project: (name: string) => Promise<{ key: string; registered: boolean }>,
  exists: (key: string, item: string, seq?: number) => Promise<string | null>,
): Promise<string[]> {
  const out: string[] = [];
  for (const ref of refs) {
    const p = await project(ref.project);
    if (!p.registered) throw new RuleError("bad_evidence", `evidence ${refText(ref)}: no project ${ref.project}`, 400);
    const missing = await exists(p.key, ref.item, ref.seq);
    if (missing) throw new RuleError("bad_evidence", `evidence ${refText(ref)}: ${missing}`, 400);
    const kept = refText({ ...ref, project: p.key });
    if (!out.includes(kept)) out.push(kept);
  }
  return out;
}

const list = (v: unknown): string[] =>
  (Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : []).map((s) => (typeof s === "string" ? s.trim() : "")).filter(Boolean);

export interface AssignmentInput {
  request: string;            // the client's id for this request, the same on every retry
  scope: string;              // ALL_PROJECTS or a project's name as given
  role: AssignmentRole;
  choices: string[];          // as given; resolveChoices reads them against the pool
  reason: string;
  quote: string;
  evidence: EvidenceRef[];
  replaces: string | null;    // the assignment the request expects to supersede, or null for none
}

// What a request says, checked before anything is read or written.
export function cleanAssignmentInput(body: Record<string, unknown>): AssignmentInput {
  const role = typeof body.role === "string" ? body.role.trim() : "";
  if (!ASSIGNMENT_ROLES.includes(role as AssignmentRole)) throw new RuleError("bad_role", `the role is one of ${ASSIGNMENT_ROLES.join(", ")}`, 400);
  const scope = body.scope === undefined || body.scope === null || body.scope === "" ? ALL_PROJECTS : typeof body.scope === "string" ? body.scope.trim() : "";
  if (!scope || scope.includes("/")) throw new RuleError("bad_scope", "the scope is a project's name, or every project when none is given", 400);
  const choices = list(body.choices);
  if (!choices.length) throw new RuleError("bad_choices", "an assignment names its choices in order, each harness/model, such as codex/gpt-6-astra", 400);
  if (choices.length > MAX_CHOICES) throw new RuleError("bad_choices", `an assignment names at most ${MAX_CHOICES} choices`, 400);
  if (body.reason !== undefined && typeof body.reason !== "string") throw new RuleError("bad_reason", "the reason is text", 400);
  if (body.quote !== undefined && typeof body.quote !== "string") throw new RuleError("bad_quote", "the developer's words are text", 400);
  const reason = line(body.reason), quote = line(body.quote);
  if (!reason) throw new RuleError("bad_reason", "an assignment needs a reason: --reason \"why these models\"", 400);
  if (reason.length > DECISION_TEXT_MAX) throw new RuleError("too_long", `the reason is at most ${DECISION_TEXT_MAX} characters`, 400);
  if (!quote) throw new RuleError("bad_quote", "an assignment needs the developer's words: --quote \"what the developer said\"", 400);
  if (quote.length > DECISION_QUOTE_MAX) throw new RuleError("too_long", `the developer's words are at most ${DECISION_QUOTE_MAX} characters`, 400);
  const refs = list(body.evidence);
  if (!refs.length) throw new RuleError("bad_evidence", "an assignment rests on evidence: --evidence PROJECT/tN, once per task or event", 400);
  if (refs.length > MAX_EVIDENCE) throw new RuleError("bad_evidence", `an assignment names at most ${MAX_EVIDENCE} pieces of evidence`, 400);
  const evidence = refs.map(parseEvidenceRef);
  const replaces = body.replaces === undefined || body.replaces === null || body.replaces === "" || body.replaces === "none" ? null : String(body.replaces).trim();
  if (replaces !== null && !ASSIGNMENT_ID.test(replaces)) throw new RuleError("bad_replaces", "--replaces names the assignment that stands, such as a3, or none", 400);
  const request = typeof body.request === "string" ? body.request.trim() : "";
  if (!REQUEST_ID.test(request)) throw new RuleError("bad_request_id", "an assignment request carries a request id the client makes once, 8 to 64 letters, digits, dashes or underscores, so a retry is told from a new decision", 400);
  return { request, scope, role: role as AssignmentRole, choices, reason, quote, evidence, replaces };
}

// Each choice as the pool names it, with its canonical model. A choice must
// name its harness: a model alone may run under several (claude-code and
// antigravity both run Opus), and the harness is part of the judgement. A
// name two entries in the harness answer to is ambiguous and refused, as is
// one the pool does not have, one given twice, and one whose pool roles keep
// it from the job (a review-only model is never a builder). A choice paused
// or reserved now is recorded: that standing is temporary, and routing skips
// it while it holds.
export function resolveChoices(raw: readonly string[], pool: readonly ModelEntry[], role: AssignmentRole): AssignmentChoice[] {
  const bad = (detail: string) => new RuleError("bad_choices", detail, 400);
  const out: AssignmentChoice[] = [];
  for (const name of raw) {
    const slash = name.indexOf("/");
    if (slash <= 0 || slash === name.length - 1) {
      const runs = pool.filter((e) => entryRuns(e, name)).map((e) => `${e.harness}/${e.id}`);
      throw bad(`${name} names no harness${runs.length ? `; the pool runs it as ${runs.join(", ")}` : ""}: name each choice harness/model`);
    }
    const harness = name.slice(0, slash).toLowerCase();
    // An entry whose id is the name exactly is the one meant; otherwise
    // every entry in the harness that answers to it, by an alias or by the
    // model it runs, and more than one is ambiguous.
    const model = name.slice(slash + 1).toLowerCase();
    const exact = pool.filter((e) => e.harness === harness && e.id.toLowerCase() === model);
    const found = exact.length ? exact : pool.filter((e) => e.harness === harness && ([e.id, ...e.aliases].some((id) => sameActor(`${e.harness}/${id}`, name)) || entryRuns(e, name)));
    if (!found.length) throw bad(`${name} is not a model in the pool; add it with atelier models add, or name a harness/model the pool has`);
    if (found.length > 1) throw bad(`${name} is ambiguous: the pool has ${found.map((e) => `${e.harness}/${e.id}`).join(" and ")} under that name; name one by its id`);
    const entry = found[0];
    const actor = `${entry.harness}/${entry.id}`;
    // The roles alone, through the one standing check: a paused or reserved
    // state is laid aside here, since it is temporary.
    const roleRefusal = standingRefusal({ ...entry, state: "available" }, POOL_ROLE[role]);
    if (roleRefusal) throw bad(`${actor} cannot take ${role}: ${roleRefusal}; change its roles with atelier models set ${entry.id} --roles`);
    if (out.some((c) => c.actor === actor)) throw bad(`${actor} is named twice`);
    out.push({ actor, model: canonicalModel(actor, pool) });
  }
  return out;
}

// ── storage ─────────────────────────────────────────────────────────────

// The index ledger's side: its records in the order written, the way to
// write one, the developer's actor and its event log.
export interface AssignmentStore {
  records(): AssignmentRecord[];
  insert(record: AssignmentRecord): void;
  owner: string;
  log(kind: string, data: Record<string, unknown>): void;
}

// An input with its scope resolved to a project key, its choices to the
// pool, and its evidence checked and kept by project key.
export interface ResolvedAssignment {
  request: string;
  scope: string;
  role: AssignmentRole;
  choices: AssignmentChoice[];
  reason: string;
  quote: string;
  evidence: string[];
  replaces: string | null;
}

const ownerOnly = (store: AssignmentStore, actor: string, what: string) => {
  if (actor !== store.owner) throw new RuleError("not_project_owner", `only the developer ${what}`, 403);
};
const same = (a: AssignmentRecord, scope: string, role: AssignmentRole) => a.scope === scope && a.role === role;
const scopeText = (scope: string, names?: ReadonlyMap<string, string>) => (scope === ALL_PROJECTS ? "every project" : names?.get(scope) ?? scope);
const nextId = (records: readonly AssignmentRecord[]) => `a${records.length + 1}`;

// The assignment standing for a scope and role, or null: the latest record
// for them, when it is an assignment rather than a withdrawal.
export function standingFor(records: readonly AssignmentRecord[], scope: string, role: AssignmentRole): Assignment | null {
  const last = [...records].reverse().find((r) => same(r, scope, role));
  return last?.kind === "assigned" ? last : null;
}

const sameContent = (a: Assignment, b: ResolvedAssignment) =>
  a.scope === b.scope && a.role === b.role && a.reason === b.reason && a.quote === b.quote
  && JSON.stringify(a.choices.map((c) => c.actor)) === JSON.stringify(b.choices.map((c) => c.actor))
  && JSON.stringify(a.evidence) === JSON.stringify(b.evidence);

export function recordAssignment(store: AssignmentStore, actor: string, input: ResolvedAssignment, now: string, acting: string | null = null): Assignment & { retried?: true } {
  ownerOnly(store, actor, "assigns a role");
  const records = store.records();
  const standing = standingFor(records, input.scope, input.role);
  const where = `${input.role} in ${scopeText(input.scope)}`;
  // A retry: the request's own record, found by its id whether it stands,
  // was superseded or was withdrawn since. The same id with other content
  // is another request reusing it, and is refused.
  const own = records.find((r): r is Assignment => r.kind === "assigned" && r.request === input.request);
  if (own) {
    if (sameContent(own, input) && (own.supersedes ?? null) === input.replaces) return { ...own, retried: true };
    throw new RuleError("request_reused", `request ${input.request} already recorded ${own.id}, with other content; a new decision needs a new request id`, 409);
  }
  if (standing && input.replaces !== standing.id) {
    throw new RuleError("assignment_changed", `${standing.id} stands for ${where} since ${standing.at.slice(0, 10)}${input.replaces ? `, not ${input.replaces}` : ""}; to supersede it, name it: --replaces ${standing.id}`, 409);
  }
  if (!standing && input.replaces !== null) {
    const was = records.find((r) => r.id === input.replaces);
    throw new RuleError("assignment_changed", `${input.replaces} does not stand for ${where}${was ? ` (${was.kind === "assigned" ? "it was superseded or withdrawn" : "that is a withdrawal"})` : ""}; nothing stands there now, so record it without --replaces`, 409);
  }
  const record: Assignment = {
    id: nextId(records), kind: "assigned", request: input.request, scope: input.scope, role: input.role, choices: input.choices,
    reason: input.reason, quote: input.quote, evidence: input.evidence, by: actor, at: now,
    ...(acting ? { acting } : {}), ...(standing ? { supersedes: standing.id } : {}),
  };
  store.insert(record);
  store.log("assignment.recorded", { id: record.id, scope: record.scope, role: record.role, choices: record.choices.map((c) => c.actor), reason: record.reason, quote: record.quote, evidence: record.evidence, ...(standing ? { supersedes: standing.id } : {}), ...(acting ? { acting } : {}) });
  return record;
}

// The developer withdraws the standing assignment, with a note. What stood
// before it does not return: the reader falls back to FALLBACK.
export function withdrawAssignment(store: AssignmentStore, actor: string, id: string, note: unknown, now: string, acting: string | null = null): AssignmentWithdrawal & { retried?: true } {
  ownerOnly(store, actor, "withdraws a role assignment");
  if (note !== undefined && typeof note !== "string") throw new RuleError("bad_note", "a note is text", 400);
  const why = line(note);
  if (!why) throw new RuleError("bad_note", "withdrawing an assignment needs a note saying why: --note \"…\"", 400);
  if (why.length > DECISION_NOTE_MAX) throw new RuleError("too_long", `the note is at most ${DECISION_NOTE_MAX} characters`, 400);
  const records = store.records();
  const target = records.find((r) => r.id === id);
  if (!target || target.kind !== "assigned") throw new RuleError("no_assignment", `no assignment ${id}; atelier models roles lists them`, 404);
  const done = records.find((r): r is AssignmentWithdrawal => r.kind === "withdrawn" && r.withdraws === id);
  if (done) {
    if (done.note === why) return { ...done, retried: true };
    throw new RuleError("not_standing", `${id} was withdrawn on ${done.at.slice(0, 10)} (${done.id}), so there is nothing to withdraw`, 409);
  }
  const after = records.find((r): r is Assignment => r.kind === "assigned" && r.supersedes === id);
  if (after) throw new RuleError("not_standing", `${id} was superseded by ${after.id} on ${after.at.slice(0, 10)}; withdraw ${after.id} to return ${target.role} in ${scopeText(target.scope)} to its fallback`, 409);
  const record: AssignmentWithdrawal = { id: nextId(records), kind: "withdrawn", withdraws: id, scope: target.scope, role: target.role, note: why, by: actor, at: now, ...(acting ? { acting } : {}) };
  store.insert(record);
  store.log("assignment.withdrawn", { id: record.id, withdraws: id, scope: target.scope, role: target.role, note: why, ...(acting ? { acting } : {}) });
  return record;
}

// Every assignment with its status, oldest first: the history.
export function assignmentHistory(records: readonly AssignmentRecord[]): AssignmentView[] {
  return records.filter((r): r is Assignment => r.kind === "assigned").map((a) => {
    const after = records.find((r): r is Assignment => r.kind === "assigned" && r.supersedes === a.id);
    const out = records.find((r): r is AssignmentWithdrawal => r.kind === "withdrawn" && r.withdraws === a.id);
    if (after) return { ...a, status: "superseded" as const, supersededBy: { id: after.id, at: after.at } };
    if (out) return { ...a, status: "withdrawn" as const, withdrawal: { id: out.id, by: out.by, at: out.at, note: out.note, ...(out.acting ? { acting: out.acting } : {}) } };
    return { ...a, status: "current" as const };
  });
}

// The assignments standing now, one per scope and role.
export function currentAssignments(records: readonly AssignmentRecord[]): Assignment[] {
  return assignmentHistory(records).filter((v) => v.status === "current").map(({ status: _s, supersededBy: _b, withdrawal: _w, ...a }) => a);
}

// What a project's ledger is sent: the assignments standing now and the
// version of the record they were read at, the number of records written.
export interface AssignmentSnapshot { version: number; assignments: Assignment[] }

export function assignmentSnapshot(records: readonly AssignmentRecord[], bears: (a: Assignment) => boolean = () => true): AssignmentSnapshot {
  return { version: records.length, assignments: currentAssignments(records).filter(bears) };
}

// Whether a copy holding `held` takes `incoming`: never an older snapshot,
// which would bring back what was superseded or withdrawn since it was read.
export function snapshotApplies(held: AssignmentSnapshot | null, incoming: AssignmentSnapshot): boolean {
  return held === null || incoming.version >= held.version;
}

// ── reading ─────────────────────────────────────────────────────────────

// The assignments that bear on a job in a project, most specific first:
// each role in `roles` in turn, this project's before every project's. With
// `project` null the list was already narrowed to one project (a project
// ledger's copy holds only its own and every project's), so any scope other
// than ALL_PROJECTS is that project's.
export function applicableAssignments(current: readonly Assignment[], project: string | null, roles: readonly AssignmentRole[]): Assignment[] {
  const mine = (a: Assignment) => a.scope !== ALL_PROJECTS && (project === null || a.scope === project);
  return roles.flatMap((role) => [
    ...current.filter((a) => a.role === role && mine(a)),
    ...current.filter((a) => a.role === role && a.scope === ALL_PROJECTS),
  ]);
}

// Whether a candidate actor is an assignment's choice: the same harness and
// the same model, by the pool's names when it is given.
export function choiceMatches(choice: AssignmentChoice, actor: string, pool: PoolNames = []): boolean {
  if (sameActor(choice.actor, actor)) return true;
  const harness = (a: string) => a.slice(0, Math.max(0, a.indexOf("/"))).toLowerCase();
  return harness(choice.actor) === harness(actor) && canonicalModel(actor, pool) === choice.model;
}

export interface AssignmentOutcome {
  applied: string | null;                    // the assignment that ordered the candidates
  skipped: { id: string; why: string }[];    // those that bore on the job and did not order it
  fallback: string | null;                   // what ordered them when none applied
  lines: string[];                           // the reasons, in words
}

export interface AssignmentOrder<T> {
  order: T[];
  outcome: AssignmentOutcome;
  promoted: (c: T) => string | null;         // the reason line for a candidate the assignment put first
  reasons: (c: T) => string[];               // what a chosen candidate's reasons say of the assignments
}

export const assignmentLabel = (a: Assignment, names?: ReadonlyMap<string, string>) =>
  `Role assignment ${a.id} (${a.role}, ${scopeText(a.scope, names)}, ${a.at.slice(0, 10)})`;

// The candidates with an assignment's eligible choices first, in its order,
// and every other candidate after them in the order given. `refusal` says
// why a candidate may not take the job (null when it may), so an ineligible
// choice is never moved: it stays where it was, and the reader passes it
// over as before. The first assignment in `assigned` (most specific first,
// applicableAssignments) with an eligible choice among the candidates is
// applied; earlier ones are skipped as having none, later ones as outranked.
export function orderByAssignment<T>(candidates: readonly T[], actorOf: (c: T) => string, assigned: readonly Assignment[], refusal: (c: T) => string | null, fallback: string, pool: PoolNames = []): AssignmentOrder<T> {
  const skipped: { id: string; why: string }[] = [];
  const lines: string[] = [];
  for (const [i, a] of assigned.entries()) {
    const firsts: { c: T; k: number }[] = [];
    const missed: string[] = [];
    a.choices.forEach((choice, k) => {
      const matches = candidates.filter((c) => choiceMatches(choice, actorOf(c), pool));
      const ok = matches.find((c) => refusal(c) === null);
      if (ok !== undefined && !firsts.some((f) => f.c === ok)) firsts.push({ c: ok, k });
      else if (ok === undefined) missed.push(`${choice.actor}: ${matches.length ? refusal(matches[0]) : "not a candidate here (not in the pool, or not offered for this job)"}`);
    });
    if (!firsts.length) {
      skipped.push({ id: a.id, why: `no choice is eligible here (${missed.join("; ")})` });
      continue;
    }
    for (const later of assigned.slice(i + 1)) skipped.push({ id: later.id, why: `outranked by ${a.id}, which is more specific` });
    const moved = new Set(firsts.map((f) => f.c));
    const order = [...firsts.map((f) => f.c), ...candidates.filter((c) => !moved.has(c))];
    const head = `${assignmentLabel(a)} puts ${firsts.map((f) => actorOf(f.c)).join(", ")} first: ${a.reason}`;
    lines.push(head, ...(missed.length ? [`Its other choices are not eligible here: ${missed.join("; ")}`] : []), ...skippedLines(skipped));
    const reasonFor = (c: T) => {
      const f = firsts.find((x) => x.c === c);
      return f ? `${assignmentLabel(a)}: choice ${f.k + 1} of ${a.choices.length} for ${a.role}; ${a.reason}` : null;
    };
    return { order, outcome: { applied: a.id, skipped, fallback: null, lines }, promoted: reasonFor, reasons: (c: T) => { const r = reasonFor(c); return r ? [r, ...lines.slice(1)] : lines; } };
  }
  lines.push(...skippedLines(skipped), ...(assigned.length ? [`No role assignment applies, so ${fallback}`] : []));
  return { order: [...candidates], outcome: { applied: null, skipped, fallback: assigned.length ? fallback : null, lines }, promoted: () => null, reasons: () => lines };
}

const skippedLines = (skipped: readonly { id: string; why: string }[]) => skipped.map((s) => `Role assignment ${s.id} skipped: ${s.why}`);

// ── display ─────────────────────────────────────────────────────────────

// A project key shown by the project's current name, so a renamed project's
// assignments and evidence read under the name it has now.
export function evidenceText(ref: string, names: ReadonlyMap<string, string>): string {
  const slash = ref.indexOf("/");
  const key = ref.slice(0, slash);
  return `${names.get(key) ?? key}${ref.slice(slash)}`;
}

export function assignmentLine(v: AssignmentView, names: ReadonlyMap<string, string>, pool: readonly Pick<ModelEntry, "id" | "harness">[] | null = null): string {
  const gone = (actor: string) => pool !== null && !pool.some((e) => `${e.harness}/${e.id}` === actor);
  const choices = v.choices.map((c) => `${c.actor}${gone(c.actor) ? " (not in the pool now)" : ""}`).join(", then ");
  const status = v.status === "current" ? "" : v.status === "superseded" ? ` [superseded by ${v.supersededBy!.id} on ${v.supersededBy!.at.slice(0, 10)}]` : ` [withdrawn ${v.withdrawal!.at.slice(0, 10)} by ${v.withdrawal!.by}${v.withdrawal!.acting ? ` (acting ${v.withdrawal!.acting})` : ""}: ${v.withdrawal!.note}]`;
  return `${v.id} ${v.at.slice(0, 10)} ${v.role} in ${scopeText(v.scope, names)}: ${choices}${status}. Why: ${v.reason} Evidence: ${v.evidence.map((e) => evidenceText(e, names)).join(", ")}. The developer's words: “${v.quote}” Recorded by ${v.by}${v.acting ? ` (acting ${v.acting})` : ""}${v.supersedes ? `, superseding ${v.supersedes}` : ""}.`;
}
