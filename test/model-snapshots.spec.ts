import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker, { replayModelSnapshot, takeModelSnapshots } from "../src/index.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import type { ModelComparison } from "../src/models/compare.ts";
import { addDays, BACKFILL_DAYS, daysDue, measureHeading, trendPointText, utcDay, type ModelTrend, type SnapshotTake } from "../src/models/snapshot.ts";
import { suggestionRecords } from "../src/models/suggestion-records.ts";
import { signIn } from "./signin.ts";

// t623 through the Worker and the index Ledger: the scheduled handler takes
// each ended UTC day once, a retried, repeated or concurrent run stores
// nothing twice, missed days are filled as reconstructions, an unreadable
// Ledger leaves a partial snapshot that a later run revises while keeping
// it, a replay from the recorded cutoffs gives the stored figures after
// later verdicts, served annotations, run reports, assignments, a rename and
// an alias, GET /api/models/ID/trend and the Models page show one
// projection, and routing reads the same with or without snapshots.

const TOKEN = "model-snapshots-test-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const DAY_MS = 86_400_000;
const T0 = Date.now();
const TODAY = utcDay(T0);
const AT = new Date(T0).toISOString();
const H0 = "0".repeat(40), HEAD = "e".repeat(40);
const OPUS = "claude-code/opus-5.5", GPT = "codex/gpt-6-astra", GEMINI = "antigravity/gemini-4-argon", FAST = "codex/astra-fast";
const NAME = "snapshots-a", RENAMED = "snapshots-b";
const entry = (id: string, harness: ModelEntry["harness"], extra: Partial<ModelEntry> = {}): ModelEntry => ({
  id, harness, where: "cloud", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: AT, ...extra,
});
const index = () => env.LEDGER.get(env.LEDGER.idFromName("__index"));
const L = (key = NAME) => env.LEDGER.get(env.LEDGER.idFromName(`project:${key}`));
const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => worker.fetch(new Request(`https://atelier.test/api${path}`, {
  method, headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
}), testEnv);
const takes = (from: string, to: string) => index().modelSnapshotTakes(from, to) as unknown as Promise<SnapshotTake[]>;
// Seven minutes past a UTC midnight `days` days from today, so later runs the
// same day stay on it.
const past = (days: number) => Date.parse(`${addDays(TODAY, days)}T00:07:00.000Z`);
const scheduled = (at: number) => worker.scheduled({ scheduledTime: at, cron: "7 */6 * * *", noRetry() {} } as ScheduledController, testEnv);

let seeded = false;
async function seed() {
  if (seeded) return;
  seeded = true;
  for (const m of [entry("opus-5.5", "claude-code"), entry("gpt-6-astra", "codex"), entry("gemini-4-argon", "antigravity")]) await index().putModel(m);
  const record = { name: NAME, repo: NAME, policy: { checks: ["npm test"], protected: [] }, createdAt: AT };
  await L().setProject(record, "owner");
  await index().registerProject(record);
  // Five tasks OPUS built, GPT rejected with a blocking finding the developer confirmed, and GEMINI approved.
  for (let i = 0; i < 5; i++) {
    const { id } = await L().newItem(`Lease rework ${i}`, ["src/lease.ts"], "owner", { accept: ["The lease holds"] });
    await L().claim(id, OPUS, { runner: "home:studio", kind: "home" });
    await L().setFork(id, `fork-${id}`, H0, OPUS);
    await L().recordPush(id, OPUS, HEAD, HEAD);
    await L().addEvidence({ itemId: id, claim: "npm test", grade: "observed", head: HEAD, passed: true, by: OPUS, at: new Date().toISOString(), changedPaths: ["src/lease.ts"] });
    await L().submit(id, OPUS);
    const criteria = await L().criteria(id);
    await L().addReview({ itemId: id, criteria, by: GEMINI, head: HEAD, approve: true, note: "fine", at: new Date().toISOString() });
    await L().addReview({ itemId: id, criteria, by: GPT, head: HEAD, approve: false, note: "race", at: new Date().toISOString(), findings: [{ file: "src/lease.ts", line: 3, severity: "blocking", text: "the lease can be taken twice" }] });
    await L().addFinding(id, "owner", HEAD, 1, "confirmed", "", { reviewer: GPT });
  }
  // One more, rejected under a name the pool does not have yet; the replay
  // test later makes it an alias of gpt-6-astra.
  const { id } = await L().newItem("Lease rework 5", ["src/lease.ts"], "owner", { accept: ["The lease holds"] });
  await L().claim(id, OPUS, { runner: "home:studio", kind: "home" });
  await L().setFork(id, `fork-${id}`, H0, OPUS);
  await L().recordPush(id, OPUS, HEAD, HEAD);
  await L().submit(id, OPUS);
  await L().addReview({ itemId: id, criteria: await L().criteria(id), by: FAST, head: HEAD, approve: false, note: "race", at: new Date().toISOString(), findings: [{ file: "src/lease.ts", line: 3, severity: "blocking", text: "the lease can be taken twice" }] });
  await L().addFinding(id, "owner", HEAD, 1, "confirmed", "", { reviewer: FAST });
}
const precisionOf = (rows: { model: string; role: string; figures: { measure: string; numerator: number | null; denominator: number | null }[] }[]) =>
  rows.find((r) => r.model === "gpt-6-astra" && r.role === "review")!.figures.find((f) => f.measure === "review-precision")!;

