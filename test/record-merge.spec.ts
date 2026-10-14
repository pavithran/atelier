import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import { renderItem } from "../src/ui.ts";
import type { LedgerEvent } from "../src/ledger.ts";

// atelier record-merge (t653). Under the 2026-10-13 freeze the tasks
// t590-t651 were merged into local main by hand, outside atelier land and
// accept, so the ledger still showed them open or claimed. The developer
// records each afterwards: the merge commit main holds, the commit merged
// (its second parent) and the reviews as given. The record is refused for
// an agent, when main lacks the merge, and when its second parent is
// another commit; it says plainly that the merge was made outside Atelier.

const TOKEN = "record-merge-token";
const AT = "2026-10-14T00:00:00.000Z";
const BUILDER = "claude-code/opus-5.5", ASTRA = "codex/gpt-6-astra", ARGON = "antigravity/gemini-4-argon";
const BASE = "a".repeat(40), HEAD = "b".repeat(40), MERGE = "c".repeat(40), OTHER = "d".repeat(40), LATER = "e".repeat(40), SOLO = "f".repeat(40);
const T = "0".repeat(40);

async function setup(name: string) {
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  const record = { name, repo: `${name}--baseline`, policy: { checks: ["npm test"], protected: [] }, createdAt: AT };
  await L.setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  // main: LATER (main moved on since) <- MERGE (BASE, HEAD) <- BASE; OTHER is
  // a merge the baseline holds but main does not; SOLO is a plain commit on main.
  let main = [
    { hash: LATER, parents: [MERGE], treeHash: T },
    { hash: MERGE, parents: [BASE, HEAD], treeHash: T },
    { hash: SOLO, parents: [BASE], treeHash: T },
    { hash: BASE, parents: [], treeHash: T },
  ];
  const elsewhere = [{ hash: OTHER, parents: [BASE, HEAD], treeHash: T }];
  const revoked: string[] = [];
  const artifacts = {
    get: async () => ({
      log: async () => main,
      readCommit: async (hash: string) => [...main, ...elsewhere].find((c) => c.hash === hash) ?? null,
      revokeToken: async (id: string) => { revoked.push(id); },
      [Symbol.dispose]() {},
    }),
  } as unknown as Artifacts;
  const call = (id: string, body: unknown, actor = "owner") => worker.fetch(new Request(`https://atelier.test/api/projects/${name}/items/${id}/record-merge`, {
    method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": actor, "content-type": "application/json" }, body: JSON.stringify(body),
  }), { ...env, ATELIER_TOKEN: TOKEN, ARTIFACTS: artifacts } as typeof env);
  return { L, call, revoked, dropMerge: () => { main = main.filter((c) => c.hash !== MERGE && c.hash !== LATER); } };
}
const reviews = [{ by: ASTRA, verdict: "approve", head: HEAD, at: "2026-10-13" }, { by: ARGON, verdict: "approve", head: HEAD }];
const refusal = async (r: Response, status: number, code: string, detail?: RegExp) => {
  const body = await r.json() as { error: string; detail: string };
  expect([r.status, body.error], body.detail).toEqual([status, code]);
  if (detail) expect(body.detail).toMatch(detail);
};

it("records a claimed task merged outside Atelier, with its merge, the commit merged and the reviews as given", async () => {
  const { L, call, revoked } = await setup("record-merge-ok");
  const item = await L.newItem("Built outside the gate", [], "owner");
  const { generation } = await L.claim(item.id, BUILDER);
  expect(await L.recordToken(item.id, BUILDER, generation, null, "tok-1")).toBe(true);
  await L.setFork(item.id, "record-merge-ok--t1", BASE, BUILDER);
  const r = await call(item.id, { mergeCommit: MERGE, head: HEAD, reviews, note: "merged under the freeze" });
  expect(r.status, await r.clone().text()).toBe(200);
  const got = await r.json() as { item: { state: string; owner: string | null; head: string; acceptedHead: string | null }; record: Record<string, unknown> };
  expect(got.item).toMatchObject({ state: "merged", owner: null, head: HEAD, acceptedHead: null });
  expect(got.record).toMatchObject({ mergeCommit: MERGE, commit: HEAD, reviews, note: "merged under the freeze", outside: true, by: "owner" });
  // The workspace token goes with the claim.
  expect(await L.tokenId(item.id)).toBeNull();
  expect(revoked).toEqual(["tok-1"]);
  const events = (await L.events(item.id)) as unknown as LedgerEvent[];
  expect(events.find((e) => e.kind === "item.merged")?.data).toEqual({ mergeCommit: MERGE, head: HEAD, observedOnBaseline: true, outside: true });
  expect(events.find((e) => e.kind === "item.merge_recorded")?.data).toMatchObject({ mergeCommit: MERGE, commit: HEAD, reviews, outside: true });
  // Nothing says it was accepted or reviewed through the gate.
  expect(events.map((e) => e.kind)).not.toEqual(expect.arrayContaining(["item.accepted"]));
  expect(events.some((e) => e.kind === "review.approved")).toBe(false);
  // The task's page says so plainly.
  const html = renderItem(await L.project(), await L.detail(item.id));
  expect(html).toMatch(/Merged outside Atelier<\/strong>, recorded afterwards by owner/);
  expect(html).toContain("did not pass through the gate, and no checks or test receipt are recorded");
  expect(html).toMatch(/codex\/gpt-6-astra approved <code>bbbbbbbbbbbb<\/code> \(2026-10-13\)/);
  // The same record again is answered with the first; another merge is refused.
  expect((await call(item.id, { mergeCommit: MERGE, head: HEAD, reviews })).status).toBe(200);
  await refusal(await call(item.id, { mergeCommit: OTHER, head: HEAD, reviews }), 409, "closed");
  expect(((await L.events(item.id)) as unknown as LedgerEvent[]).filter((e) => e.kind === "item.merged")).toHaveLength(1);
});

