import { test } from "node:test";
import assert from "node:assert/strict";
import {
  approvalStatus, approveAction, cleanApprovalInput, cleanRun, consumeAction, expirySeconds, listApprovals,
  recordActionRun, withdrawAction, type ActionStore,
} from "../src/actions.ts";
import { parseRuleError } from "../src/rules.ts";

// The rules of protected-action approvals, on an in-memory stand-in for the
// Ledger's SQLite that answers the four statements src/actions.ts makes, so
// time can be set per call. test/actions.spec.ts runs the same rules in the
// Ledger itself and through the Worker's routes.

const H1 = "a".repeat(40), H2 = "b".repeat(40);
const T0 = "2026-10-06T09:00:00.000Z";
const later = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();

function memory(owner = "owner") {
  const rows: { n: number; id: string; json: string }[] = [];
  const events: { kind: string; data: Record<string, unknown> }[] = [];
  const sql = {
    exec(query: string, ...b: unknown[]) {
      if (query.startsWith("SELECT json FROM action_approvals")) return { toArray: () => [...rows].sort((x, y) => x.n - y.n).map((r) => ({ json: r.json })) };
      if (query.startsWith("INSERT INTO action_approvals")) rows.push({ n: b[0] as number, id: b[1] as string, json: b[2] as string });
      else if (query.startsWith("UPDATE action_approvals")) rows.find((r) => r.id === b[1])!.json = b[0] as string;
      else if (!query.startsWith("CREATE TABLE IF NOT EXISTS action_approvals")) throw new Error(`unexpected statement: ${query}`);
      return { toArray: () => [] };
    },
  };
  const store = { sql, owner, log: (kind: string, data: Record<string, unknown>) => { events.push({ kind, data }); } } as unknown as ActionStore;
  return { store, events };
}

function refused(fn: () => unknown, code: string, detail?: RegExp) {
  let error: unknown;
  try { fn(); } catch (e) { error = e; }
  const rule = parseRuleError(error);
  assert.equal(rule?.code, code, `expected ${code}, got ${String(error)}`);
  if (detail) assert.match(rule!.detail, detail);
  return rule!;
}

test("an expiry is minutes, hours or days, from a minute to thirty days", () => {
  assert.equal(expirySeconds("90m"), 5400);
  assert.equal(expirySeconds("24h"), 86400);
  assert.equal(expirySeconds("7d"), 7 * 86400);
  assert.equal(expirySeconds("30d"), 30 * 86400);
  for (const bad of ["31d", "0m", "30s", "1y", "", "24", " h", 5, null]) assert.throws(() => expirySeconds(bad), /from 1m to 30d/, String(bad));
});

test("an approval request names a kind and the full revision; the note is one line", () => {
  assert.deepEqual(cleanApprovalInput({ kind: "deploy", commit: H1.toUpperCase(), note: "release\n12\u2028now" }), { kind: "deploy", commit: H1, note: "release 12 now", seconds: 86400 });
  assert.equal(cleanApprovalInput({ kind: "photos-writeback", commit: "c".repeat(64), expires: "1h" }).seconds, 3600);
  for (const kind of ["Deploy", "", "two words", "-x", "a".repeat(64), 7]) refused(() => cleanApprovalInput({ kind, commit: H1 }), "bad_kind");
  for (const commit of ["abc", "z".repeat(40), H1.slice(1), "a".repeat(65), undefined]) refused(() => cleanApprovalInput({ kind: "deploy", commit }), "bad_revision");
  refused(() => cleanApprovalInput({ kind: "deploy", commit: H1, expires: "2y" }), "bad_expiry", /from 1m to 30d/);
  refused(() => cleanApprovalInput({ kind: "deploy", commit: H1, note: 4 }), "bad_note");
});

test("the owner approves one kind at one revision, once while it stands", () => {
  const { store, events } = memory();
  const a = approveAction(store, "owner", { kind: "deploy", commit: H1, note: "release", expires: "1h" }, T0);
  assert.deepEqual({ id: a.id, status: a.status, expiresAt: a.expiresAt }, { id: "a1", status: "active", expiresAt: later(3600_000) });
  assert.deepEqual(events.at(-1), { kind: "action.approved", data: { id: "a1", kind: "deploy", commit: H1, note: "release", expiresAt: later(3600_000) } });
  refused(() => approveAction(store, "owner", { kind: "deploy", commit: H1 }, T0), "already_approved", /already approved as a1.*atelier approvals withdraw a1/);
  assert.equal(approveAction(store, "owner", { kind: "push", commit: H1 }, T0).id, "a2", "another kind at the same revision is its own approval");
  assert.equal(approveAction(store, "owner", { kind: "deploy", commit: H2 }, T0).id, "a3", "the same kind at another revision is its own approval");
  refused(() => approveAction(store, "codex/gpt-6-astra", { kind: "deploy", commit: "c".repeat(40) }, T0), "not_project_owner");
  assert.deepEqual(listApprovals(store, T0).map((x) => x.id), ["a3", "a2", "a1"], "newest first");
  // Once the first has expired, the same kind and revision can be approved again.
  assert.equal(approveAction(store, "owner", { kind: "deploy", commit: H1 }, later(3600_000)).id, "a4");
});