it("routing reads the same records with snapshots stored as without, and a snapshot adds no event and no run report", async () => {
  await seed();
  const read = () => suggestionRecords(index() as never, (p) => L(p.key ?? p.name) as never);
  const before = await read();
  const events = await index().events(undefined, 10_000);
  const at = past(500);
  expect((await takeModelSnapshots(testEnv, at)).length).toBe(BACKFILL_DAYS);
  expect(await read()).toEqual(before);
  expect(await index().events(undefined, 10_000)).toEqual(events);
});

it("a scheduler run takes each ended day once: a retry, a repeat and a concurrent run store nothing twice", async () => {
  await seed();
  const at = past(200);
  const [a, b] = await Promise.all([takeModelSnapshots(testEnv, at), takeModelSnapshots(testEnv, at)]);
  const due = daysDue(at, new Set());
  // Two runs at once: each day stored by one of them, at revision 1.
  for (const day of due) {
    const stored = [...a, ...b].filter((x) => x.day === day);
    expect(stored.filter((x) => x.stored).length, day).toBe(1);
    expect(stored.every((x) => x.rev === 1), day).toBe(true);
  }
  const kept = await takes(due[due.length - 1], due[0]);
  expect(kept.map((t) => [t.day, t.rev])).toEqual([...due].reverse().map((d) => [d, 1]));
  // The cron firing again, and a retry later the same day: nothing due, nothing written.
  await scheduled(at);
  expect(await takeModelSnapshots(testEnv, at + 6 * 3_600_000)).toEqual([]);
  expect(await takes(due[due.length - 1], due[0])).toEqual(kept);
});

it("missed days are filled by the next run as reconstructions, and the day just ended is the original", async () => {
  await seed();
  const first = past(300);
  await takeModelSnapshots(testEnv, first);
  // Three days with no run.
  const later = first + 3 * DAY_MS;
  const filled = await takeModelSnapshots(testEnv, later);
  const last = addDays(utcDay(later), -1);
  expect(filled.map((x) => x.day)).toEqual([last, addDays(last, -1), addDays(last, -2)]);
  const kept = await takes(addDays(last, -2), last);
  expect(kept.map((t) => [t.day, t.origin])).toEqual([[addDays(last, -2), "reconstructed"], [addDays(last, -1), "reconstructed"], [last, "original"]]);
});

