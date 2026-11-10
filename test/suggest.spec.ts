import { env } from "./support/workers.ts";
import { expect, it } from "./support/vitest.ts";
import worker from "../src/index.ts";
import type { LedgerEvent } from "../src/ledger.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import type { RunReport } from "../src/models/reliability.ts";
import { suggestionRecords } from "../src/models/suggestion-records.ts";
import { liveOffersFor } from "./helpers/live-offers.ts";
import { parseRuleError, type Evidence, type ProjectPolicy } from "../src/rules.ts";
import { withoutDefaultRunner } from "./support/default-runner.ts";

// These tests decide which runners are live, or that none is: no default runner joins them.
withoutDefaultRunner();

// Atelier lists the builder and reviewer candidates (t370, G17): atelier
// dispatch with no --agent, and the review request of a landing that names no
// reviewer, are refused with the pool's candidates and the models' records
// (the server picks none), the reviewers being of another company than every
// contributor. A landing whose gate needs no review is as before.

const TOKEN = "suggest-test-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const H0 = "0".repeat(40);
const RUNNER = { runner: "home:studio", kind: "home" } as const;
const AT = "2026-10-06T12:00:00.000Z";
const OPUS = "claude-code/opus-5.5", SOL = "codex/gpt-6.1-sol", ASTRA = "codex/gpt-6-astra", GEMINI = "gemini-cli/gemini-3";
const entry = (id: string, harness: ModelEntry["harness"]): ModelEntry => ({
  id, harness, where: "home", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: AT,
});
const POOL = [entry("opus-5.5", "claude-code"), entry("gpt-6.1-sol", "codex"), entry("gpt-6-astra", "codex"), entry("gemini-3", "gemini-cli")];
const policy: ProjectPolicy = { checks: ["npm test"], protected: ["src/**"] };

const index = () => env.LEDGER.get(env.LEDGER.idFromName("__index"));
const ledger = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));

// A write on the owner token names the acting model (G18); OPUS is in the pool.
function call(method: string, path: string, body?: unknown) {
  return worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "x-atelier-acting": OPUS, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), testEnv);
}

async function project(name: string) {
  const record = { name, repo: name, policy, createdAt: new Date().toISOString() };
  await ledger(name).setProject(record, "owner");
  await index().registerProject(record);
  return ledger(name);
}

// G17: the server suggests nothing. A dispatch with no --agent (asked to
// suggest or not) is refused with every pool model, in the order of its
// records, with its reliability line; the stalled-builds exclusion is gone
// (G6), so a builder with two stalled builds is listed, its record said.
it("dispatch with no agent, asked to suggest, is refused with the pool's candidates and their records, and queues nothing", async () => {
  for (const m of POOL) await index().putModel(m);
  await project("suggest-dispatch");
  const created = await (await call("POST", "/projects/suggest-dispatch/items", { title: "Small edit", scope: ["docs/**"] })).json() as { id: string };
  const path = `/projects/suggest-dispatch/items/${created.id}/dispatch`;

  // Two stalled builds in a row are a recorded fact now, not a bar.
  const stalled = (at: string): RunReport => ({ actor: OPUS, role: "build", outcome: "stalled", at, project: "suggest-dispatch", item: created.id, detail: "", runner: "home:studio" });
  await index().putRun(stalled("2026-10-07T00:00:00.000Z"));
  await index().putRun(stalled("2026-10-08T00:00:00.000Z"));

  const sent = await call("POST", path, { suggest: true });
  expect(sent.status).toBe(409);
  const answer = await sent.json() as { error: string; detail: string; next: string; dispatch?: unknown; suggestion?: unknown };
  expect(answer.error).toBe("builder_needed");
  expect(answer.suggestion).toBeUndefined();
  expect(answer.dispatch).toBeUndefined();
  for (const actor of [OPUS, SOL, ASTRA, GEMINI]) expect(answer.detail).toContain(actor);
  expect(answer.detail).toMatch(/claude-code\/opus-5\.5 \(home\): .*2 stalled/);
  expect(answer.next).toMatch(/^name one: atelier dispatch t\d+ --agent \S+ --model \S+, or another of the eligible$/);
  // Held to Opus, the list is Opus alone, and it is not refused for its stalls.
  const held = await call("POST", path, { suggest: true, model: "opus-5.5" });
  expect(held.status).toBe(409);
  const heldText = JSON.stringify(await held.json());
  expect(heldText).toContain("claude-code/opus-5.5 (home)");
  expect(heldText).not.toMatch(/two consecutive stalled builds/);

  // A dispatch that does not ask names no builder either.
  const open = await call("POST", path, { to: "home" });
  expect(open.status).toBe(409);
  expect(await open.json()).toMatchObject({ error: "builder_needed" });
  expect((await ledger("suggest-dispatch").item(created.id)).dispatch).toBeNull();
});

