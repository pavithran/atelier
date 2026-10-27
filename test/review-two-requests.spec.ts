import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { Ledger, ReviewClaim } from "../src/ledger.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import type { Evidence, ProjectPolicy } from "../src/rules.ts";

// t374: a change that needs two independent reviews keeps both requests when
// the developer asks two reviewers in a row, and recording the first review
// leaves the second reviewer's request open.

const H0 = "0".repeat(40);
const RUNNER = { runner: "home:studio", kind: "home" } as const;
const OPUS = "claude-code/opus-5.5", GPT = "codex/gpt-6-astra", GEMINI = "antigravity/gemini-3.1-pro";
const policy: ProjectPolicy = {
  checks: ["npm test"], protected: ["src/**"],
  riskReviews: { core: ["src/rules.ts"], reviews: { "docs-or-tests": 0, other: 1, core: 2 } },
};
const AT = "2026-10-06T12:00:00.000Z";
const entry = (id: string, harness: ModelEntry["harness"]): ModelEntry => ({
  id, harness, where: "cloud", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: AT,
});
const POOL = [entry("opus-5.5", "claude-code"), entry("gpt-6-astra", "codex"), entry("gemini-3.1-pro", "antigravity")];

async function submitted(project: string, changedPaths: string[]) {
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${project}`));
  await L.setProject({ name: project, repo: `${project}--baseline`, policy, createdAt: new Date().toISOString() }, "owner");
  const id = (await L.newItem("Core change", [], "owner")).id;
  const head = "a".repeat(40);
  await L.claim(id, OPUS, RUNNER);
  await L.setFork(id, `fork-${id}`, H0, OPUS);
  await L.recordPush(id, OPUS, head, head);
  await L.addEvidence({ itemId: id, claim: "npm test", grade: "observed", head, passed: true, by: OPUS, at: new Date().toISOString(), changedPaths } satisfies Evidence);
  await L.submit(id, OPUS);
  return { L, id, head };
}

const approve = async (L: ReturnType<typeof env.LEDGER.get>, id: string, head: string, by: string) => {
  const claim = await L.claimReview(id, by, RUNNER) as unknown as ReviewClaim;
  await L.addReview({ request: claim.request, itemId: id, criteria: await L.criteria(id), by, head, approve: true, note: "Fine.", findings: [], at: new Date().toISOString() });
  return claim.request;
};

it("two review requests naming different reviewers leave two open requests, each claimable only by its reviewer", async () => {
  const { L, id, head } = await submitted("two-requests", ["src/rules.ts"]);
  const first = await L.requestReview(id, "owner", GPT, POOL, true);
  const second = await L.requestReview(id, "owner", GEMINI, POOL, true);
  expect(first).toMatchObject({ requested: true, reviewer: GPT });
  expect(second).toMatchObject({ requested: true, reviewer: GEMINI });
  expect(second.withdrew).toBeUndefined();
  expect(second.request).not.toBe(first.request);
  expect((await L.reviewRequests(id)).map((r) => r.state)).toEqual(["open", "open"]);
  expect((await L.reviewWaiting()).map((w) => w.request).sort()).toEqual([first.request, second.request].sort());
  // Naming either again keeps both.
  expect(await L.requestReview(id, "owner", GPT, POOL, true)).toMatchObject({ requested: false, request: first.request });
  expect(await L.requestReview(id, "owner", GEMINI, POOL, true)).toMatchObject({ requested: false, request: second.request });
  // Each is claimable only by its named reviewer.
  expect(await L.claimReview(id, GEMINI, RUNNER)).toMatchObject({ request: second.request });
  expect(await L.claimReview(id, GPT, RUNNER)).toMatchObject({ request: first.request });
  expect(head).toBeTruthy();
});

it("one of two required reviews recorded leaves the other reviewer's request open", async () => {
  const { L, id, head } = await submitted("two-requests-answer", ["src/rules.ts"]);
  const first = await L.requestReview(id, "owner", GPT, POOL, true);
  const second = await L.requestReview(id, "owner", GEMINI, POOL, true);
  expect(await approve(L, id, head, GPT)).toBe(first.request);
  expect((await L.reviewRequests(id)).map((r) => r.state)).toEqual(["answered", "open"]);
  expect((await L.reviewWaiting()).map((w) => w.request)).toEqual([second.request]);
  expect(await L.claimReview(id, GEMINI, RUNNER)).toMatchObject({ request: second.request });
});

it("a change that needs one review still redirects its open request to the reviewer named", async () => {
  const { L, id } = await submitted("two-requests-single", ["src/land.ts"]);
  const first = await L.requestReview(id, "owner", GPT, POOL, true);
  const next = await L.requestReview(id, "owner", GEMINI, POOL, true);
  expect(next).toMatchObject({ requested: true, reviewer: GEMINI, withdrew: [{ request: first.request, reviewer: GPT }] });
});