it("a replay from the recorded cutoffs gives the stored figures after later verdicts, a served annotation, a run report, an assignment, a rename and an alias", async () => {
  await seed();
  // The day under way is taken as if the scheduler ran just after it ended.
  const at = Date.parse(`${addDays(TODAY, 1)}T00:07:00.000Z`);
  const taken = await takeModelSnapshots(testEnv, at);
  expect(taken.find((x) => x.day === TODAY)).toMatchObject({ stored: true, rev: 1, complete: true });
  const stored = (await index().modelSnapshot(TODAY))!;
  expect(stored.take.origin).toBe("original");
  expect(stored.take.cutoffs.ledgers.find((c) => c.key === NAME)?.name).toBe(NAME);
  expect(precisionOf(stored.rows)).toMatchObject({ numerator: 5, denominator: 5 });

  // Later the same day: the developer corrects a verdict, says another model
  // served a review, a runner reports a stalled run, a role is assigned, the
  // project is renamed and the pool gains an alias.
  await L().addFinding("t1", "owner", HEAD, 1, "refuted", "not a race after all", { reviewer: GPT });
  const window = { from: new Date(T0 - DAY_MS).toISOString(), to: new Date(Date.now() + DAY_MS).toISOString() };
  expect((await L().annotateServed({ served: "deepseek-flash", recorded: GEMINI, ...window, items: ["t2"], note: "" }, "owner", true)).annotated).toBeGreaterThan(0);
  await index().putRun({ actor: OPUS, role: "build", outcome: "stalled", project: NAME, item: "t3", detail: "", runner: "home:studio", at: new Date().toISOString() });
  const assigned = await call("POST", "/model-roles", { request: crypto.randomUUID(), role: "review", choices: [GPT], reason: "it catches races", quote: "astra reviews", evidence: [`${NAME}/t1`] }, { "x-atelier-acting": GPT });
  expect(assigned.status, await assigned.clone().text()).toBe(201);
  await index().renameProject(NAME, RENAMED);
  await index().putModel(entry("gpt-6-astra", "codex", { aliases: ["astra-fast"] }));

  // Read now, the record says something else.
  const now = await (await call("GET", "/models/codex%2Fgpt-6-astra/compare")).json() as ModelComparison;
  // One verdict refuted, and the alias's confirmed finding now gpt-6-astra's.
  expect(now.roles.find((r) => r.role === "review")!.figures.find((f) => f.measure === "review-precision")).toMatchObject({ numerator: 5, denominator: 6 });
  expect(now.names).toContain("astra-fast");
  // The replay, from the stored cutoffs, gives what was stored.
  const replay = (await replayModelSnapshot(testEnv, TODAY))!;
  expect(replay.differences).toEqual([]);
  expect(precisionOf(replay.replayed)).toMatchObject({ numerator: 5, denominator: 5 });
  expect(replay.stored.take.cutoffs.ledgers.find((c) => c.key === NAME)?.name).toBe(NAME);
  // And the scheduler, run again, leaves the complete day as it was.
  expect((await takeModelSnapshots(testEnv, at + 3_600_000)).find((x) => x.day === TODAY)).toBeUndefined();
  expect((await index().modelSnapshot(TODAY))!.take.rev).toBe(1);
});

it("GET /api/models/ID/trend and the Models page show one projection, the developer's alone", async () => {
  await seed();
  const res = await call("GET", "/models/codex%2Fgpt-6-astra/trend");
  expect(res.status, await res.clone().text()).toBe(200);
  const trend = await res.json() as ModelTrend;
  expect(trend.model).toBe("gpt-6-astra");
  expect(trend.to).toBe(addDays(TODAY, -1));
  // The earlier tests' run at the day after today took the six days before it.
  expect(trend.snapshots).toBeGreaterThanOrEqual(BACKFILL_DAYS - 1);
  const precision = trend.measures.find((m) => m.measure === "review-precision")!;
  expect(precision.points.length).toBeGreaterThan(0);
  // The seeded work was recorded today, after each of those days ended: none yet, a gap and no zero.
  const last = precision.points[precision.points.length - 1];
  expect([last.day, last.value, last.gap, last.denominator]).toEqual([addDays(TODAY, -1), null, "none yet", 0]);
  // An agent's token reads none of it.
  const agent = (await (await call("POST", "/tokens", { actor: GPT, projects: [RENAMED], label: "agent" })).json() as { token: string }).token;
  const refused = await worker.fetch(new Request("https://atelier.test/api/models/gpt-6-astra/trend", { headers: { authorization: `Bearer ${agent}`, "x-atelier-actor": GPT } }), testEnv);
  expect(refused.status).toBe(403);
  // The page renders the same texts, escaped.
  const cookie = await signIn(TOKEN, testEnv);
  const page = await (await worker.fetch(new Request("https://atelier.test/models", { headers: { cookie } }), testEnv)).text();
  const section = page.split('<section class="trend"')[1]?.split("</section>")[0] ?? "";
  expect(section).toContain("Atelier's record over time</h2>");
  const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  for (const m of trend.measures) {
    expect(section).toContain(esc(measureHeading(m)));
    for (const p of m.points) expect(section).toContain(esc(trendPointText(p, m.kind)));
  }
});

