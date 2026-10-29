import { env } from "./support/workers.ts";
import { expect, it } from "./support/vitest.ts";
import worker from "../src/index.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import type { PlanPart } from "../src/plans/schema.ts";
import type { ProjectPolicy } from "../src/rules.ts";
import { signIn } from "./signin.ts";
import { liveOffersFor } from "./helpers/live-offers.ts";
import { parseRuleError } from "../src/rules.ts";

// t263: review precision on the Ledger and the Models page. The owner's
// verdicts on blocking findings (`atelier finding`) are shown with each
// reviewer candidate a landing's refusal lists (G17: the Ledger picks none)
// and order the reviewer a plan's candidate routing proposes for a part, and
// the Models page shows each reviewer's precision over the stated window. The pure
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
  await L.setWorkspace(id, `fork-${id}`, H0, actor);
  await L.recordPush(id, actor, head, head);
  await L.addEvidence({ itemId: id, claim: "npm test", grade: "observed", head, passed: true, by: actor, at: new Date().toISOString(), changedPaths: paths });
  await L.submit(id, actor);
  return { id, head };
}

// `reviewer` rejects a seeded task with one blocking finding per verdict, and the owner judges each.
async function judged(L: Ledger, reviewer: string, verdicts: ("confirmed" | "fixed" | "refuted")[], builder = SEEDER) {
  const { id, head } = await submitted(L, builder);
  await L.addReview({ itemId: id, criteria: await L.criteria(id), by: reviewer, head, approve: false, note: "blocking", at: new Date().toISOString(),
    findings: verdicts.map((_, i) => ({ file: "src/x.ts", line: i + 1, severity: "blocking", text: `finding ${i + 1}` })) });
  for (const [i, v] of verdicts.entries()) await L.addFinding(id, "owner", head, i + 1, v, "");
}
const times = <T,>(x: T, k: number) => Array.from({ length: k }, () => x);

// G17: the Ledger picks no reviewer. A landing that names none is refused with
// the candidates, each with its review precision, and the model names one.
const refusedWith = async (L: Ledger, id: string, pool: ModelEntry[]) => {
  const refused = await L.requestReview(id, "owner", null, pool, false, false, undefined, liveOffersFor(pool)).then(() => null, (e: unknown) => parseRuleError(e));
  expect(refused?.code).toBe("reviewer_needed");
  return refused!.detail;
};
const lineOf = (detail: string, actor: string) => detail.split("\n").find((l) => l.trim().startsWith(`${actor} `)) ?? "";

it("a landing naming no reviewer is refused with the qualifying reviewers' precision, and the builder's family never qualifies", async () => {
  const policy: ProjectPolicy = { checks: ["npm test"], protected: ["src/**"] };
  const POOL = [entry("opus-5.5", "claude-code"), entry("gemini-3.1-pro", "antigravity"), entry("gpt-6-astra", "codex")];
  // Without judged findings each qualifying reviewer orders as neutral.
  const plain = await project("precision-land-plain", policy);
  const first = await submitted(plain, OPUS);
  const none = await refusedWith(plain, first.id, POOL);
  for (const actor of [GEMINI, GPT]) expect(lineOf(none, actor), actor).toMatch(/no blocking finding judged; too few to rank, so it orders as neutral \(0\.50\)/);
  // gemini-3.1-pro's blocking findings half refuted, as on 2026-10-07; gpt-6-astra's held up.
  const judgedL = await project("precision-land", policy);
  await judged(judgedL, GEMINI, [...times("confirmed" as const, 3), ...times("refuted" as const, 3)]);
  await judged(judgedL, GPT, [...times("confirmed" as const, 5), "fixed"]);
  const task = await submitted(judgedL, OPUS);
  const detail = await refusedWith(judgedL, task.id, POOL);
  expect(lineOf(detail, GEMINI)).toMatch(/50%, 3 of 6 judged blocking findings held up/);
  expect(lineOf(detail, GPT)).toMatch(/100%, 6 of 6 judged blocking findings held up/);
  // The most precise reviewer of the builder's family is never a candidate: with
  // sonnet-5.5 in the pool and the most precise, opus-5.5's change still lists
  // it as refused, and the named gpt-6-astra is asked.
  await judged(judgedL, SEEDER, times("confirmed" as const, 10), GLM);
  const again = await submitted(judgedL, OPUS);
  const withSonnet = [...POOL, entry("sonnet-5.5", "claude-code")];
  const family = await refusedWith(judgedL, again.id, withSonnet);
  expect(family).toMatch(/Refused:[\s\S]*claude-code\/sonnet-5\.5: /);
  expect(lineOf(family, "claude-code/sonnet-5.5")).not.toContain("(home)");
  expect(await judgedL.requestReview(again.id, "owner", GPT, withSonnet, false, false, undefined, liveOffersFor(withSonnet))).toMatchObject({ requested: true, reviewer: GPT });
});

