import "./today-clock.ts";
import { env, runInDurableObject } from "./support/workers.ts";
import { afterAll, beforeAll, expect, it, vi } from "./support/vitest.ts";
import worker from "../src/index.ts";
import { NO_CRITERIA } from "../src/criteria.ts";
import type { Evidence, Review } from "../src/rules.ts";
import { signIn } from "./signin.ts";

// Today's Deploys tile, the deploy lines and the empty day (t562), entered at
// worker.fetch on small ledgers of this file's own, with the fake clock set to
// the Eastern day under test (2026-10-10, EDT: the day starts at 04:00 UTC).
// Trust checks: GET / needs the developer's session here (no Access on this
// server); the data comes from the ledgers, never from the request.

const TOKEN = "today-deploys-token";
const bindings = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const OPUS = "claude-code/opus-5.5", ASTRA = "codex/gpt-6-astra";
const at = (iso: string) => vi.setSystemTime(new Date(iso));
const H = (n: number) => n.toString(16).padStart(40, "0");
const ledger = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
let cookie = "";

async function project(name: string) {
  const record = { name, repo: name, policy: { checks: ["npm test"], protected: [] }, createdAt: new Date().toISOString() };
  await ledger(name).setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  return ledger(name);
}
const evidence = (id: string, head: string): Evidence => ({ itemId: id, claim: "npm test", grade: "observed", head, passed: true, by: "owner", at: new Date().toISOString(), changedPaths: ["src/a.ts"] });
const review = (id: string, head: string): Review => ({ itemId: id, by: ASTRA, head, criteria: NO_CRITERIA, approve: true, note: "", at: new Date().toISOString() });

// One task, built and merged at the fake clock's time.
async function merge(L: ReturnType<typeof ledger>, name: string, id: string) {
  const item = await L.newItem(`Task ${id}`, ["src/**"], "owner");
  expect(item.id).toBe(id);
  await L.claim(id, OPUS);
  await L.setWorkspace(id, `${name}--${id}`, H(0), OPUS);
  await L.recordPush(id, OPUS, H(1), H(1));
  await L.addEvidence(evidence(id, H(1)));
  await L.submit(id, OPUS);
  await L.addReview(review(id, H(1)), undefined, true);
  await L.accept(id, "owner");
  await L.merged(id, "owner", H(2), true);
}
// A post-merge run in the state given, as the ledger keeps it (meta rows).
async function postMerge(L: ReturnType<typeof ledger>, id: string, state: string) {
  const run = { id: `run-${id}`, members: [id], before: H(0), after: H(2), policy: { version: 1, approval: { reason: "test", by: "owner", at: new Date().toISOString() }, steps: [] }, createdAt: new Date().toISOString(), state, paths: [], steps: [] };
  await runInDurableObject(L, async (_i, state_) => {
    state_.storage.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, `post-merge:${run.id}`, JSON.stringify(run));
    state_.storage.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, `post-merge-item:${id}`, run.id);
  });
}
let shipped = 0;
const ship = (L: ReturnType<typeof ledger>, id: string, result: "shipped" | "failed" = "shipped", extra: Record<string, unknown> = {}) =>
  L.recordDeploy("owner", { ship: `ship-day-${id}`, head: H(1000 + ++shipped), result, ...extra });

const today = async () => {
  const res = await worker.fetch(new Request("https://atelier.test/", { headers: { cookie }, redirect: "manual" }), bindings);
  expect(res.status).toBe(200);
  return res.text();
};
const tile = (html: string, name: string) => {
  const m = new RegExp(`data-tile="${name}"[^>]*>([\\s\\S]*?)</a>`).exec(html);
  if (!m) throw new Error(`no ${name} tile`);
  return { n: /<span class="n">([^<]*)<\/span>/.exec(m[1])?.[1], text: m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() };
};

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at("2026-10-10T12:00:00.000Z");
  cookie = await signIn(TOKEN, bindings);
});
afterAll(() => { vi.useRealTimers(); });

// Criterion 4: more ships in the day than lastDeploys' 50-record limit.
it("Deploys today counts all 60 shipped records of the Eastern day, not the failed one and not the ship at 11:59 pm Eastern the day before", async () => {
  const L = await project("ship-day");
  at("2026-10-10T03:59:00.000Z"); // 11:59 pm EDT on the 9th
  await ship(L, "before-midnight");
  for (let i = 0; i < 60; i++) {
    at(new Date(Date.parse("2026-10-10T04:00:00.000Z") + i * 6 * 60_000).toISOString());
    await ship(L, `s${i}`);
    if (i === 30) { at("2026-10-10T07:05:00.000Z"); await ship(L, "bad", "failed", { step: "deploy" }); }
  }
  at("2026-10-10T12:00:00.000Z");
  expect((await L.deploys(200)).length).toBeGreaterThan(60);
  const html = await today();
  expect(tile(html, "deploys").n).toBe("60");
});

