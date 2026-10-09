import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import type { LedgerEvent } from "../src/ledger.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import type { RunReport } from "../src/models/reliability.ts";
import { suggestionRecords } from "../src/models/suggestion-records.ts";
import { parseRuleError, type Evidence, type ProjectPolicy } from "../src/rules.ts";

// Atelier suggests the builder and the reviewer (t370): atelier dispatch with
// no --agent asks the dispatch route to choose a builder from the pool and
// the models' records, and the review request of a landing that names no
// reviewer goes to a model of another company than every contributor. Both
// answers carry the choice and its reasons, which the CLI prints. A dispatch
// that does not ask, and a landing whose gate needs no review, are as before.

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

function call(method: string, path: string, body?: unknown) {
  return worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), testEnv);
}

async function project(name: string) {
  const record = { name, repo: name, policy, createdAt: new Date().toISOString() };
  await ledger(name).setProject(record, "owner");
  await index().registerProject(record);
  return ledger(name);
}

it("dispatch with no agent, asked to suggest, chooses a builder from the pool and says why; a builder whose last two builds stalled is passed over", async () => {
  for (const m of POOL) await index().putModel(m);
  await project("suggest-dispatch");
  const created = await (await call("POST", "/projects/suggest-dispatch/items", { title: "Small edit", scope: ["docs/**"] })).json() as { id: string };
  const path = `/projects/suggest-dispatch/items/${created.id}/dispatch`;

  // Two stalled builds in a row keep Opus from building until it builds one.
  const stalled = (at: string): RunReport => ({ actor: OPUS, role: "build", outcome: "stalled", at, project: "suggest-dispatch", item: created.id, detail: "", runner: "home:studio" });
  await index().putRun(stalled("2026-10-07T00:00:00.000Z"));
  await index().putRun(stalled("2026-10-08T00:00:00.000Z"));

  const sent = await call("POST", path, { suggest: true });
  expect(sent.status).toBe(200);
  const answer = await sent.json() as { dispatch: { agent: string; model: string; to: string }; suggestion: { actor: string; reasons: string[] } };
  expect(answer.suggestion.actor).not.toBe(OPUS);
  expect(`${answer.dispatch.agent}/${answer.dispatch.model}`).toBe(answer.suggestion.actor);
  expect(answer.dispatch.to).toBe("home");
  expect(answer.suggestion.reasons.join(" ")).toMatch(/Outcome score/);
  // Held to Opus, the suggestion finds no builder and says why.
  const held = await call("POST", path, { suggest: true, model: "opus-5.5" });
  expect(held.status).toBe(409);
  expect(JSON.stringify(await held.json())).toMatch(/claude-code\/opus-5\.5: two consecutive stalled builds; no successful build since/);

  // A dispatch that does not ask stays open to any runner's agent.
  const open = await (await call("POST", path, { to: "home" })).json() as { dispatch: { agent: string | null }; suggestion?: unknown };
  expect(open.dispatch.agent).toBeNull();
  expect(open.suggestion).toBeUndefined();
});

it("a task rejected twice is suggested to a frontier builder", async () => {
  const L = await project("suggest-rejected");
  const id = (await L.newItem("Small edit", ["docs/**"], "owner")).id;
  // Two rejections recorded on the task, as the records read them.
  const rejected = (seq: number, head: string): LedgerEvent => ({ seq, kind: "review.rejected", actor: GEMINI, itemId: id, data: { head }, at: `2026-10-0${seq}T00:00:00.000Z` } as LedgerEvent);
  const records = { sources: [{ project: "suggest-rejected", events: [rejected(1, "a".repeat(40)), rejected(2, "b".repeat(40))] }], runs: [] };
  const { suggestBuilder } = await import("../src/models/suggest.ts");
  const item = await L.item(id);
  const pick = suggestBuilder({ ...records, item, project: "suggest-rejected", pool: [POOL[1], POOL[2]], policy, owner: "owner" });
  expect(pick.actor).toBe(ASTRA);
  expect(pick.reasons[0]).toMatch(/Two rejections require a frontier builder/);
  // With no frontier model in the pool, no builder is suggested.
  expect(() => suggestBuilder({ ...records, item, project: "suggest-rejected", pool: [POOL[1]], policy, owner: "owner" })).toThrow(/codex\/gpt-6\.1-sol: not frontier/);
});

it("a landing that names no reviewer asks one of another company than every contributor, with its reason, and only when the gate needs a review", async () => {
  const L = await project("suggest-review");
  const records = await suggestionRecords(index(), (p) => ledger(p.key ?? p.name));
  const submitted = async (title: string, head: string, paths: string[]) => {
    const id = (await L.newItem(title, [], "owner")).id;
    await L.claim(id, OPUS, RUNNER);
    await L.setFork(id, `fork-${id}`, H0, OPUS);
    await L.recordPush(id, OPUS, head, head);
    await L.addEvidence({ itemId: id, claim: "npm test", grade: "observed", head, passed: true, by: OPUS, at: new Date().toISOString(), changedPaths: paths } satisfies Evidence);
    await L.submit(id, OPUS);
    return id;
  };

  // A protected change built by Opus: the reviewer is of another company,
  // and of the frontier tier since the change is protected.
  const id = await submitted("Landing", "a".repeat(40), ["src/land.ts"]);
  const asked = await L.requestReview(id, "owner", null, POOL, false, false, records);
  expect(asked).toMatchObject({ needed: true, requested: true, reviewer: ASTRA });
  expect(asked.reason).toMatch(/Frontier reviewer required/);
  const logged = ((await L.events(id)) as unknown as LedgerEvent[]).find((e) => e.kind === "review.requested");
  expect(logged?.data).toMatchObject({ reviewer: ASTRA, reason: expect.stringMatching(/Frontier reviewer required/) });
  // Asked again, the standing request is returned with the reason recorded.
  expect(await L.requestReview(id, "owner", null, POOL, false, false, records)).toMatchObject({ requested: false, reviewer: ASTRA, reason: expect.stringMatching(/Frontier reviewer required/) });

  // With only models of the builder's company in the pool, none is asked.
  const same = await submitted("Landing again", "b".repeat(40), ["src/other.ts"]);
  const refused = await L.requestReview(same, "owner", null, [POOL[0]], false, false, records).then(() => null, (e: unknown) => parseRuleError(e));
  expect(refused?.code).toBe("no_reviewer");
  expect(refused?.detail).toMatch(/no reviewer of another family than every contributor/);

  // A change the gate needs no review of is not forced into one.
  const docs = await submitted("Docs", "c".repeat(40), ["docs/note.md"]);
  expect(await L.requestReview(docs, "owner", null, POOL, false, false, records)).toMatchObject({ needed: false });
});