// A protected change's separate tier review no longer goes to the most precise
// tier model: the Ledger asks none (G17), the tier_needed candidates keep the
// tier's own order, and the developer names the tier reviewer
// (test/model-roles.spec.ts, test/production-paths.test.mjs).

// G17: the approval is refused until it names each part's route; the
// refusal's candidate routing still puts the most precise qualifying reviewer.
it("a plan approved with no routes is refused with the most precise of the reviewers that qualify as each part's candidate", async () => {
  const policy: ProjectPolicy = { checks: ["npm test"], protected: [] };
  const POOL = [entry("opus-5.5", "claude-code"), entry("gpt-6-astra", "codex"), entry("glm-5.3", "zcode")];
  const part: PlanPart = { key: "a", title: "Part a", kind: "build", taskKind: "feature", scope: ["src/a/**"], dependsOn: [], provides: [], uses: [], brief: "Build it", acceptance: ["It works"], tests: [], size: "S" };
  const candidate = async (L: Ledger) => {
    const { item } = await L.newPlan("Ship", ["src/**"], "owner", OPUS, []);
    await L.claim(item.id, OPUS, RUNNER);
    const post = await L.postPlan(item.id, OPUS, { schema: "atelier.plan.v1", goal: "Ship", parts: [part] });
    if (!post.valid) throw new Error(post.errors.join("; "));
    await L.release(item.id, OPUS, "proposed");
    const refused = await L.approvePlan(item.id, "owner", post.hash, false, POOL, liveOffersFor(POOL)).then(() => null, (e: unknown) => parseRuleError(e));
    expect(refused?.code).toBe("routes_needed");
    const found = /part a: builders ([^;]*); reviewer (\S+)/.exec(refused!.detail);
    expect(found, refused?.detail).toBeTruthy();
    return { builder: found![1].split(", ")[0], reviewer: found![2] };
  };
  const plain = await candidate(await project("precision-plan-plain", policy));
  // The other model that could review: neither the builder nor of its family.
  const other = [OPUS, GPT, GLM].find((a) => a !== plain.builder && a !== plain.reviewer && familyOf(a.split("/")[1]) !== familyOf(plain.builder.split("/")[1]))!;
  expect(other).toBeTruthy();
  const judgedL = await project("precision-plan", policy);
  await judged(judgedL, plain.reviewer, times("refuted" as const, 6));
  await judged(judgedL, other, times("confirmed" as const, 6));
  const route = await candidate(judgedL);
  expect(route.builder).toBe(plain.builder);
  expect(route.reviewer).toBe(other);
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
  // Storage lasts the file and the page reads every project, so the earlier test's six verdicts on
  // gemini-3.1-pro count beside these ten: 16 judged, 8 held up, 50%.
  expect(row("gemini-3.1-pro")).toContain('<td class="num">16</td>');
  expect(row("gemini-3.1-pro")).toContain("50%");
  expect(row("deepseek-v4-pro")).toContain('<td class="num">3</td>');
  expect(row("deepseek-v4-pro")).toContain("n=3, too few to rank");
  expect(row("deepseek-v4-pro")).not.toContain("%");
});

// gpt-6-astra's and gemini-4-argon's reviews of t621: the Ledger's own
// precision record, which routing reads, left out the served annotations,
// so routing credited a served review's findings to the declared model
// while the Models page credited the model that served it. G17: the figures
// now show on the candidates a landing's refusal lists.
it("the candidates' review precision is read under the model that served each review", async () => {
  const policy: ProjectPolicy = { checks: ["npm test"], protected: ["src/**"] };
  const POOL = [entry("opus-5.5", "claude-code"), entry("gemini-3.1-pro", "antigravity"), entry("gpt-6-astra", "codex")];
  const L = await project("precision-served", policy);
  const from = new Date(Date.now() - 60_000).toISOString();
  await judged(L, GPT, times("confirmed" as const, 6));
  const to = new Date(Date.now() + 1000).toISOString();
  await judged(L, GEMINI, [...times("confirmed" as const, 4), ...times("refuted" as const, 2)]);
  const before = await submitted(L, OPUS);
  const listed = await refusedWith(L, before.id, POOL);
  expect(lineOf(listed, GPT)).toMatch(/100%, 6 of 6 judged blocking findings held up/);
  expect(lineOf(listed, GEMINI)).toMatch(/4 of 6 judged blocking findings held up/);
  // Every review gpt-6-astra recorded was served by another model: its six held findings are not its own.
  const done = await L.annotateServed({ served: "gpt-6-mini", recorded: GPT, from, to, items: null, note: "served by the mini" }, "owner", true);
  expect(done.annotated).toBeGreaterThan(0);
  const after = await submitted(L, OPUS);
  const relisted = await refusedWith(L, after.id, POOL);
  expect(lineOf(relisted, GPT)).toMatch(/no blocking finding judged/);
  expect(lineOf(relisted, GEMINI)).toMatch(/4 of 6 judged blocking findings held up/);
});
