// The slate's records and its effective pick (t598, model slate C).
//
// Records are kept in the index table model_slates, never changed. Their kinds:
//
//   proposed   the day's candidate order, pending the developer's approval
//   approved   an order in force: the developer's, or the day's proposal
//              when it equals the one standing ("unchanged from sN")
//   adjusted   the developer's change to the order in force
//   moved      a job's effective pick changed (job, from, to, cause)
//   held       every approved model of a job became unavailable; the pick is
//              none (job, from, next: the first model outside the order)
//
// Each record after the first names the one it supersedes: the one before it.
// A write that names another is refused 409 with the current id, so two
// sessions that both read "s4 is current" cannot both record: the second is
// refused. Writes carry a request id the client makes once and a fingerprint
// of the body, as role assignments do (src/models/assignments.ts): a request
// sent again finds its record by the id and gets it back marked retried,
// whatever was recorded since; the same id with another body is refused.
//
// The effective pick of a job is not stored. It is computed at read time from
// the standing order (the last approved or adjusted record) and what is true
// now: usage, offers, readiness, pauses. moved and held records are written
// by the ledger in the same call that changed the pick (putUsage, mergePauses).

import type { SeenOffer } from "../dispatch/rules.ts";
import { liveOffers } from "../dispatch/rules.ts";
import { RuleError, type ProjectPolicy } from "../rules.ts";
import type { ProviderPause } from "../runners/memory.ts";
import type { Readiness } from "../runners/readiness.ts";
import type { UsageReport } from "../usage/report.ts";
import { ALL_PROJECTS, isRetryOf, type Assignment } from "./assignments.ts";
import type { ModelEntry } from "./pool.ts";
import { buildSlate, SLATE_JOBS, type Slate, type SlateJob, type SlateOrder } from "./slate.ts";
import { readingsFor } from "./usage-readings.ts";

export const SLATE_KINDS = ["proposed", "approved", "adjusted", "moved", "held"] as const;
export type SlateKind = (typeof SLATE_KINDS)[number];
// What a person or the daily proposal may write; moved and held are the ledger's.
export const WRITTEN_KINDS = ["proposed", "approved", "adjusted"] as const;

// The families each project's vendor limits allow, by project.
export type SlateLimits = Record<string, string[]>;

interface SlateBase { id: string; at: string; supersedes?: string; request?: string; fingerprint?: string }
export interface OrderRecord extends SlateBase { kind: "proposed" | "approved" | "adjusted"; order: SlateOrder; limits: SlateLimits; note?: string; day?: string }
export interface MovedRecord extends SlateBase { kind: "moved"; job: SlateJob; from: string | null; to: string; cause: string }
export interface HeldRecord extends SlateBase { kind: "held"; job: SlateJob; from: string | null; next: string | null; cause: string }
export type SlateRecord = OrderRecord | MovedRecord | HeldRecord;

export interface SlateStore {
  records(): SlateRecord[];
  insert(record: SlateRecord): void;
  log(kind: string, data: Record<string, unknown>): void;
}

// The same shape role assignments use (src/models/assignments.ts).
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

const idOf = (n: number) => `s${n}`;
export const currentRecord = (records: readonly SlateRecord[]): SlateRecord | null => records[records.length - 1] ?? null;
// The record whose order is in force: the last approved or adjusted.
export const standingRecord = (records: readonly SlateRecord[]): OrderRecord | null =>
  [...records].reverse().find((r): r is OrderRecord => r.kind === "approved" || r.kind === "adjusted") ?? null;

function append<T extends SlateRecord>(store: SlateStore, records: readonly SlateRecord[], body: Omit<T, "id" | "at" | "supersedes">, now: string): T {
  const last = currentRecord(records);
  const record = { ...body, id: idOf(records.length + 1), at: now, ...(last ? { supersedes: last.id } : {}) } as T;
  store.insert(record);
  store.log(`slate.${record.kind}`, { ...record });
  return record;
}

export interface SlateWrite {
  kind: unknown;
  request: unknown;
  replaces: string | null;
  order: SlateOrder;
  limits: SlateLimits;
  note?: string;
}

const fingerprintOf = (w: SlateWrite) => JSON.stringify([w.kind, w.replaces, SLATE_JOBS.map((j) => w.order[j]), Object.entries(w.limits).sort(([a], [b]) => a.localeCompare(b)), w.note ?? null]);

// Records a proposed, approved or adjusted order. A retry of a recorded
// request comes back marked retried and writes nothing.
export function writeSlate(store: SlateStore, input: SlateWrite, now: string): OrderRecord & { retried?: true } {
  if (typeof input.request !== "string" || !input.request) throw new RuleError("slate_no_request", "a slate write needs a request id, made once by the client", 400, "send a request id of 8 to 64 letters, digits, - or _");
  if (!REQUEST_ID.test(input.request)) throw new RuleError("slate_bad_request", "the request id is 8 to 64 letters, digits, - or _", 400, "send a request id of 8 to 64 letters, digits, - or _");
  if (!(WRITTEN_KINDS as readonly unknown[]).includes(input.kind)) throw new RuleError("slate_bad_kind", `a slate write is one of ${WRITTEN_KINDS.join(", ")}`, 400, `write one of ${WRITTEN_KINDS.join(", ")}`);
  const records = store.records();
  const fingerprint = fingerprintOf(input);
  const own = records.find((r) => r.request === input.request);
  if (own) {
    isRetryOf({ id: own.id, fingerprint: own.fingerprint }, input.request, fingerprint, null);
    return { ...(own as OrderRecord), retried: true };
  }
  const current = currentRecord(records);
  if ((current?.id ?? null) !== input.replaces) {
    throw new RuleError("slate_changed", `${current ? `${current.id} is current` : "nothing is recorded yet"}${input.replaces ? `, not ${input.replaces}` : ""}; to supersede it, name it: replaces ${current?.id ?? "null"}`, 409, `read the slate again and name ${current?.id ?? "no record"}`);
  }
  return append<OrderRecord>(store, records, {
    kind: input.kind as OrderRecord["kind"], request: input.request, fingerprint, order: input.order, limits: input.limits, ...(input.note ? { note: input.note } : {}),
  }, now);
}

