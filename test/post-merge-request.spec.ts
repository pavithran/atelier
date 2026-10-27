import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import type { LedgerEvent, ReviewClaim } from "../src/ledger.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import type { ProjectPolicy } from "../src/rules.ts";

// t331: the server asks a fast-mode merge's post-merge review itself, as the
// merge is recorded, whatever path recorded it. Before this only atelier
// land asked it (cli/land.mjs), and miqra/t130, accepted and merged without
// land on 2026-10-26, was never reviewed.

const TOKEN = "post-merge-request-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const AT = "2026-10-26T15:45:00.000Z";
const RUNNER = { runner: "home:studio", kind: "home" } as const;
const OPUS = "claude-code/opus-5.5", GPT = "codex/gpt-6-astra";
const entry = (id: string, harness: ModelEntry["harness"]): ModelEntry => ({
  id, harness, where: "home", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: AT,
});
const POOL = [entry("opus-5.5", "claude-code"), entry("gpt-6-astra", "codex")];
const policy: ProjectPolicy = { checks: ["npm test"], protected: [] };
const START = "0".repeat(40), C1 = "c".repeat(40), M1 = "d".repeat(40), P1 = "a".repeat(40);

// What the task's detail says of its live request, which atelier land reads.
type Live = { liveReview: { request: number; reviewer: string; stopped?: string } | null };
const ledger = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
async function project(name: string, fast: boolean) {
  const record = { name, repo: `${name}--baseline`, policy, createdAt: AT };
  const L = ledger(name);
  await L.setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  await L.poolChanged(POOL);
  if (fast) {
    await L.confirmFastMode("owner", "access");
    await L.setMode("owner", "fast", "forks fail");
  }
  return L;
}
function api(method: string, path: string, actor: string, body?: unknown) {
  return worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method, headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": actor, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), testEnv);
}
// A task built by Opus and submitted at C1 with its check passing, accepted.
async function accepted(L: ReturnType<typeof ledger>, title: string) {
  const item = await L.newItem(title, ["src/**"], "owner", { accept: ["Works"] });
  await L.claim(item.id, OPUS);
  await L.setFork(item.id, `${item.id}--fork`, START, OPUS);
  await L.recordPush(item.id, OPUS, C1, C1);
  await L.addEvidence({ itemId: item.id, claim: "npm test", grade: "observed", head: C1, passed: true, by: "owner", at: AT, changedPaths: ["src/a.ts"] });
  await L.submit(item.id, OPUS);
  return item;
}
const requested = async (L: ReturnType<typeof ledger>, id: string) =>
  ((await L.events(id, 1000)) as unknown as LedgerEvent[]).filter((e) => e.kind === "review.requested");

it("a fast-mode task accepted then merged gets its post-merge review request at the merge", async () => {
  const L = await project("pmr-accept-merge", true);
  const item = await accepted(L, "Merged without land");
  await L.accept(item.id, "owner", C1);
  await L.merged(item.id, "owner", M1, true);
  const asks = await requested(L, item.id);
  expect(asks).toHaveLength(1);
  expect(asks[0]).toMatchObject({ actor: "atelier/orchestrator", data: { head: M1, via: "post-merge", wanted: true } });
  expect((await L.reviewRequests(item.id)).filter((r) => r.state === "open")).toEqual([expect.objectContaining({ head: M1 })]);
  expect((await L.fastLandings())[0]).toMatchObject({ item: item.id, owed: false, review: { state: "open" } });
  // The task's detail names the request at the merge commit, which atelier land reads.
  expect(((await L.detail(item.id)) as unknown as Live).liveReview).toMatchObject({ reviewer: asks[0].data.reviewer });
});

it("a fast-mode task recorded with record-merge gets its post-merge review request at the merge", async () => {
  const L = await project("pmr-record-merge", true);
  const item = await L.newItem("Merged outside Atelier", ["src/**"], "owner", { accept: ["Works"] });
  const { generation } = await L.claim(item.id, OPUS);
  await L.recordToken(item.id, OPUS, generation, null, "tok-1");
  await L.setFork(item.id, `${item.id}--fork`, START, OPUS);
  await L.recordPush(item.id, OPUS, C1, C1);
  const body = { mergeCommit: M1, commit: C1, reviews: [{ by: GPT, verdict: "approve", head: C1 }] };
  await L.recordMerge(item.id, "owner", body, { parents: [P1, C1], holds: true, tip: M1 }, await L.workspaceOf(item.id));
  expect(await L.mergedFast(item.id)).toBe(true);
  const asks = await requested(L, item.id);
  expect(asks).toHaveLength(1);
  expect(asks[0]).toMatchObject({ data: { head: M1, via: "post-merge" } });
  expect((await L.fastLandings())[0]).toMatchObject({ item: item.id, owed: false, review: { state: "open" } });
});