// G6 removed the rule that two rejections require a frontier builder: no
// keyword, count or run narrows the candidates; the model names the builder.
it("a task rejected twice no longer needs a frontier builder: every pool model stays a candidate", async () => {
  const L = await project("suggest-rejected");
  const id = (await L.newItem("Small edit", ["docs/**"], "owner")).id;
  // Two rejections recorded on the task, as the records read them.
  const rejected = (seq: number, head: string): LedgerEvent => ({ seq, kind: "review.rejected", actor: GEMINI, itemId: id, data: { head }, at: `2026-10-0${seq}T00:00:00.000Z` } as LedgerEvent);
  const records = { sources: [{ project: "suggest-rejected", events: [rejected(1, "a".repeat(40)), rejected(2, "b".repeat(40))] }], runs: [] };
  const { builderCandidates } = await import("../src/models/suggest.ts");
  const item = await L.item(id);
  const candidates = builderCandidates({ ...records, item, project: "suggest-rejected", pool: [POOL[1], POOL[2]], policy, owner: "owner" });
  expect(candidates.map((c) => [c.actor, c.refusal])).toEqual([[ASTRA, null], [SOL, null]]);
});

it("a renamed project's records are read under its key, so its task's rejections stay with it", async () => {
  await project("suggest-was");
  await index().renameProject("suggest-was", "suggest-is");
  await ledger("suggest-was").setName("suggest-is", "owner");
  const records = await suggestionRecords(index(), (p) => ledger(p.key ?? p.name));
  expect(records.sources.map((s) => s.project)).toContain("suggest-was");
  expect(records.sources.map((s) => s.project)).not.toContain("suggest-is");
});

// G17: a landing that names no reviewer asks nobody. The refusal lists the
// models of another company than every contributor, each with its figures, and
// the one the developer names is asked; a change the gate needs no review of
// is not forced into one.
it("a landing that names no reviewer is refused with the candidates, the named one is asked, and only when the gate needs a review", async () => {
  const L = await project("suggest-review");
  const records = { ...await suggestionRecords(index(), (p) => ledger(p.key ?? p.name)), project: "suggest-review" };
  const offers = liveOffersFor(POOL);
  const submitted = async (title: string, head: string, paths: string[]) => {
    const id = (await L.newItem(title, [], "owner")).id;
    await L.claim(id, OPUS, RUNNER);
    await L.setWorkspace(id, `fork-${id}`, H0, OPUS);
    await L.recordPush(id, OPUS, head, head);
    await L.addEvidence({ itemId: id, claim: "npm test", grade: "observed", head, passed: true, by: OPUS, at: new Date().toISOString(), changedPaths: paths } satisfies Evidence);
    await L.submit(id, OPUS);
    return id;
  };

  // A protected change built by Opus: the candidates are of another company.
  const id = await submitted("Landing", "a".repeat(40), ["src/land.ts"]);
  const none = await L.requestReview(id, "owner", null, POOL, false, false, records, offers).then(() => null, (e: unknown) => parseRuleError(e));
  expect(none?.code).toBe("reviewer_needed");
  expect(none?.detail).toContain(ASTRA);
  expect(none?.detail).toContain(`${OPUS}: it contributed to ${id}`);
  expect(none?.next).toMatch(/^name one: atelier review-request t\d+ --reviewer /);
  const asked = await L.requestReview(id, "owner", ASTRA, POOL, false, false, records, offers);
  expect(asked).toMatchObject({ needed: true, requested: true, reviewer: ASTRA });
  expect(asked.reason).toMatch(/Named by the developer/);
  const logged = ((await L.events(id)) as unknown as LedgerEvent[]).find((e) => e.kind === "review.requested");
  expect(logged?.data).toMatchObject({ reviewer: ASTRA, reason: expect.stringMatching(/Named by the developer/) });
  // Asked again, the standing request is returned with the reason recorded.
  expect(await L.requestReview(id, "owner", ASTRA, POOL, false, false, records, offers)).toMatchObject({ requested: false, reviewer: ASTRA, reason: expect.stringMatching(/Named by the developer/) });

  // With only models of the builder's company in the pool, none is a candidate.
  const same = await submitted("Landing again", "b".repeat(40), ["src/other.ts"]);
  const refused = await L.requestReview(same, "owner", null, [POOL[0]], false, false, records, offers).then(() => null, (e: unknown) => parseRuleError(e));
  expect(refused?.code).toBe("reviewer_needed");
  expect(refused?.detail).toMatch(/No model in the pool is eligible/);
  expect(refused?.detail).toContain(`${OPUS}: it contributed to ${same}`);

  // A change the gate needs no review of is not forced into one.
  const docs = await submitted("Docs", "c".repeat(40), ["docs/note.md"]);
  expect(await L.requestReview(docs, "owner", null, POOL, false, false, records, offers)).toMatchObject({ needed: false });
});