it("takes the task's recorded head when no head is named", async () => {
  const { L, call } = await setup("record-merge-pushed");
  const item = await L.newItem("Pushed, then merged by hand", [], "owner");
  await L.claim(item.id, BUILDER);
  await L.setFork(item.id, "record-merge-pushed--t1", BASE, BUILDER);
  await L.recordPush(item.id, BUILDER, HEAD, HEAD);
  const r = await call(item.id, { mergeCommit: MERGE, reviews });
  expect(r.status, await r.clone().text()).toBe(200);
  expect((await r.json() as { record: { commit: string } }).record.commit).toBe(HEAD);
  expect(((await L.events(item.id)) as unknown as LedgerEvent[]).find((e) => e.kind === "item.merge_recorded")?.data.recordedHead).toBeUndefined();
});

it("refuses an agent: only the developer records a merge", async () => {
  const { L, call } = await setup("record-merge-agent");
  const item = await L.newItem("Agent tries", [], "owner");
  await L.claim(item.id, BUILDER);
  await refusal(await call(item.id, { mergeCommit: MERGE, head: HEAD, reviews }, BUILDER), 403, "not_project_owner");
  await refusal(await call(item.id, { mergeCommit: MERGE, head: HEAD, reviews }, ASTRA), 403, "not_project_owner");
  expect(await L.item(item.id)).toMatchObject({ state: "claimed", owner: BUILDER });
  // The Ledger refuses it too, whatever the route.
  const err = await L.recordMerge(item.id, BUILDER, { mergeCommit: MERGE, commit: HEAD, reviews }, { parents: [BASE, HEAD], holds: true }).then(() => null, (e: unknown) => e as Error);
  expect(err?.message).toMatch(/not_project_owner/);
});

it("refuses when main does not hold the merge commit", async () => {
  const { L, call, dropMerge } = await setup("record-merge-absent");
  const item = await L.newItem("Merged on a laptop only", [], "owner");
  // A merge the baseline has, but not on main.
  await refusal(await call(item.id, { mergeCommit: OTHER, head: HEAD, reviews }), 409, "merge_not_on_main", /main does not hold dddddddd.*atelier sync/);
  // A merge the baseline has never seen: main was not synced.
  dropMerge();
  await refusal(await call(item.id, { mergeCommit: MERGE, head: HEAD, reviews }), 409, "merge_not_on_main", /baseline has no commit cccccccc/);
  expect((await L.item(item.id)).state).toBe("open");
});

it("refuses when the merge commit's second parent is not the task's head, or it is not a merge", async () => {
  const { L, call } = await setup("record-merge-parent");
  const item = await L.newItem("Wrong commit named", [], "owner");
  await refusal(await call(item.id, { mergeCommit: MERGE, head: OTHER, reviews: [{ by: ASTRA, verdict: "approve", head: OTHER }] }), 409, "second_parent_differs", /second parent is bbbbbbbb, not dddddddd/);
  await refusal(await call(item.id, { mergeCommit: SOLO, head: HEAD, reviews }), 409, "not_a_merge");
  // No head named and none pushed: nothing to compare with.
  await refusal(await call(item.id, { mergeCommit: MERGE, reviews }), 400, "bad_record", /commit merged/);
  // A fork's base is not a head the task pushed.
  const forked = await L.newItem("Forked, nothing pushed", [], "owner");
  await L.claim(forked.id, BUILDER);
  await L.setFork(forked.id, "record-merge-parent--t2", BASE, BUILDER);
  await refusal(await call(forked.id, { mergeCommit: MERGE, reviews }), 400, "bad_record", /commit merged/);
  // The reviews must approve the commit merged.
  await refusal(await call(item.id, { mergeCommit: MERGE, head: HEAD, reviews: [{ by: ASTRA, verdict: "reject", head: HEAD }] }), 400, "no_approval");
  expect((await L.item(item.id)).state).toBe("open");
  expect(((await L.events(item.id)) as unknown as LedgerEvent[]).some((e) => e.kind === "item.merged" || e.kind === "item.merge_recorded")).toBe(false);
});