it("an unreadable Ledger leaves the day partial; a later run revises it and keeps the partial one beside it", async () => {
  await seed();
  const ghost = "snapshots-ghost";
  await index().registerProject({ name: ghost, repo: ghost, policy: { checks: [], protected: [] }, createdAt: AT });
  await L(ghost).setProject({ name: ghost, repo: ghost, policy: { checks: [], protected: [] }, createdAt: AT }, "owner");
  // Its Ledger cannot be read while `down` holds: every call to it fails.
  const ghostId = env.LEDGER.idFromName(`project:${ghost}`).toString();
  let down = true;
  const ledgers = {
    idFromName: (n: string) => env.LEDGER.idFromName(n),
    get: (id: DurableObjectId) => (down && id.toString() === ghostId ? { events: () => Promise.reject(new Error("the Ledger is unreachable")) } : env.LEDGER.get(id)),
  };
  const flaky = { ...testEnv, LEDGER: ledgers } as unknown as typeof env;
  const at = past(700);
  const first = await takeModelSnapshots(flaky, at);
  expect(first.length).toBe(BACKFILL_DAYS);
  expect(first.every((x) => x.stored && !x.complete)).toBe(true);
  const day = addDays(utcDay(at), -1);
  const partial = (await index().modelSnapshot(day))!;
  expect(partial.take.coverage.unread).toEqual([ghost]);
  expect(partial.take.cutoffs.unread).toEqual([{ key: ghost, name: ghost }]);
  // Retried while the Ledger is still unreadable: the same partial snapshot, nothing stored.
  expect((await takeModelSnapshots(flaky, at + 3_600_000)).every((x) => !x.stored && x.rev === 1)).toBe(true);
  // The Ledger readable again: each day revised, the partial one kept.
  down = false;
  const second = await takeModelSnapshots(flaky, at + 7_200_000);
  expect(second.every((x) => x.stored && x.complete && x.rev === 2)).toBe(true);
  const both = (await takes(day, day)).map((t) => [t.rev, t.revises, t.complete]);
  expect(both).toEqual([[1, null, false], [2, 1, true]]);
  expect((await index().modelSnapshot(day, 1))!.take.complete).toBe(false);
  // Complete now: a further run takes nothing.
  expect(await takeModelSnapshots(testEnv, at + 10_800_000)).toEqual([]);
});

// Finding (gpt-6-astra, t623): snapshots read only the newest 1,000 run
// reports, so a model whose reports were older than the newest 1,000 showed
// none, a false trend. The day here has 1,100 stalled build runs by OPUS and
// then 1,100 by GEMINI; its figure must count all of OPUS's, and a read that
// cannot finish must leave the day partial.
const stalled = (actor: string, at: string) => ({ actor, role: "build" as const, outcome: "stalled" as const, project: null, item: null, detail: "", runner: "home:studio", at });
const stallFigure = (rows: { model: string; role: string; figures: { measure: string; numerator: number | null; denominator: number | null }[] }[], model: string) =>
  rows.find((r) => r.model === model && r.role === "build")!.figures.find((f) => f.measure === "build-stalled")!;
async function seedManyRuns(day: string) {
  await seed();
  const at = `${day}T12:00:00.000Z`;
  for (const actor of [OPUS, GEMINI]) for (let i = 0; i < 1100; i++) await index().putRun(stalled(actor, at));
}

