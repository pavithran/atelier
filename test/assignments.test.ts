import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALL_PROJECTS, applicableAssignments, assignmentHistory, assignmentLine, checkEvidence, cleanAssignmentInput, currentAssignments,
  FALLBACK, orderByAssignment, parseEvidenceRef, recordAssignment, resolveChoices, reviewRoles, standingFor, withdrawAssignment,
  type Assignment, type AssignmentRecord, type AssignmentStore, type ResolvedAssignment,
} from "../src/models/assignments.ts";
import type { ModelEntry } from "../src/models/pool.ts";

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

const input = (change: Partial<ResolvedAssignment> = {}): ResolvedAssignment => ({
  scope: ALL_PROJECTS, role: "security-review", choices: resolveChoices(["codex/gpt-6-astra"], POOL, "security-review"),
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
  const body = { role: "review", choices: "codex/gpt-6-astra, antigravity/gemini-4-argon", reason: " Precise\nfindings ", quote: "use astra", evidence: ["atelier/t592", "atelier/t593#12"] };
  assert.deepEqual(cleanAssignmentInput(body), {
    scope: ALL_PROJECTS, role: "review", choices: ["codex/gpt-6-astra", "antigravity/gemini-4-argon"], reason: "Precise findings", quote: "use astra",
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
  recordAssignment(store, OWNER, input(), AT);
  const again = recordAssignment(store, OWNER, input(), "2026-10-13T12:00:05.000Z");
  assert.equal(again.id, "a1");
  assert.equal(again.retried, true);
  const a2 = recordAssignment(store, OWNER, input({ reason: "Changed.", replaces: "a1" }), AT);
  // The retry of the superseding request carries the same replaces: it finds a2.
  assert.equal(recordAssignment(store, OWNER, input({ reason: "Changed.", replaces: "a1" }), AT).id, a2.id);
  assert.equal(store.rows.length, 2);
  assert.equal(store.events.length, 2);
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
  assert.equal(withdrawAssignment(store, OWNER, "a2", "Argon missed real defects on t593.", AT).retried, true);
  refused(() => withdrawAssignment(store, OWNER, "a2", "other", AT), "not_standing", /withdrawn on 2026-10-13 \(a3\)/);
  const history = assignmentHistory(store.records());
  assert.deepEqual(history.map((v) => [v.id, v.status]), [["a1", "superseded"], ["a2", "withdrawn"]]);
  assert.deepEqual(history[0].evidence, ["atelier/t592"]);
  assert.equal(history[0].acting, "claude-code/opus-5.5");
  assert.equal(history[1].withdrawal?.note, "Argon missed real defects on t593.");
  // A new assignment after the withdrawal stands with nothing to replace.
  assert.equal(recordAssignment(store, OWNER, input({ reason: "Back to astra." }), AT).supersedes, undefined);
});

test("the history reads a renamed project and a removed model under what they are now", () => {
  const store = memoryStore();
  recordAssignment(store, OWNER, input({ scope: "old-key", evidence: ["old-key/t5#9"] }), AT);
  const [view] = assignmentHistory(store.records());
  const line = assignmentLine(view, new Map([["old-key", "atelier"]]), POOL.filter((e) => e.id !== "gpt-6-astra"));
  assert.match(line, /^a1 2026-10-13 security-review in atelier: codex\/gpt-6-astra \(not in the pool now\)\. Why: /);
  assert.match(line, /Evidence: atelier\/t5#9\./);
  assert.match(line, /The developer's words: “astra does security reviews” Recorded by pavi\.$/);
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
  const r = orderByAssignment(candidates, (c) => c, [a1], (c) => (held.has(c) ? "paused since 2026-10-13 (the developer's standing)" : null), FALLBACK.review, POOL);
  // Argon is paused: it is not moved, and astra, the next choice, goes first.
  assert.deepEqual(r.order, ["codex/gpt-6-astra", "zcode/glm-5.3", "antigravity/gemini-4-argon"]);
  assert.equal(r.outcome.applied, "a1");
  assert.match(r.outcome.lines.join("\n"), /Role assignment a1 \(review, every project, 2026-10-13\) puts codex\/gpt-6-astra first/);
  assert.match(r.outcome.lines.join("\n"), /antigravity\/gemini-4-argon: paused since/);
  assert.match(r.promoted("codex/gpt-6-astra")!, /choice 2 of 2 for review/);
  assert.equal(r.promoted("zcode/glm-5.3"), null);
  // Every choice ineligible: the order is untouched and the fallback is named.
  const none = orderByAssignment(candidates, (c) => c, [a1], (c) => (c === "zcode/glm-5.3" ? null : "same family as the builder"), FALLBACK.review, POOL);
  assert.deepEqual(none.order, candidates);
  assert.equal(none.outcome.applied, null);
  assert.deepEqual(none.outcome.skipped.map((s) => s.id), ["a1"]);
  assert.match(none.outcome.lines.join("\n"), /No role assignment applies, so the reviewer selector asks/);
  // No assignment at all says nothing.
  assert.deepEqual(orderByAssignment(candidates, (c) => c, [], () => null, FALLBACK.review).outcome.lines, []);
});

test("a candidate under an alias or another letter case is the choice; the same model under another harness is not", () => {
  const store = memoryStore();
  const a1 = recordAssignment(store, OWNER, input({ role: "build", choices: resolveChoices(["claude-code/opus-5.5"], POOL, "build") }), AT);
  const r = orderByAssignment(["antigravity/claude-opus-5.5", "claude-code/Claude-Opus-5-5"], (c) => c, [a1], () => null, FALLBACK.build, POOL);
  assert.deepEqual(r.order, ["claude-code/Claude-Opus-5-5", "antigravity/claude-opus-5.5"]);
});