it("a fast-mode merge whose head already has a counted approval asks no post-merge review", async () => {
  const L = await project("pmr-approved", true);
  const item = await accepted(L, "Reviewed before the merge");
  await L.requestReview(item.id, "owner", GPT, POOL, true);
  const claim = await L.claimReview(item.id, GPT, RUNNER) as unknown as ReviewClaim;
  await L.addReview({ itemId: item.id, by: GPT, head: C1, criteria: claim.criteria, request: claim.request, approve: true, note: "Fine", at: AT }, undefined, true);
  await L.accept(item.id, "owner", C1);
  await L.merged(item.id, "owner", M1, true);
  // The one request is the pre-merge one, answered; none is asked at the merge.
  expect((await requested(L, item.id)).map((e) => e.data.via)).toEqual(["land"]);
  expect((await L.reviewRequests(item.id)).some((r) => r.head === M1)).toBe(false);
});

it("a full-mode merge asks no post-merge review", async () => {
  const L = await project("pmr-full", false);
  const item = await accepted(L, "Merged in full mode");
  await L.accept(item.id, "owner", C1);
  await L.merged(item.id, "owner", M1, true);
  expect(await L.mergedFast(item.id)).toBe(false);
  expect(await requested(L, item.id)).toEqual([]);
  // record-merge in full mode leaves the merge unmarked and asks nothing either.
  const outside = await L.newItem("Merged outside in full mode", ["src/**"], "owner", { accept: ["Works"] });
  await L.recordMerge(outside.id, "owner", { mergeCommit: M1, commit: C1, reviews: [{ by: GPT, verdict: "approve", head: C1 }] }, { parents: [P1, C1], holds: true, tip: M1 }, await L.workspaceOf(outside.id));
  expect(await L.mergedFast(outside.id)).toBe(false);
  expect(await requested(L, outside.id)).toEqual([]);
});

it("a fast-mode merge with no reviewer to ask stays merged, owed, and says why", async () => {
  const L = await project("pmr-no-reviewer", true);
  await L.poolChanged([]);
  const item = await accepted(L, "Nobody to ask");
  await L.accept(item.id, "owner", C1);
  expect(await L.merged(item.id, "owner", M1, true)).toMatchObject({ state: "merged" });
  expect(await requested(L, item.id)).toEqual([]);
  const unasked = ((await L.events(item.id, 1000)) as unknown as LedgerEvent[]).find((e) => e.kind === "review.unasked");
  expect(unasked?.data).toMatchObject({ via: "post-merge", reason: expect.stringContaining("no reviewer") });
  expect((await L.fastLandings())[0]).toMatchObject({ owed: true, review: { state: "not requested" } });
});

it("a post-merge review that ends without a verdict twice is reported as owed in atelier status, naming the task", async () => {
  const name = "pmr-stopped";
  const L = await project(name, true);
  const item = await accepted(L, "Audited without a verdict");
  await L.accept(item.id, "owner", C1);
  await L.merged(item.id, "owner", M1, true);
  const reviewer = (await requested(L, item.id))[0].data.reviewer as string;
  // Once is not yet owed: the request is asked again.
  const first = await L.claimReview(item.id, reviewer, RUNNER) as unknown as ReviewClaim;
  await L.unparsableReview(item.id, reviewer, M1, "the reply states no verdict: it has no VERDICT line and no JSON verdict", "SUMMARY: could not run the checks\nBLOCKING: 0", false, first.request);
  expect((await L.fastLandings())[0]).toMatchObject({ owed: false, review: { state: "open" } });
  const second = await L.claimReview(item.id, reviewer, RUNNER) as unknown as ReviewClaim;
  await L.unparsableReview(item.id, reviewer, M1, "the reply states no verdict: it has no VERDICT line and no JSON verdict", "SUMMARY: could not run the checks\nBLOCKING: 0", false, second.request);
  expect((await L.fastLandings())[0]).toMatchObject({ item: item.id, owed: true, review: { state: "stopped without a verdict" } });
  // atelier status prints the mode line from GET mode, and status --project
  // from the standing: both name the task as owed.
  const owed = `Post-merge review owed: ${item.id} (stopped without a verdict)`;
  const mode = await (await api("GET", `/projects/${name}/mode`, "owner")).json() as { line: string };
  expect(mode.line).toMatch(/^Mode: fast since .* \(forks fail\)\. Post-merge review owed: /);
  expect(mode.line).toContain(owed);
  const standing = await (await api("GET", `/projects/${name}/standing`, "owner")).json() as { mode: string };
  expect(standing.mode).toContain(owed);
  // The stop the runners, the claim and the stuck report read says so too.
  expect(((await L.detail(item.id)) as unknown as Live).liveReview?.stopped).toMatch(new RegExp(`^the post-merge review of ${item.id} at ${M1.slice(0, 8)} is owed: it stopped after 2 releases \\(it ended without a verdict`));
});
