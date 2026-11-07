import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../src/runtime/loader.mjs";
import { Namespace } from "../src/runtime/namespace.mjs";
import { criteriaOf } from "../src/criteria.ts";
import "./support/default-proof.ts";
const { Ledger } = await import("../src/ledger.ts");
const OPUS = "claude-code/opus-5.5", GPT = "codex/gpt-6-astra", SONNET = "claude-code/sonnet-5";
const C = "c".repeat(40), M = "d".repeat(40), P = "a".repeat(40);

test("status settles another family's approval of the merged head, including record-merge reviews", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-fast-owed-"));
  const ns = new Namespace({ dir, Class: Ledger, env: {} });
  t.after(async () => { await ns.close(); rmSync(dir, { recursive: true, force: true }); });
  const L = ns.get(ns.idFromName("project:fast-owed"));
  await L.setProject({ name: "fast-owed", repo: "baseline", policy: { checks: [], protected: [] }, createdAt: new Date().toISOString() }, "owner");
  await L.confirmFastMode("owner", "access");
  await L.setMode("owner", "fast", "Go fast");
  for (const [reviews, owed] of [
    [[{ by: GPT, verdict: "approve", head: C }], false],
    [[{ by: SONNET, verdict: "approve", head: C }], true],
    [[{ by: GPT, verdict: "approve", head: P }, { by: OPUS, verdict: "approve", head: C }], true],
  ]) {
    const item = await L.newItem("Fast merge", ["src/**"], "owner", { accept: ["Works"] });
    const { generation } = await L.claim(item.id, OPUS);
    await L.recordToken(item.id, OPUS, generation, null, `token-${item.id}`);
    await L.setWorkspace(item.id, `${item.id}--fork`, P, OPUS);
    await L.recordMerge(item.id, "owner", { mergeCommit: M, commit: C, reviews }, { parents: [P, C], holds: true, tip: M }, await L.workspaceOf(item.id));
    const landing = (await L.fastLandings()).find((l) => l.item === item.id);
    assert.equal(landing.owed, owed);
    assert.equal(landing.independentApproved, !owed);
  }
  // Ordinary merges use reviews held by the ledger instead of named reviews.
  for (const reviewer of [GPT, null, SONNET]) {
    const approved = reviewer === GPT;
    const item = await L.newItem("Ordinary fast merge", ["src/**"], "owner", { accept: ["Works"] });
    const { generation } = await L.claim(item.id, OPUS);
    await L.recordToken(item.id, OPUS, generation, null, `token-${item.id}`);
    await L.setWorkspace(item.id, `${item.id}--fork`, P, OPUS);
    await L.recordPush(item.id, OPUS, C, C);
    await L.addEvidence({ itemId: item.id, head: C, by: "owner", claim: "paths", grade: "observed", passed: true, changedPaths: ["src/a.ts"], at: new Date().toISOString() });
    await L.submit(item.id, OPUS);
    if (reviewer) await L.addReview({ itemId: item.id, head: C, by: reviewer, approve: true, criteria: criteriaOf(item), note: "Approved", at: new Date().toISOString() }, undefined, true);
    if (!approved) {
      await L.confirmOverride(item.id, "owner", C, "access");
      await L.accept(item.id, "owner", C, "Exercise the post-merge audit without a pre-merge approval");
    } else await L.accept(item.id, "owner", C);
    await L.merged(item.id, "owner", M, true);
    const landing = (await L.fastLandings()).find((l) => l.item === item.id);
    assert.equal(landing.owed, !approved);
    assert.equal(landing.independentApproved, approved);
  }
  const line = await L.statusModeLine(await L.mode());
  assert.doesNotMatch(line, /t1 \(|t4 \(/);
  assert.match(line, /t5 \(not requested\)/);
  assert.match(line, /t6 \(not requested\)/);
  assert.match(line, /t2 \(not requested\).*t3 \(not requested\)/);
});


test("fast review uses standing eligible approvals and later rejections win across heads", () => {
  const item = { id: "t1", head: C, owner: null, pushActors: [OPUS], accept: ["Works"] };
  const base = { itemId: item.id, head: C, by: GPT, approve: true, criteria: criteriaOf(item), note: "", at: "2026-11-01T00:00:00Z" };
  let reviews = [], record = null;
  const ctx = { owner: "owner", item: () => item, project: () => ({ policy: {} }), reviewsFor: () => reviews,
    sql: { exec: () => ({ toArray: () => record ? [{ data: JSON.stringify(record) }] : [] }) } };
  const result = () => Ledger.prototype.fastReview.call(ctx, item.id, C, M);
  for (const invalid of [{ by: SONNET }, { by: "owner" }, { tier: true }, { withdrawn: true }, { criteria: "old" }]) {
    reviews = [{ ...base, ...invalid }];
    assert.equal(result().approval, undefined, JSON.stringify(invalid));
    assert.equal(result().review, undefined, "ineligible pre-merge approvals do not settle status");
  }
  reviews = [base];
  assert.equal(result().approval.by, GPT);
  for (const head of [C, M]) {
    reviews = [base, { ...base, head, approve: false, postMerge: true, at: "2026-11-02T00:00:00Z" }];
    assert.equal(result().approval, undefined);
    assert.equal(result().review.approve, false);
  }
  // An undated approval named on record-merge cannot overwrite a held rejection.
  record = { at: "2026-11-03T00:00:00Z", reviews: [{ by: GPT, head: C, verdict: "approve" }] };
  reviews = [{ ...base, approve: false }];
  assert.equal(result().approval, undefined);
  record = null;
  const admission = { id: "gpt-6-astra", aliases: ["custom-reviewer"], active: true };
  reviews = [{ ...base, by: "codex/custom-reviewer", reviewerAdmission: admission }];
  assert.equal(result().approval.by, "codex/custom-reviewer");
});
