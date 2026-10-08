import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import type { PlanPart } from "../src/plans/schema.ts";
import type { ProjectPolicy } from "../src/rules.ts";
import { signIn } from "./signin.ts";

// t263: review precision on the Ledger and the Models page. The owner's
// verdicts on blocking findings (`atelier finding`) order the reviewer the
// Ledger picks for a landing and routes for a plan's part, and the Models
// page shows each reviewer's precision over the stated window. The pure
// arithmetic and every routing rule are tested in test/precision.test.ts.

const TOKEN = "precision-test-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const H0 = "0".repeat(40);
const RUNNER = { runner: "home:studio", kind: "home" } as const;
const DEEPSEEK = "opencode/deepseek-v4-pro";
const OPUS = "claude-code/opus-5.5", GPT = "codex/gpt-6-astra", GEMINI = "antigravity/gemini-3.1-pro", GLM = "zcode/glm-5.3";
// Seeded work is built by a model outside every pool here, so it changes no pool model's track record.
const SEEDER = "claude-code/sonnet-5.5";
const AT = "2026-10-07T12:00:00.000Z";
const entry = (id: string, harness: ModelEntry["harness"]): ModelEntry => ({
  id, harness, where: "cloud", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: AT,
});
const L = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
type Ledger = ReturnType<typeof L>;

async function project(name: string, policy: ProjectPolicy) {
  const record = { name, repo: name, policy, createdAt: new Date().toISOString() };
  await L(name).setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  return L(name);
}

// A task claimed, pushed, checked and submitted by `actor` at `head`, changing `paths`.
let n = 0;
async function submitted(L: Ledger, actor: string, paths = ["src/x.ts"]): Promise<{ id: string; head: string }> {
  const head = (++n).toString(16).padStart(40, "a");
  const { id } = await L.newItem(`Work ${n}`, [], "owner");
  await L.claim(id, actor, RUNNER);
  await L.setFork(id, `fork-${id}`, H0, actor);
  await L.recordPush(id, actor, head, head);
  await L.addEvidence({ itemId: id, claim: "npm test", grade: "observed", head, passed: true, by: actor, at: new Date().toISOString(), changedPaths: paths });
  await L.submit(id, actor);
  return { id, head };
}

// `reviewer` rejects a seeded task with one blocking finding per verdict, and the owner judges each.
async function judged(L: Ledger, reviewer: string, verdicts: ("confirmed" | "fixed" | "refuted")[], builder = SEEDER) {
  const { id, head } = await submitted(L, builder);
  await L.addReview({ itemId: id, by: reviewer, head, approve: false, note: "blocking", at: new Date().toISOString(),
    findings: verdicts.map((_, i) => ({ file: "src/x.ts", line: i + 1, severity: "blocking", text: `finding ${i + 1}` })) });
  for (const [i, v] of verdicts.entries()) await L.addFinding(id, "owner", head, i + 1, v, "");
}
const times = <T,>(x: T, k: number) => Array.from({ length: k }, () => x);

it("a landing's default reviewer is the most precise of the reviewers that qualify", async () => {
  const policy: ProjectPolicy = { checks: ["npm test"], protected: ["src/**"] };
  const POOL = [entry("opus-5.5", "claude-code"), entry("gemini-3.1-pro", "antigravity"), entry("gpt-6-astra", "codex")];
  // Without judged findings the pool goes by model id: gemini-3.1-pro.
  const plain = await project("precision-land-plain", policy);
  const first = await submitted(plain, OPUS);
  expect(await plain.requestReview(first.id, "owner", null, POOL)).toMatchObject({ requested: true, reviewer: GEMINI });
  // gemini-3.1-pro's blocking findings half refuted, as on 2026-10-07; gpt-6-astra's held up.
  const judgedL = await project("precision-land", policy);
  await judged(judgedL, GEMINI, [...times("confirmed" as const, 3), ...times("refuted" as const, 3)]);
  await judged(judgedL, GPT, [...times("confirmed" as const, 5), "fixed"]);
  const task = await submitted(judgedL, OPUS);
  expect(await judgedL.requestReview(task.id, "owner", null, POOL)).toMatchObject({ requested: true, reviewer: GPT });
  // The most precise reviewer of the builder's family is never asked: with
  // sonnet-5.5 in the pool and the most precise, opus-5.5's change still goes to gpt-6-astra.
  await judged(judgedL, SEEDER, times("confirmed" as const, 10), GLM);
  const again = await submitted(judgedL, OPUS);
  expect(await judgedL.requestReview(again.id, "owner", null, [...POOL, entry("sonnet-5.5", "claude-code")])).toMatchObject({ requested: true, reviewer: GPT });
});

