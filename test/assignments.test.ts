import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALL_PROJECTS, applicableAssignments, assignmentHistory, checkEvidence, cleanAssignmentInput, currentAssignments,
  assignmentSnapshot, choiceMatches, FALLBACK, isRetryOf, isWithdrawalRetry, orderByAssignment, seedProject, snapshotApplies, parseEvidenceRef, recordAssignment, resolveChoices, reviewRoles, standingFor, withdrawAssignment,
  type Assignment, type AssignmentRecord, type AssignmentStore, type ResolvedAssignment,
} from "../src/models/assignments.ts";
import type { ModelEntry } from "../src/models/pool.ts";
import { typedActor } from "../src/models/identity.ts";

// Role assignments (t622, src/models/assignments.ts): the developer's dated
// judgements of which model does what, with evidence, kept as immutable
// records that routing reads. These tests hold the rules on what a record
// says, how records supersede and withdraw one another, and how a reader
// orders its candidates by them.

const OWNER = "pavi";
const AT = "2026-10-13T12:00:00.000Z";
const entry = (harness: ModelEntry["harness"], id: string, change: Partial<ModelEntry> = {}): ModelEntry => ({
  id, harness, where: "cloud", provider: "subscription", aliases: [], family: "other", note: "", addedBy: OWNER, addedAt: AT, ...change,
});
const POOL: ModelEntry[] = [
  entry("codex", "gpt-6-astra", { family: "openai" }),
  entry("claude-code", "opus-5.5", { family: "anthropic", aliases: ["claude-opus-5-5"] }),
  entry("antigravity", "claude-opus-5.5", { family: "anthropic" }),
  entry("antigravity", "gemini-4-argon", { family: "google" }),
  entry("zcode", "glm-5.3", { family: "zai", roles: ["review"] }),
];

function memoryStore(owner = OWNER): AssignmentStore & { rows: AssignmentRecord[]; events: { kind: string; data: Record<string, unknown> }[] } {
  const rows: AssignmentRecord[] = [];
  const events: { kind: string; data: Record<string, unknown> }[] = [];
  return { rows, events, owner, records: () => rows.map((r) => structuredClone(r)), insert: (r) => void rows.push(structuredClone(r)), log: (kind, data) => void events.push({ kind, data }) };
}

let requests = 0;
const input = (change: Partial<ResolvedAssignment> = {}): ResolvedAssignment => ({
  request: `req-${++requests}-0000`, scope: ALL_PROJECTS, role: "security-review", choices: resolveChoices(["codex/gpt-6-astra"], POOL, "security-review"),
  reason: "Every finding it raised on the fast-land scan was real.", quote: "astra does security reviews", evidence: ["atelier/t592"], replaces: null, ...change,
});

const refused = (f: () => unknown, code: string, detail: RegExp) =>
  assert.throws(f, (e: Error & { code?: string }) => { assert.equal(e.code, code); assert.match(e.message, detail); return true; });

test("an evidence reference names its project: PROJECT/tN or PROJECT/tN#SEQ, never a bare tN", () => {
  assert.deepEqual(parseEvidenceRef("atelier/t592"), { project: "atelier", item: "t592" });
  assert.deepEqual(parseEvidenceRef(" atelier/t592#4410 "), { project: "atelier", item: "t592", seq: 4410 });
  refused(() => parseEvidenceRef("t592"), "bad_evidence", /names no project.*atelier\/t592/);
  refused(() => parseEvidenceRef("t592#3"), "bad_evidence", /names no project/);
  refused(() => parseEvidenceRef("atelier/592"), "bad_evidence", /not PROJECT\/tN/);
  refused(() => parseEvidenceRef("atelier/t0"), "bad_evidence", /not PROJECT\/tN/);
  refused(() => parseEvidenceRef("a/b/t1"), "bad_evidence", /not PROJECT\/tN/);
});

