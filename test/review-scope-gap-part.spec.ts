import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { ReviewClaim } from "../src/ledger.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import type { PlanPart } from "../src/plans/schema.ts";
import type { Evidence, ProjectPolicy } from "../src/rules.ts";

// A rejected plan part whose blocker names a file outside the part's scope
// gets the scope warning and the scope-preserving edit in its rework brief
// (t270); a blocker inside the scope gets neither.

const H0 = "0".repeat(40), HEAD = "a".repeat(40);
const RUNNER = { runner: "home:studio", kind: "home" } as const;
const PLANNER = "claude-code/opus-5.5";
const policy: ProjectPolicy = { checks: ["npm test"], protected: [] };
const AT = "2026-10-25T12:00:00.000Z";
const entry = (id: string, harness: ModelEntry["harness"]): ModelEntry => ({
  id, harness, where: "cloud", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: AT,
});
const POOL = [entry("opus-5.5", "claude-code"), entry("gpt-6-astra", "codex"), entry("glm-5.3", "zcode")];
const part: PlanPart = {
  key: "a", title: "Part a", kind: "build", taskKind: "feature", scope: ["src/a/**"], dependsOn: [],
  provides: [], uses: [], brief: "Build it", acceptance: ["It works"], tests: [], size: "S",
};

async function rejectedPart(name: string, file: string) {
  const record = { name, repo: `${name}--baseline`, policy, createdAt: new Date().toISOString() };
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.setProject(record, "owner");
  const { item } = await L.newPlan("Ship it", ["src/**"], "owner", PLANNER, []);
  await L.claim(item.id, PLANNER, RUNNER);
  await L.setFork(item.id, `fork-${item.id}`, H0, PLANNER);
  const post = await L.postPlan(item.id, PLANNER, { schema: "atelier.plan.v1", goal: "Ship it", parts: [part] });
  if (!post.valid) throw new Error(post.errors.join("; "));
  await L.release(item.id, PLANNER, "proposed");
  const { parts } = await L.approvePlan(item.id, "owner", post.hash, false, POOL);
  const partId = parts[0].id;
  const d = (await L.item(partId)).dispatch!;
  const builder = `${d.agent}/${d.model}`;
  await L.claim(partId, builder, RUNNER);
  await L.setFork(partId, `fork-${partId}`, H0, builder);
  await L.recordPush(partId, builder, HEAD, HEAD);
  const ev: Evidence = { itemId: partId, claim: "npm test", grade: "observed", head: HEAD, passed: true, by: "owner", at: new Date().toISOString(), changedPaths: ["src/a/x.ts"] };
  await L.addEvidence(ev);
  await L.submit(partId, builder);
  const waiting = (await L.reviewWaiting()).filter((w) => w.id === partId);
  const reviewer = `${waiting[0].dispatch!.agent}/${waiting[0].dispatch!.model}`;
  const claim = await L.claimReview(partId, reviewer, RUNNER) as unknown as ReviewClaim;
  const findings = [{ file, line: 3, severity: "blocking" as const, text: "Wrong" }];
  await L.addReview({ request: claim.request, itemId: partId, criteria: await L.criteria(partId), by: reviewer, head: HEAD, approve: false, note: "No", findings, at: new Date().toISOString() });
  return { L, partId, builder };
}

it("a rejected part with a blocker outside its scope says the scope lacks the file and prints the edit", async () => {
  const { L, partId, builder } = await rejectedPart("gap-out", "cli/land-queue.mjs");
  await L.claim(partId, builder, RUNNER);
  const { text } = await L.jobBrief(partId, builder);
  expect(text).toContain("The scope lacks a file a blocking finding names (cli/land-queue.mjs)");
  expect(text).toContain("atelier edit " + partId + " --scope 'src/a/**' --scope cli/land-queue.mjs");
});

it("a rejected part with a blocker inside its scope has no scope warning", async () => {
  const { L, partId, builder } = await rejectedPart("gap-in", "src/a/x.ts");
  await L.claim(partId, builder, RUNNER);
  const { text } = await L.jobBrief(partId, builder);
  expect(text).not.toContain("The scope lacks");
});
