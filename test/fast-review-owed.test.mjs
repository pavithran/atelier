import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../src/runtime/loader.mjs";
import { Namespace } from "../src/runtime/namespace.mjs";
import { criteriaOf } from "../src/criteria.ts";
import * as ship from "../cli/ship.mjs";
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
  for (const approved of [true, false]) {
    const item = await L.newItem("Ordinary fast merge", ["src/**"], "owner", { accept: ["Works"] });
    const { generation } = await L.claim(item.id, OPUS);
    await L.recordToken(item.id, OPUS, generation, null, `token-${item.id}`);
    await L.setWorkspace(item.id, `${item.id}--fork`, P, OPUS);
    await L.recordPush(item.id, OPUS, C, C);
    await L.addEvidence({ itemId: item.id, head: C, by: "owner", claim: "paths", grade: "observed", passed: true, changedPaths: ["src/a.ts"], at: new Date().toISOString() });
    await L.submit(item.id, OPUS);
    if (approved) await L.addReview({ itemId: item.id, head: C, by: GPT, approve: true, criteria: criteriaOf(item), note: "Approved", at: new Date().toISOString() }, undefined, true);
    await L.accept(item.id, "owner", C);
    await L.merged(item.id, "owner", M, true);
    const landing = (await L.fastLandings()).find((l) => l.item === item.id);
    assert.equal(landing.owed, !approved);
    assert.equal(landing.independentApproved, approved);
  }
  const line = await L.statusModeLine(await L.mode());
  assert.doesNotMatch(line, /t1 \(|t4 \(/);
  assert.match(line, /t5 \(not requested\)/);
  assert.match(line, /t2 \(not requested\).*t3 \(not requested\)/);
});

test("ship warning names every unapproved fast merge in the ship once and remains advisory on old servers", async () => {
  const lines = [];
  const landed = [
    { item: "t1", receipt: { mergeCommit: M }, independentApproved: false, owed: true },
    { item: "t2", receipt: { mergeCommit: M }, independentApproved: true, owed: false },
    { item: "t3", receipt: { mergeCommit: M }, independentApproved: false, owed: false },
    { item: "t4", receipt: { mergeCommit: P }, independentApproved: false },
    { item: "t5", receipt: { mergeCommit: C }, independentApproved: false },
  ];
  const ctx = { name: "demo", baselineHead: M, paired: (sha) => sha,
    git: ([, , ancestor, head]) => ({ status: ancestor === head || (ancestor === P && head === M) ? 0 : 1 }),
    request: async (_method, path) => path.endsWith("/mode") ? { landed } : { deploys: [{ head: P, result: "shipped" }] },
    print: (line) => lines.push(line),
  };
  await ship.warnFastMerges(ctx);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Warning:.*t1.*t3.*no approving review from another family/);
  assert.doesNotMatch(lines[0], /t2|t4|t5/);
  await ship.warnFastMerges({ ...ctx, request: async () => { throw new Error("404: old server"); } });
  await ship.warnFastMerges({ ...ctx, request: async () => ({}) });
  assert.equal(lines.length, 1);
});