it("a protected change's separate tier review goes to the most precise tier model", async () => {
  const policy: ProjectPolicy = { checks: ["npm test"], protected: ["src/**"], reviewTier: [GEMINI, GPT] };
  const POOL = [entry("opus-5.5", "claude-code"), entry("glm-5.3", "zcode")];
  // The owner names glm-5.3, outside the tier, for the gate, so a separate tier review is asked.
  const tierAsked = async (L: Ledger) => {
    const task = await submitted(L, OPUS);
    await L.requestReview(task.id, "owner", GLM, POOL);
    const events = (await L.events(task.id)) as unknown as { kind: string; data: { tier?: boolean; reviewer?: string } }[];
    return events.find((e) => e.kind === "review.requested" && e.data.tier)?.data.reviewer;
  };
  expect(await tierAsked(await project("precision-tier-plain", policy))).toBe(GEMINI);
  const judgedL = await project("precision-tier", policy);
  await judged(judgedL, GEMINI, [...times("confirmed" as const, 3), ...times("refuted" as const, 3)]);
  await judged(judgedL, GPT, times("confirmed" as const, 6));
  expect(await tierAsked(judgedL)).toBe(GPT);
});

it("a plan's routed reviewer is the most precise of the reviewers that qualify", async () => {
  const policy: ProjectPolicy = { checks: ["npm test"], protected: [] };
  const POOL = [entry("opus-5.5", "claude-code"), entry("gpt-6-astra", "codex"), entry("glm-5.3", "zcode")];
  const part: PlanPart = { key: "a", title: "Part a", kind: "build", taskKind: "feature", scope: ["src/a/**"], dependsOn: [], provides: [], uses: [], brief: "Build it", acceptance: ["It works"], tests: [], size: "S" };
  const approve = async (L: Ledger) => {
    const { item } = await L.newPlan("Ship", ["src/**"], "owner", OPUS, []);
    await L.claim(item.id, OPUS, RUNNER);
    const post = await L.postPlan(item.id, OPUS, { schema: "atelier.plan.v1", goal: "Ship", parts: [part] });
    if (!post.valid) throw new Error(post.errors.join("; "));
    await L.release(item.id, OPUS, "proposed");
    await L.approvePlan(item.id, "owner", post.hash, false, POOL);
    const view = await L.planView(item.id) as unknown as { parts: { route: { builder: { actor: string }; reviewer: { actor: string; reasons: string[] } } }[] };
    return view.parts[0].route;
  };
  const plain = await approve(await project("precision-plan-plain", policy));
  // The other model that could review: neither the builder nor of its family.
  const other = [OPUS, GPT, GLM].find((a) => a !== plain.builder.actor && a !== plain.reviewer.actor && familyOf(a.split("/")[1]) !== familyOf(plain.builder.actor.split("/")[1]))!;
  expect(other).toBeTruthy();
  const judgedL = await project("precision-plan", policy);
  await judged(judgedL, plain.reviewer.actor, times("refuted" as const, 6));
  await judged(judgedL, other, times("confirmed" as const, 6));
  const route = await approve(judgedL);
  expect(route.builder.actor).toBe(plain.builder.actor);
  expect(route.reviewer.actor).toBe(other);
  expect(route.reviewer.reasons.join("\n")).toMatch(/Review precision \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}: 100%, 6 of 6 judged blocking findings held up/);
});

it("the Models page shows each reviewer's precision over the stated window, and too few to rank under five judged", async () => {
  const policy: ProjectPolicy = { checks: ["npm test"], protected: [] };
  const P = await project("precision-page", policy);
  await judged(P, GEMINI, [...times("confirmed" as const, 3), "fixed", "fixed", ...times("refuted" as const, 5)]);
  await judged(P, DEEPSEEK, ["confirmed", "refuted", "confirmed"]);
  const cookie = await signIn(TOKEN, testEnv);
  const page = await (await worker.fetch(new Request("https://atelier.test/models", { headers: { cookie } }), testEnv)).text();
  const section = page.split('<section class="precision"')[1]?.split("</section>")[0] ?? "";
  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  expect(section).toContain(`Review precision · ${from} to ${today}`);
  expect(section).toContain("Judged blocking findings");
  const row = (model: string) => section.split(`<code>${model}</code>`)[1]?.split("</tr>")[0] ?? "";
  // Storage lasts the file and the page reads every project, so the earlier tests' twelve verdicts on
  // gemini-3.1-pro count beside these ten: 22 judged, 11 held up, 50%.
  expect(row("gemini-3.1-pro")).toContain('<td class="num">22</td>');
  expect(row("gemini-3.1-pro")).toContain("50%");
  expect(row("deepseek-v4-pro")).toContain('<td class="num">3</td>');
  expect(row("deepseek-v4-pro")).toContain("n=3, too few to rank");
  expect(row("deepseek-v4-pro")).not.toContain("%");
});
