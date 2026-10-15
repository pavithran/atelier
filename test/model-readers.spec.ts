import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { NO_CRITERIA } from "../src/criteria.ts";
import worker from "../src/index.ts";
import type { LedgerEvent } from "../src/ledger.ts";
import { judgementTotals } from "../src/models/judgement.ts";
import { measureRecords } from "../src/models/compare.ts";
import type { ModelEntry } from "../src/models/pool.ts";
import { reliabilityJson, type RunReport } from "../src/models/reliability.ts";
import { suggestionRecords } from "../src/models/suggestion-records.ts";

// t677: the readers behind /api/reliability, the Models page, the daily
// snapshots and routing are one set. The route builds its records with
// measureRecords, and every reader keys a project's events by its project key,
// so a project renamed between events keeps its history under one name.

const TOKEN = "model-readers-test-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const OPUS = "claude-code/opus-5.5", GPT = "codex/gpt-6-astra";
const [H0, H1, H2] = ["0", "1", "2"].map((c) => c.repeat(40));
const KEY = "readers-was", NAME = "readers-is";
const index = () => env.LEDGER.get(env.LEDGER.idFromName("__index"));
const L = () => env.LEDGER.get(env.LEDGER.idFromName(`project:${KEY}`));
const call = (method: string, path: string, body?: unknown) => worker.fetch(new Request(`https://atelier.test/api${path}`, {
  method, headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
}), testEnv);

// A project whose model work is reviewed, merged and then found defective,
// with a run report and a rename in between: events on both sides of it.
let seeded: Promise<string> | null = null;
const seed = () => (seeded ??= seedOnce());
async function seedOnce() {
  const record = { name: KEY, repo: KEY, policy: { checks: [], protected: [] }, createdAt: new Date().toISOString() };
  await L().setProject(record, "owner");
  await index().registerProject(record);
  const { id } = await L().newItem("Work", ["docs/**"], "owner");
  await L().claim(id, OPUS);
  await L().setFork(id, `${KEY}--${id}`, H0, OPUS);
  await L().recordPush(id, OPUS, H1, H1);
  await L().submit(id, OPUS);
  await L().addReview({ itemId: id, by: GPT, head: H1, criteria: NO_CRITERIA, approve: false, note: "needs a test", at: new Date().toISOString(), findings: [{ file: "a.ts", line: 1, severity: "blocking", text: "drops rows" }] });
  await index().renameProject(KEY, NAME);
  await L().setName(NAME, "owner");
  await L().recordPush(id, OPUS, H2, H2);
  await L().addReview({ itemId: id, by: GPT, head: H2, criteria: NO_CRITERIA, approve: true, note: "good", at: new Date().toISOString() });
  await L().addEvidence({ itemId: id, claim: "changed paths", grade: "observed", head: H2, passed: true, by: "atelier/sandbox", at: new Date().toISOString(), changedPaths: ["docs/a.md"], where: "sandbox" });
  await L().accept(id, "owner", H2);
  await L().merged(id, "owner", "f".repeat(40), true, H2);
  expect((await call("POST", `/projects/${KEY}/items/${id}/defect`, { note: "loses the last page" })).status).toBe(201);
  await index().putRun({ actor: OPUS, role: "build", outcome: "stalled", project: KEY, item: id, detail: "", runner: "home:studio", at: new Date().toISOString() });
  return id;
}

it("GET /api/reliability gives the records measureRecords gives for the same events, a renamed project under its key", async () => {
  await seed();
  const res = await call("GET", "/reliability");
  expect(res.status, await res.clone().text()).toBe(200);
  const body = await res.json() as { events: number; models: unknown; speed: unknown; judgement: unknown };

  // The same events as the other readers take them: by key, as routing reads them.
  const read = await suggestionRecords(index(), (p) => env.LEDGER.get(env.LEDGER.idFromName(`project:${p.key ?? p.name}`)));
  const records = measureRecords({
    sources: read.sources, runs: read.runs as unknown as RunReport[],
    assignmentEvents: (await index().assignmentEvents()) as unknown as LedgerEvent[], pool: (await index().models()) as unknown as ModelEntry[], owner: "owner",
  }, new Date());
  expect(body.events).toBe(read.sources.reduce((n, s) => n + s.events.length, 0));
  // The window ends at the instant of each read, so it is left out.
  const { window: _w1, ...routeJudgement } = body.judgement as { window: unknown };
  const { window: _w2, ...readJudgement } = JSON.parse(JSON.stringify({ ...records.judgement, totals: judgementTotals(records.judgement) }));
  expect(routeJudgement).toEqual(readJudgement);
  expect(body.models).toEqual(JSON.parse(JSON.stringify(reliabilityJson(records.reliability))));
  // The figures are not empty, so the equality says something.
  expect(JSON.stringify(body.models)).toContain(KEY);
});

it("the reliability and speed records keep a renamed project's events under its key", async () => {
  await seed();
  const { models } = await (await call("GET", "/reliability")).json() as { models: { model: string; projects: string[]; defects: { project: string }[]; runCauses?: unknown }[] };
  const opus = models.find((m) => m.model === "opus-5.5")!;
  // The ledger's events were recorded before and after the rename; one name.
  expect(opus.projects).toContain(KEY);
  expect(opus.projects).not.toContain(NAME);
  expect(opus.defects.map((d) => d.project)).toEqual([KEY]);
});