// Criteria 8 and 12: the state a deploy shows is the post-merge run of the merges it shipped.
it("the Deploys tile follows the day's latest deploy, whose state is post-merge checks passed only when every merge it shipped has a complete run", async () => {
  const L = await project("two-ships");
  at("2026-10-10T10:00:00.000Z"); await merge(L, "two-ships", "t1");
  at("2026-10-10T10:10:00.000Z"); await ship(L, "a1");
  await postMerge(L, "t1", "complete");
  at("2026-10-10T10:20:00.000Z"); await merge(L, "two-ships", "t2");
  at("2026-10-10T10:30:00.000Z"); await ship(L, "a2");
  await postMerge(L, "t2", "failed");
  at("2026-10-10T12:00:00.000Z");
  // The 60 ships of the first test and a1 are older than a2: the tile reads a2.
  const later = await today();
  expect(tile(later, "deploys").text).toContain("post-merge run failed");
  expect(tile(later, "deploys").text).not.toContain("post-merge checks passed");
  // The earlier deploy's own line still says passed.
  expect(later).toMatch(/Deployed two-ships[^<]*<\/div><div class="today-sub">[^<]*post-merge checks passed/);
  // A third deploy, later, whose merge has a complete run: the tile now follows it.
  at("2026-10-10T10:40:00.000Z"); await merge(L, "two-ships", "t3");
  at("2026-10-10T10:50:00.000Z"); await ship(L, "a3");
  await postMerge(L, "t3", "complete");
  at("2026-10-10T12:00:00.000Z");
  const html = await today();
  expect(tile(html, "deploys").text).toContain("post-merge checks passed");
  // t2 shipped in a2 stays failed on its own line.
  expect(html).toContain("post-merge run failed");
});

it("a deploy whose merge has no post-merge run reads 'not recorded', and a partly complete deploy names the run that is not", async () => {
  const L = await project("no-run");
  at("2026-10-10T11:00:00.000Z"); await merge(L, "no-run", "t1"); await merge(L, "no-run", "t2");
  at("2026-10-10T11:10:00.000Z"); await ship(L, "n1");
  await postMerge(L, "t1", "complete");
  at("2026-10-10T12:00:00.000Z");
  const html = await today();
  expect(tile(html, "deploys").text).toContain("post-merge run not recorded");
  expect(html.toLowerCase()).not.toContain("main green");
});

// Fix round 1: a deploy's merges are those after the previous shipped deploy; with that deploy
// outside the 14-day read the membership is unknown, so it never reads passed.
it("a deploy today whose previous shipped deploy is 15 days old reads 'not recorded', though its newer merge has a complete run", async () => {
  const L = await project("old-prev");
  at("2026-09-24T12:00:00.000Z"); await ship(L, "p0"); // the previous deploy, 16 days old
  at("2026-09-25T12:00:00.000Z"); await merge(L, "old-prev", "t1"); // merged 15 days ago, never shipped, no run
  at("2026-10-10T11:00:00.000Z"); await merge(L, "old-prev", "t2");
  at("2026-10-10T11:10:00.000Z"); await ship(L, "p1");
  await postMerge(L, "t2", "complete");
  at("2026-10-10T12:00:00.000Z");
  const html = await today();
  expect(tile(html, "deploys").text).toContain("post-merge run not recorded");
  expect(tile(html, "deploys").text).not.toContain("post-merge checks passed");
  // Fix round 2: unknown membership is not an empty one: the timeline gives no count.
  // Other projects on this day ship no merges; the old-prev line is the one asserted.
  const line = /Deployed old-prev[^<]*<\/div><div class="today-sub">([^<]*)</.exec(html)?.[1];
  expect(line).toBe("merges shipped: not recorded · post-merge run not recorded");
  expect(line).not.toMatch(/\b0 merges\b/);
});

// Criterion 9: an empty day, read from ledgers that hold nothing.
it("a project with no tasks and a day with no merges, deploys or live tasks shows one plain line per empty section", async () => {
  at("2026-10-12T12:00:00.000Z"); // a later day: the ledgers above hold nothing for it
  const res = await worker.fetch(new Request("https://atelier.test/", { headers: { cookie }, redirect: "manual" }), bindings);
  const html = await res.text();
  expect(res.status).toBe(200);
  expect(tile(html, "deploys").n).toBe("0");
  expect(tile(html, "merged").n).toBe("0");
  for (const line of ["Nothing waits for you.", "No task is running.", "Nothing has merged or deployed today."]) expect(html.split(line).length - 1, line).toBe(1);
  expect(html).not.toContain(">Nothing.<");
});