// ── the day's proposal ───────────────────────────────────────────────────

const ET = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
export const easternDay = (now: string | number | Date): string => ET.format(new Date(now));

const sameOrder = (a: OrderRecord, b: { order: SlateOrder; limits: SlateLimits }) =>
  JSON.stringify([SLATE_JOBS.map((j) => a.order[j]), Object.entries(a.limits).sort()]) === JSON.stringify([SLATE_JOBS.map((j) => b.order[j]), Object.entries(b.limits).sort()]);

// The candidate order: the developer's standing role assignments for every
// project (build, review, criteria-review) where one stands; else the order in
// force for that job.
export function candidateOrder(assignments: readonly Assignment[], standing: OrderRecord | null): SlateOrder {
  const choices = (role: string) => assignments.find((a) => a.role === role && a.scope === ALL_PROJECTS)?.choices.map((c) => c.actor);
  const order = {} as SlateOrder;
  for (const job of SLATE_JOBS) {
    const own = job === "criteria-review" ? choices("criteria-review") : job.startsWith("review") ? choices("review") : choices("build");
    order[job] = own ?? standing?.order[job] ?? [];
  }
  return order;
}

// The first call of an Eastern day records proposed, or approved "unchanged
// from sN" when the candidate equals the order and limits in force. Any later
// call that day records nothing. Returns the record written, or null.
export function proposeToday(store: SlateStore, candidate: { order: SlateOrder; limits: SlateLimits }, now: string): OrderRecord | null {
  const records = store.records();
  const day = easternDay(now);
  if (records.some((r) => r.kind !== "moved" && r.kind !== "held" && r.day === day)) return null;
  const standing = standingRecord(records);
  const unchanged = standing !== null && sameOrder(standing, candidate);
  return append<OrderRecord>(store, records, {
    kind: unchanged ? "approved" : "proposed", request: `day-${day}`, order: candidate.order, limits: candidate.limits, day,
    ...(unchanged ? { note: `unchanged from ${standing!.id}` } : {}),
  }, now);
}

// ── the effective pick ───────────────────────────────────────────────────

// What the pick depends on, as the ledger reads it.
export interface SlateWorld {
  pool: readonly ModelEntry[];
  reports: readonly UsageReport[];
  offers: readonly SeenOffer[];
  pauses: readonly ProviderPause[];
}

export type Picks = Record<SlateJob, { pick: string | null; next: string | null }>;

// The slate for a project (or for no project: "*", no limits) from the order
// in force, at `now`. With no approved record there is no slate: null.
export function slateAt(store: SlateStore, world: SlateWorld, now: number, opts: { project?: string; limits?: SlateLimits; authors?: readonly string[] } = {}): { standing: OrderRecord; slate: Slate } | null {
  const standing = standingRecord(store.records());
  if (!standing) return null;
  const live = liveOffers(world.offers, new Date(now));
  const project = opts.project ?? "*";
  const slate = buildSlate({
    approved: { order: standing.order }, pool: world.pool, project, policy: {} as ProjectPolicy,
    readings: readingsFor(world.reports, now), offers: live.length ? live : null,
    readiness: Object.fromEntries(live.map((o) => [o.runner, (o as { readiness?: Readiness }).readiness ?? null])),
    pauses: world.pauses.filter((p) => Date.parse(p.resetAt) > now),
    limits: opts.limits?.[project] ?? null, authors: opts.authors ?? [], now,
  });
  return { standing, slate };
}

// The pick of each job now, none (null) with no approved record. `next` is
// the first pending proposal, which a held record names.
export function effectivePicks(store: SlateStore, world: SlateWorld, now: number): Picks {
  const read = slateAt(store, world, now);
  const out = {} as Picks;
  for (const job of SLATE_JOBS) out[job] = { pick: read?.slate[job].recommended ?? null, next: read?.slate[job].proposals[0]?.actor ?? null };
  return out;
}

// After a write that may have changed picks: one moved record for each job
// whose pick changed to another model, one held record for each that fell to
// none. The caller runs this in the same transaction as the write.
export function recordPickChanges(store: SlateStore, before: Picks, after: Picks, cause: string, now: string): void {
  for (const job of SLATE_JOBS) {
    const from = before[job].pick, to = after[job].pick;
    if (from === to) continue;
    const records = store.records();
    if (to === null) append<HeldRecord>(store, records, { kind: "held", job, from, next: after[job].next, cause }, now);
    else append<MovedRecord>(store, records, { kind: "moved", job, from, to, cause }, now);
  }
}