test("one approval, one run: a run uses it before it runs, and nothing can use it again", () => {
  const { store, events } = memory();
  approveAction(store, "owner", { kind: "deploy", commit: H1 }, T0);
  const used = consumeAction(store, "owner", { kind: "deploy", commit: H1 }, later(1000));
  assert.equal(used.status, "consumed");
  assert.deepEqual(events.at(-1), { kind: "action.consumed", data: { id: "a1", kind: "deploy", commit: H1 } });
  refused(() => consumeAction(store, "owner", { kind: "deploy", commit: H1 }, later(2000)), "not_approved", /a1 for it is consumed.*atelier approve deploy --head a{40}$/);
  assert.equal(listApprovals(store, later(3000))[0].status, "consumed");
});

test("an approval is refused for any other revision, kind, actor, or once withdrawn or expired", () => {
  const { store } = memory();
  approveAction(store, "owner", { kind: "deploy", commit: H1, expires: "1h" }, T0);
  refused(() => consumeAction(store, "owner", { kind: "deploy", commit: H2 }, T0), "not_approved", /no active approval for deploy at bbbbbbbb: deploy is approved only at another revision \(a1 at aaaaaaaa\)\. The project owner approves it with: atelier approve deploy --head b{40}/);
  refused(() => consumeAction(store, "owner", { kind: "install", commit: H1 }, T0), "not_approved", /no active approval for install at aaaaaaaa\./);
  refused(() => consumeAction(store, "codex/gpt-6-astra", { kind: "deploy", commit: H1 }, T0), "not_project_owner");
  refused(() => consumeAction(store, "owner", { kind: "deploy", commit: "abc" }, T0), "bad_request");
  refused(() => consumeAction(store, "owner", { kind: "deploy", commit: H1 }, later(3600_000)), "not_approved", /a1 for it is expired/);
  approveAction(store, "owner", { kind: "push", commit: H1 }, T0);
  withdrawAction(store, "owner", "a2", "changed my mind", T0);
  refused(() => consumeAction(store, "owner", { kind: "push", commit: H1 }, T0), "not_approved", /a2 for it is withdrawn/);
});

test("only an active approval is withdrawn, by the owner, and the withdrawal is recorded", () => {
  const { store, events } = memory();
  approveAction(store, "owner", { kind: "deploy", commit: H1 }, T0);
  refused(() => withdrawAction(store, "codex/gpt-6-astra", "a1", "", T0), "not_project_owner");
  refused(() => withdrawAction(store, "owner", "a9", "", T0), "no_approval");
  const w = withdrawAction(store, "owner", "a1", "wrong\nrevision", T0);
  assert.equal(w.status, "withdrawn");
  assert.deepEqual(w.withdrawn, { by: "owner", at: T0, note: "wrong revision" });
  assert.deepEqual(events.at(-1), { kind: "action.withdrawn", data: { id: "a1", kind: "deploy", commit: H1, note: "wrong revision" } });
  refused(() => withdrawAction(store, "owner", "a1", "", T0), "not_active", /a1 is withdrawn/);
});

test("status: used before withdrawn before expired", () => {
  const base = { id: "a1", kind: "deploy", commit: H1, note: "", by: "owner", at: T0, expiresAt: later(1000) };
  assert.equal(approvalStatus(base, T0), "active");
  assert.equal(approvalStatus(base, later(1000)), "expired");
  assert.equal(approvalStatus({ ...base, withdrawn: { by: "owner", at: T0, note: "" } }, later(5000)), "withdrawn");
  assert.equal(approvalStatus({ ...base, consumed: { by: "owner", at: T0 } }, later(5000)), "consumed");
});

test("a run record is checked field by field, and may name only an approval its kind and revision used", () => {
  const { store, events } = memory();
  const run = { step: "deploy", kind: "deploy", approval: "a1", command: "npx wrangler deploy", commit: H1, exitStatus: 0, signal: null, durationMs: 1200, passed: true, outputTail: "x".repeat(5000), ship: "s-abc" };
  refused(() => recordActionRun(store, "owner", run), "bad_run", /a1 was not used for deploy/);
  approveAction(store, "owner", { kind: "deploy", commit: H1 }, T0);
  refused(() => recordActionRun(store, "owner", run), "bad_run", /a1 was not used/, );
  consumeAction(store, "owner", { kind: "deploy", commit: H1 }, T0);
  refused(() => recordActionRun(store, "owner", { ...run, commit: H2 }), "bad_run", /a1 was not used for deploy at bbbbbbbb/);
  refused(() => recordActionRun(store, "codex/gpt-6-astra", run), "not_project_owner");
  const recorded = recordActionRun(store, "owner", run);
  assert.equal(recorded.outputTail.length, 4000, "the tail is cut to 4000 characters");
  assert.equal(events.at(-1)?.kind, "action.ran");
  assert.equal(recordActionRun(store, "owner", { ...run, step: "wrap", kind: null, approval: null, command: null, passed: false }).command, null);
  for (const [field, value] of Object.entries({ step: "Deploy", kind: "x y", approval: "t3", command: 4, commit: "abc", exitStatus: 1.5, signal: "kill", durationMs: -1, passed: "yes", outputTail: 3, ship: "" })) {
    assert.throws(() => cleanRun({ ...run, [field]: value }), new RegExp(`bad_run\\|a run record's ${field} must be`), field);
  }
  assert.throws(() => cleanRun({ ...run, kind: null }), /a run record's kind must be given with an approval/);
});