it("run reports beyond the newest 1,000 are all read: the figures equal those computed from every report", async () => {
  const day = addDays(TODAY, 40);
  await seedManyRuns(day);
  const all: { actor: string; outcome: string; at: string }[] = [];
  for (let after: number | null = null; ;) {
    const page: { runs: typeof all; next: number | null } = await index().runsPage(null, `${addDays(day, 1)}T00:00:00.000Z`, after, 300);
    all.push(...page.runs);
    if (page.next === null) break;
    after = page.next;
  }
  expect(all.length).toBeGreaterThanOrEqual(2200);
  const taken = await takeModelSnapshots(testEnv, Date.parse(`${addDays(day, 1)}T00:07:00.000Z`));
  expect(taken.find((x) => x.day === day)).toMatchObject({ stored: true, complete: true });
  const stored = (await index().modelSnapshot(day))!;
  expect(stored.take.runsRead).toBe(true);
  const countOf = (actor: string) => all.filter((r) => r.actor === actor && r.outcome === "stalled" && r.at.startsWith(day)).length;
  expect(countOf(OPUS)).toBeGreaterThanOrEqual(1100);
  expect(stallFigure(stored.rows, "opus-5.5")).toMatchObject({ numerator: countOf(OPUS), denominator: countOf(OPUS) });
  expect(stallFigure(stored.rows, "gemini-4-argon")).toMatchObject({ numerator: countOf(GEMINI), denominator: countOf(GEMINI) });
  // And a replay from the recorded cutoffs gives the same.
  expect((await replayModelSnapshot(testEnv, day))!.differences).toEqual([]);
});

it("a run-report read that cannot finish leaves the day partial, and a later read revises it", async () => {
  const day = addDays(TODAY, 41);
  await seedManyRuns(day);
  let down = true;
  const ledgers = {
    idFromName: (n: string) => env.LEDGER.idFromName(n),
    get: (id: DurableObjectId) => {
      const stub = env.LEDGER.get(id) as unknown as Record<string, unknown>;
      // The second page of run reports fails while `down` holds.
      return new Proxy(stub, { get: (t, k) => (k === "runsPage" && down ? (c: number | null, b: string, after: number | null, l?: number) => (after === null ? (t.runsPage as (...a: unknown[]) => unknown)(c, b, after, l ?? 500) : Promise.reject(new Error("the page cannot be read"))) : t[k as string]) });
    },
  };
  const flaky = { ...testEnv, LEDGER: ledgers } as unknown as typeof env;
  const at = Date.parse(`${addDays(day, 1)}T00:07:00.000Z`);
  const first = await takeModelSnapshots(flaky, at);
  expect(first.find((x) => x.day === day)).toMatchObject({ stored: true, complete: false, rev: 1 });
  const partial = (await index().modelSnapshot(day))!;
  expect(partial.take.complete).toBe(false);
  expect(partial.take.runsRead).toBe(false);
  down = false;
  const second = await takeModelSnapshots(flaky, at + 3_600_000);
  expect(second.find((x) => x.day === day)).toMatchObject({ stored: true, complete: true, rev: 2 });
  expect((await index().modelSnapshot(day, 1))!.take.complete).toBe(false);
  // Finding (gpt-6-astra, t623): a partial revision recorded its upper cutoff
  // but not where the read stopped, so a replay after recovery read every
  // report below the cutoff and gave other figures. Revision 1 replays, once
  // the pages can be read, to exactly the figures it stored.
  expect((await index().modelSnapshot(day, 1))!.take.cutoffs.runsFrom).toBeGreaterThan(0);
  const replay = (await replayModelSnapshot(testEnv, day, 1))!;
  expect(replay.differences).toEqual([]);
  expect(replay.replayed).toEqual(partial.rows);
  expect(stallFigure(partial.rows, "opus-5.5").numerator).toBeLessThan(stallFigure((await index().modelSnapshot(day, 2))!.rows, "opus-5.5").numerator ?? 0);
});