test("cleanAssignmentInput needs a role, ordered choices, a reason, the developer's words and evidence", () => {
  const body = { role: "review", choices: "codex/gpt-6-astra, antigravity/gemini-4-argon", reason: " Precise\nfindings ", quote: "use astra", evidence: ["atelier/t592", "atelier/t593#12"], request: "request-0001" };
  assert.deepEqual(cleanAssignmentInput(body), {
    request: "request-0001", scope: ALL_PROJECTS, role: "review", choices: ["codex/gpt-6-astra", "antigravity/gemini-4-argon"], reason: "Precise findings", quote: "use astra",
    evidence: [{ project: "atelier", item: "t592" }, { project: "atelier", item: "t593", seq: 12 }], replaces: null,
  });
  assert.equal(cleanAssignmentInput({ ...body, scope: "atelier", replaces: "a3" }).scope, "atelier");
  assert.equal(cleanAssignmentInput({ ...body, replaces: "none" }).replaces, null);
  refused(() => cleanAssignmentInput({ ...body, role: "tier" }), "bad_role", /build, review, security-review, claims-review, plan/);
  refused(() => cleanAssignmentInput({ ...body, choices: [] }), "bad_choices", /names its choices/);
  refused(() => cleanAssignmentInput({ ...body, reason: " " }), "bad_reason", /needs a reason/);
  refused(() => cleanAssignmentInput({ ...body, quote: undefined }), "bad_quote", /developer's words/);
  refused(() => cleanAssignmentInput({ ...body, evidence: [] }), "bad_evidence", /rests on evidence/);
  refused(() => cleanAssignmentInput({ ...body, evidence: ["t592"] }), "bad_evidence", /names no project/);
  refused(() => cleanAssignmentInput({ ...body, replaces: "d3" }), "bad_replaces", /such as a3/);
  refused(() => cleanAssignmentInput({ ...body, scope: "a/b" }), "bad_scope", /project's name/);
});

test("choices resolve to pool entries with one canonical model; ambiguous, unknown, repeated and role-restricted names are refused", () => {
  assert.deepEqual(resolveChoices(["claude-code/claude-opus-5-5", "antigravity/claude-opus-5.5"], POOL, "build"), [
    { actor: "claude-code/opus-5.5", model: "opus-5.5" },
    // The same model under another harness is the same model, the harness its condition.
    { actor: "antigravity/claude-opus-5.5", model: "opus-5.5" },
  ]);
  refused(() => resolveChoices(["opus-5.5"], POOL, "build"), "bad_choices", /names no harness; the pool runs it as claude-code\/opus-5.5/);
  refused(() => resolveChoices(["codex/gpt-6-luna"], POOL, "review"), "bad_choices", /not a model in the pool/);
  refused(() => resolveChoices(["codex/gpt-6-astra", "codex/GPT-6-Astra"], POOL, "review"), "bad_choices", /named twice/);
  refused(() => resolveChoices(["zcode/glm-5.3"], POOL, "build"), "bad_choices", /cannot take build: not a builder; its roles are review/);
  const twin = [...POOL, entry("claude-code", "claude-opus-5-5", { family: "anthropic" })];
  refused(() => resolveChoices(["claude-code/claude-opus-5.5"], twin, "build"), "bad_choices", /ambiguous: the pool has claude-code\/opus-5.5 and claude-code\/claude-opus-5-5/);
  // A paused or reserved choice is recorded: the standing is temporary, and routing skips it while it holds.
  assert.equal(resolveChoices(["codex/gpt-6-astra"], [entry("codex", "gpt-6-astra", { state: "paused" })], "review").length, 1);
});

// gpt-6-astra's second review of t622 (finding 1): with Astra's aliases
// naming gpt-6-luna, assigning the exact codex/gpt-6-luna recorded the
// canonical model gpt-6-astra, and routing then promoted Astra.
test("an exact pool id wins over another entry's alias, in the choice and in its canonical model", () => {
  const pool = [entry("codex", "gpt-6-astra", { family: "openai", aliases: ["gpt-6-luna"] }), entry("codex", "gpt-6-luna", { family: "openai" })];
  const [luna] = resolveChoices(["codex/gpt-6-luna"], pool, "review");
  assert.deepEqual(luna, { actor: "codex/gpt-6-luna", model: "gpt-6-luna" });
  const a: Assignment = { id: "a1", kind: "assigned", scope: ALL_PROJECTS, role: "review", choices: [luna], reason: "r", quote: "q", evidence: [], by: OWNER, at: AT };
  const r = orderByAssignment(["codex/gpt-6-astra", "codex/gpt-6-luna"], (c) => c, [a], () => null, FALLBACK.review);
  assert.deepEqual(r.order, ["codex/gpt-6-luna", "codex/gpt-6-astra"]);
});

// gpt-6-astra's second review of t622 (finding 4): the init installed its
// snapshot before registering the project, so a withdrawal broadcast in
// between never reached it, and the project kept the withdrawn assignment.
test("a project is registered before its snapshot is read, so a withdrawal at any point in its initialisation reaches it", async () => {
  for (const at of ["after-register", "after-read"] as const) {
    const store = memoryStore();
    recordAssignment(store, OWNER, input(), AT);
    const registered = new Set<string>();
    let held: ReturnType<typeof assignmentSnapshot> | null = null;
    const install = (s: ReturnType<typeof assignmentSnapshot>) => { if (snapshotApplies(held, s)) held = s; };
    // A withdrawal broadcasts to every project registered when it runs.
    const withdraw = () => { withdrawAssignment(store, OWNER, "a1", "withdrawn", AT); if (registered.has("p")) install(assignmentSnapshot(store.records())); };
    await seedProject({
      register: async () => { registered.add("p"); if (at === "after-register") withdraw(); },
      snapshot: async () => { const s = assignmentSnapshot(store.records()); if (at === "after-read") withdraw(); return s; },
      install: async (s) => install(s),
    });
    assert.deepEqual(held!.assignments, [], at);
  }
});

test("evidence is checked to exist and kept by the project's stable key, so a former name resolves", async () => {
  const projects: Record<string, { key: string; registered: boolean }> = { atelier: { key: "atelier", registered: true }, "old-name": { key: "atelier", registered: true } };
  const project = async (name: string) => projects[name] ?? { key: name, registered: false };
  const exists = async (_key: string, item: string, seq?: number) => (item === "t592" && (seq === undefined || seq === 7) ? null : seq ? `event ${seq} is not one of ${item}'s` : `no task ${item}`);
  assert.deepEqual(await checkEvidence([parseEvidenceRef("old-name/t592"), parseEvidenceRef("atelier/t592"), parseEvidenceRef("atelier/t592#7")], project, exists), ["atelier/t592", "atelier/t592#7"]);
  await assert.rejects(checkEvidence([parseEvidenceRef("nowhere/t1")], project, exists), /evidence nowhere\/t1: no project nowhere/);
  await assert.rejects(checkEvidence([parseEvidenceRef("atelier/t9")], project, exists), /evidence atelier\/t9: no task t9/);
  await assert.rejects(checkEvidence([parseEvidenceRef("atelier/t592#8")], project, exists), /event 8 is not one of t592's/);
});

test("only the developer records an assignment; it is dated by the server and names its acting model", () => {
  const store = memoryStore();
  refused(() => recordAssignment(store, "codex/gpt-6-astra", input(), AT), "not_project_owner", /only the developer assigns a role/);
  const a = recordAssignment(store, OWNER, input(), AT, "claude-code/opus-5.5");
  assert.equal(a.id, "a1");
  assert.equal(a.at, AT);
  assert.equal(a.acting, "claude-code/opus-5.5");
  assert.equal(a.supersedes, undefined);
  assert.deepEqual(store.events.map((e) => e.kind), ["assignment.recorded"]);
  assert.equal(store.events[0].data.acting, "claude-code/opus-5.5");
});

test("a new assignment supersedes the standing one only by naming it; a stale or missing name is refused (concurrent updates)", () => {
  const store = memoryStore();
  recordAssignment(store, OWNER, input(), AT);
  // Two sessions both saw nothing standing; the second is refused.
  refused(() => recordAssignment(store, OWNER, input({ reason: "Another view." }), AT), "assignment_changed", /a1 stands for security-review in every project.*--replaces a1/);
  const a2 = recordAssignment(store, OWNER, input({ reason: "Second view.", replaces: "a1" }), "2026-10-14T09:00:00.000Z");
  assert.equal(a2.supersedes, "a1");
  // Two sessions both read "a1 stands"; the one that comes second is refused, naming a2.
  refused(() => recordAssignment(store, OWNER, input({ reason: "Third view.", replaces: "a1" }), AT), "assignment_changed", /a2 stands for security-review in every project since 2026-10-14, not a1/);
  // Another scope or role is another key: nothing stands there.
  assert.equal(recordAssignment(store, OWNER, input({ scope: "atelier" }), AT).supersedes, undefined);
  refused(() => recordAssignment(store, OWNER, input({ role: "review", replaces: "a2" }), AT), "assignment_changed", /a2 does not stand for review in every project/);
});

test("a retried request finds its own record and gets it back, recorded once", () => {
  const store = memoryStore();
  recordAssignment(store, OWNER, input({ request: "first-request" }), AT);
  const again = recordAssignment(store, OWNER, input({ request: "first-request" }), "2026-10-13T12:00:05.000Z");
  assert.equal(again.id, "a1");
  assert.equal(again.retried, true);
  const a2 = recordAssignment(store, OWNER, input({ request: "second-request", reason: "Changed.", replaces: "a1" }), AT);
  // The retry of the superseding request carries the same request id: it finds a2.
  assert.equal(recordAssignment(store, OWNER, input({ request: "second-request", reason: "Changed.", replaces: "a1" }), AT).id, a2.id);
  assert.equal(store.rows.length, 2);
  assert.equal(store.events.length, 2);
  // The same request id with other content is refused, never read as a retry.
  refused(() => recordAssignment(store, OWNER, input({ request: "second-request", reason: "Other." }), AT), "request_reused", /second-request already recorded a2/);
});

// gpt-6-astra's review of t622 at 53bf739d, finding 2: create a1, withdraw it
// as a2, resend the original request, and the server made a3 current: a
// delayed retry undid a withdrawal without a new decision.
test("a retry of a request whose assignment was since withdrawn returns the stored record and reactivates nothing", () => {
  const store = memoryStore();
  recordAssignment(store, OWNER, input({ request: "original-request" }), AT);
  withdrawAssignment(store, OWNER, "a1", "Astra is reserved.", AT);
  const replay = recordAssignment(store, OWNER, input({ request: "original-request" }), AT);
  assert.deepEqual([replay.id, replay.retried], ["a1", true]);
  assert.equal(standingFor(store.records(), ALL_PROJECTS, "security-review"), null);
  assert.equal(store.rows.length, 2);
  // A new decision with the same content is a new request, and is recorded.
  assert.equal(recordAssignment(store, OWNER, input({ request: "a-new-decision" }), AT).id, "a3");
});

test("cleanAssignmentInput needs a request id, so a retry can be told from a new decision", () => {
  const body = { role: "review", choices: "codex/gpt-6-astra", reason: "r", quote: "q", evidence: "atelier/t1" };
  refused(() => cleanAssignmentInput(body), "bad_request_id", /request id/);
  refused(() => cleanAssignmentInput({ ...body, request: "x" }), "bad_request_id", /request id/);
  assert.equal(cleanAssignmentInput({ ...body, request: "0b9f6c1e-request" }).request, "0b9f6c1e-request");
});

// gpt-6-astra's review of t622 at 53bf739d, finding 1: two broadcasts read at
// different times can arrive in either order, and an older one replaced a
// newer copy, restoring a superseded or withdrawn assignment.
test("a project's copy takes a snapshot only when it is no older than the one it holds", () => {
  const store = memoryStore();
  recordAssignment(store, OWNER, input(), AT);
  const old = assignmentSnapshot(store.records());
  withdrawAssignment(store, OWNER, "a1", "withdrawn", AT);
  const now = assignmentSnapshot(store.records());
  assert.deepEqual([old.version, old.assignments.map((a) => a.id)], [1, ["a1"]]);
  assert.deepEqual([now.version, now.assignments], [2, []]);
  assert.equal(snapshotApplies(now, old), false);
  assert.equal(snapshotApplies(old, now), true);
  assert.equal(snapshotApplies(null, old), true);
  assert.equal(snapshotApplies(now, now), true);
});

test("withdrawal needs a note, restores the fallback rather than the superseded record, and keeps the evidence and author", () => {
  const store = memoryStore();
  recordAssignment(store, OWNER, input(), AT, "claude-code/opus-5.5");
  recordAssignment(store, OWNER, input({ reason: "Second view.", choices: resolveChoices(["antigravity/gemini-4-argon"], POOL, "security-review"), evidence: ["atelier/t604"], replaces: "a1" }), AT);
  refused(() => withdrawAssignment(store, OWNER, "a2", " ", AT), "bad_note", /needs a note/);
  refused(() => withdrawAssignment(store, "codex/gpt-6-astra", "a2", "why", AT), "not_project_owner", /withdraws a role assignment/);
  refused(() => withdrawAssignment(store, OWNER, "a1", "why", AT), "not_standing", /a1 was superseded by a2.*withdraw a2/);
  refused(() => withdrawAssignment(store, OWNER, "a9", "why", AT), "no_assignment", /no assignment a9/);
  const w = withdrawAssignment(store, OWNER, "a2", "Argon missed real defects on t593.", AT, "codex/gpt-6-astra");
  assert.deepEqual({ id: w.id, withdraws: w.withdraws, acting: w.acting }, { id: "a3", withdraws: "a2", acting: "codex/gpt-6-astra" });
  // Nothing stands now; a1 does not come back.
  assert.equal(standingFor(store.records(), ALL_PROJECTS, "security-review"), null);
  assert.deepEqual(currentAssignments(store.records()), []);
  // A retry of the withdrawal is answered with it; another note is refused.
  // A retry names the same acting model (gpt-6-astra's fourth review, finding 3).
  assert.equal(withdrawAssignment(store, OWNER, "a2", "Argon missed real defects on t593.", AT, "codex/gpt-6-astra").retried, true);
  refused(() => withdrawAssignment(store, OWNER, "a2", "other", AT), "not_standing", /withdrawn on 2026-10-13 \(a3\)/);
  const history = assignmentHistory(store.records());
  assert.deepEqual(history.map((v) => [v.id, v.status]), [["a1", "superseded"], ["a2", "withdrawn"]]);
  assert.deepEqual(history[0].evidence, ["atelier/t592"]);
  assert.equal(history[0].acting, "claude-code/opus-5.5");
  assert.equal(history[1].withdrawal?.note, "Argon missed real defects on t593.");
  // A new assignment after the withdrawal stands with nothing to replace.
  assert.equal(recordAssignment(store, OWNER, input({ reason: "Back to astra." }), AT).supersedes, undefined);
});

// gpt-6-astra's sixth review of t622, follow-up 3: this test read literal
// fields without renaming anything. The project is now renamed (its name
// moves to a new one over the same key) and the model removed from the pool
// before the history and the routing are read.
test("after its project is renamed and its model removed, an assignment keeps its key and choice, and routing passes it over", async () => {
  const names = new Map([["old-name", "k1"]]);
  const resolve = async (name: string) => (names.has(name) ? { key: names.get(name)!, registered: true } : { key: name, registered: false });
  const exists = async () => null;
  const store = memoryStore();
  const evidence = await checkEvidence([parseEvidenceRef("old-name/t5#9")], resolve, exists);
  recordAssignment(store, OWNER, input({ scope: "k1", role: "review", evidence, choices: resolveChoices(["antigravity/gemini-4-argon"], POOL, "review") }), AT);
  // The rename: the project answers to its new name, under the same key.
  names.delete("old-name");
  names.set("new-name", "k1");
  assert.deepEqual(await checkEvidence([parseEvidenceRef("new-name/t5#9")], resolve, exists), ["k1/t5#9"]);
  await assert.rejects(checkEvidence([parseEvidenceRef("old-name/t5#9")], resolve, exists), /no project old-name/);
  // The removal: the pool no longer has Argon.
  const pool = POOL.filter((e) => e.id !== "gemini-4-argon");
  const [view] = assignmentHistory(store.records());
  assert.deepEqual([view.scope, view.evidence, view.choices.map((c) => c.actor), view.status], ["k1", ["k1/t5#9"], ["antigravity/gemini-4-argon"], "current"]);
  // Routing in the renamed project reads it by its key, and passes over the removed choice to the fallback.
  const bearing = applicableAssignments(currentAssignments(store.records()), "k1", ["review"]);
  assert.deepEqual(bearing.map((a) => a.id), [view.id]);
  const r = orderByAssignment(pool.map((e) => `${e.harness}/${e.id}`), (c) => c, bearing, () => null, FALLBACK.review);
  assert.equal(r.outcome.applied, null);
  assert.match(r.outcome.skipped[0].why, /antigravity\/gemini-4-argon: not a candidate here/);
  assert.match(r.outcome.lines.join("\n"), /No role assignment applies, so the reviewer selector/);
});

test("applicable assignments go most specific first: the role's own, then review; this project's, then every project's", () => {
  const a = (id: string, role: Assignment["role"], scope: string): Assignment => ({ id, kind: "assigned", scope, role, choices: [], reason: "", quote: "", evidence: [], by: OWNER, at: AT });
  const current = [a("a1", "review", ALL_PROJECTS), a("a2", "security-review", ALL_PROJECTS), a("a3", "review", "atelier"), a("a4", "security-review", "other")];
  assert.deepEqual(applicableAssignments(current, "atelier", reviewRoles({ sensitive: true })).map((x) => x.id), ["a2", "a3", "a1"]);
  assert.deepEqual(applicableAssignments(current, "atelier", reviewRoles({})).map((x) => x.id), ["a3", "a1"]);
  assert.deepEqual(applicableAssignments(current, "other", ["security-review"]).map((x) => x.id), ["a4", "a2"]);
  // A project ledger's copy is already narrowed to the project: any named scope is its own.
  assert.deepEqual(applicableAssignments([a("a3", "review", "atelier"), a("a1", "review", ALL_PROJECTS)], null, ["review"]).map((x) => x.id), ["a3", "a1"]);
  assert.deepEqual(reviewRoles({ docs: true }), ["claims-review", "review"]);
});

test("orderByAssignment moves only eligible choices first, in its order; with none eligible it falls back and says why", () => {
  const store = memoryStore();
  const a1 = recordAssignment(store, OWNER, input({ role: "review", choices: resolveChoices(["antigravity/gemini-4-argon", "codex/gpt-6-astra"], POOL, "review") }), AT);
  const candidates = ["zcode/glm-5.3", "codex/gpt-6-astra", "antigravity/gemini-4-argon"];
  const held = new Set(["antigravity/gemini-4-argon"]);
  const r = orderByAssignment(candidates, (c) => c, [a1], (c) => (held.has(c) ? "paused since 2026-10-13 (the developer's standing)" : null), FALLBACK.review);
  // Argon is paused: it is not moved, and astra, the next choice, goes first.
  assert.deepEqual(r.order, ["codex/gpt-6-astra", "zcode/glm-5.3", "antigravity/gemini-4-argon"]);
  assert.equal(r.outcome.applied, "a1");
  assert.match(r.outcome.lines.join("\n"), /Role assignment a1 \(review, every project, 2026-10-13\) puts codex\/gpt-6-astra first/);
  assert.match(r.outcome.lines.join("\n"), /antigravity\/gemini-4-argon: paused since/);
  assert.match(r.promoted("codex/gpt-6-astra")!, /choice 2 of 2 for review/);
  assert.equal(r.promoted("zcode/glm-5.3"), null);
  // Every choice ineligible: the order is untouched and the fallback is named.
  const none = orderByAssignment(candidates, (c) => c, [a1], (c) => (c === "zcode/glm-5.3" ? null : "same family as the builder"), FALLBACK.review);
  assert.deepEqual(none.order, candidates);
  assert.equal(none.outcome.applied, null);
  assert.deepEqual(none.outcome.skipped.map((s) => s.id), ["a1"]);
  assert.match(none.outcome.lines.join("\n"), /No role assignment applies, so the reviewer selector asks/);
  // No assignment at all says nothing.
  assert.deepEqual(orderByAssignment(candidates, (c) => c, [], () => null, FALLBACK.review).outcome.lines, []);
});

// gpt-6-astra's and gemini-4-argon's eighth reviews of t622: readers no
// longer read aliases. A name typed under an alias is converted where it
// enters (typedActor), and the reader matches the exact id it became.
test("a candidate is the choice by its exact id, an alias converted where typed; the same model under another harness is not", () => {
  const store = memoryStore();
  const a1 = recordAssignment(store, OWNER, input({ role: "build", choices: resolveChoices(["claude-code/opus-5.5"], POOL, "build") }), AT);
  const typed = typedActor(POOL, "claude-code/Claude-Opus-5-5");
  assert.equal(typed, "claude-code/opus-5.5");
  const r = orderByAssignment(["antigravity/claude-opus-5.5", typed], (c) => c, [a1], () => null, FALLBACK.build);
  assert.deepEqual(r.order, ["claude-code/opus-5.5", "antigravity/claude-opus-5.5"]);
  // The alias itself, reaching a reader unconverted, is no choice.
  assert.equal(choiceMatches(a1.choices[0], "claude-code/claude-opus-5-5"), false);
});

// gemini-4-argon's third review of t622, finding 2: two entries in one
// harness that share a model were one candidate to choiceMatches, so
// assigning the second by its id promoted the first.
test("an assignment naming one of two entries that share a model in a harness promotes that entry", () => {
  const twin = [...POOL, entry("claude-code", "claude-opus-5-5", { family: "anthropic" })];
  const [chosen] = resolveChoices(["claude-code/claude-opus-5-5"], twin, "build");
  assert.equal(chosen.actor, "claude-code/claude-opus-5-5");
  const a: Assignment = { id: "a1", kind: "assigned", scope: ALL_PROJECTS, role: "build", choices: [chosen], reason: "r", quote: "q", evidence: [], by: OWNER, at: AT };
  assert.deepEqual(orderByAssignment(["claude-code/opus-5.5", "claude-code/claude-opus-5-5"], (c) => c, [a], () => null, FALLBACK.build).order, ["claude-code/claude-opus-5-5", "claude-code/opus-5.5"]);
  // The one named is paused: the other entry is not moved in its place.
  const held = orderByAssignment(["claude-code/opus-5.5", "claude-code/claude-opus-5-5"], (c) => c, [a], (c) => (c === "claude-code/claude-opus-5-5" ? "paused" : null), FALLBACK.build);
  assert.equal(held.outcome.applied, null);
  // Two profiles of one model are two entries too.
  const profiles = [entry("opencode", "qwen-3:32b"), entry("opencode", "qwen-3:72b")];
  const [big] = resolveChoices(["opencode/qwen-3:72b"], profiles, "build");
  const b: Assignment = { ...a, choices: [big] };
  assert.deepEqual(orderByAssignment(["opencode/qwen-3:32b", "opencode/qwen-3:72b"], (c) => c, [b], () => null, FALLBACK.build).order, ["opencode/qwen-3:72b", "opencode/qwen-3:32b"]);
  // A reader compares exact ids case-sensitively; another letter case is
  // converted where it is typed (gpt-6-astra's seventeenth review of t622).
  assert.equal(choiceMatches(chosen, "claude-code/claude-opus-5-5"), true);
  assert.equal(choiceMatches(chosen, "claude-code/Claude-Opus-5-5"), false);
});

// gpt-6-astra's third review of t622, finding 4: a retry was validated
// against the pool before its record was read, so an acting model removed
// since failed it. It is judged against what was recorded.
test("a retry is the same content by the same acting model as recorded; anything else reusing the id is refused", () => {
  const prior = { id: "a4", fingerprint: "fp", acting: "claude-code/opus-5.5" };
  assert.equal(isRetryOf(prior, "req-1", "fp", "claude-code/opus-5.5"), true);
  // The declared text is compared exactly: another letter case may be another
  // pool entry (gpt-6-astra's nineteenth review of t622, finding 2).
  refused(() => isRetryOf(prior, "req-1", "fp", "Claude-Code/opus-5.5"), "request_reused", /acting as claude-code\/opus-5.5, not Claude-Code\/opus-5.5/);
  refused(() => isRetryOf(prior, "req-1", "other", "claude-code/opus-5.5"), "request_reused", /already recorded a4, with other content/);
  refused(() => isRetryOf(prior, "req-1", "fp", null), "request_reused", /acting as claude-code\/opus-5.5, not nobody/);
  assert.equal(isWithdrawalRetry({ note: "Reserved this week.", acting: "codex/gpt-6-astra" }, " Reserved this week. ", "codex/gpt-6-astra"), true);
  assert.equal(isWithdrawalRetry({ note: "Reserved this week." }, "Another note", null), false);
  assert.equal(isWithdrawalRetry({ note: "Reserved this week." }, "Reserved this week.", "codex/gpt-6-astra"), false);
});

// gpt-6-astra's fourth review of t622, finding 3: the stored retry paths
// ignored the acting model, so two requests racing past the route's lookup,
// or a withdrawal sent again by another acting model, were answered as one.
test("the stored retry of an assignment or a withdrawal is the same acting model's, or refused", () => {
  const store = memoryStore();
  const first = input({ fingerprint: "fp-1" });
  const a = recordAssignment(store, OWNER, first, AT, "claude-code/opus-5.5");
  assert.equal(recordAssignment(store, OWNER, first, AT, "claude-code/opus-5.5").retried, true);
  refused(() => recordAssignment(store, OWNER, first, AT, "Claude-Code/opus-5.5"), "request_reused", /not Claude-Code\/opus-5.5/);
  refused(() => recordAssignment(store, OWNER, first, AT, "codex/gpt-6-astra"), "request_reused", /acting as claude-code\/opus-5.5, not codex\/gpt-6-astra/);
  refused(() => recordAssignment(store, OWNER, first, AT, null), "request_reused", /not nobody/);
  // A record kept without a fingerprint is matched by its content and acting model too.
  const legacy = input();
  recordAssignment(store, OWNER, { ...legacy, replaces: a.id }, AT, "claude-code/opus-5.5");
  refused(() => recordAssignment(store, OWNER, { ...legacy, replaces: a.id }, AT, "codex/gpt-6-astra"), "request_reused", /another acting model/);
  const w = withdrawAssignment(store, OWNER, store.rows.at(-1)!.id, "Done with it.", AT, "claude-code/opus-5.5");
  assert.equal(withdrawAssignment(store, OWNER, w.withdraws, "Done with it.", AT, "claude-code/opus-5.5").retried, true);
  refused(() => withdrawAssignment(store, OWNER, w.withdraws, "Done with it.", AT, "codex/gpt-6-astra"), "not_standing", /acting as claude-code\/opus-5.5/);
});
