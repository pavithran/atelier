import { env, runInDurableObject } from "./support/workers.ts";
import { expect, it } from "./support/vitest.ts";
import { Ledger } from "../src/ledger.ts";
import { DEFAULT_THRESHOLDS, type UsageReport } from "../src/usage/report.ts";
import type { RunnerOffer } from "../src/dispatch/rules.ts";
import type { ModelEntry } from "../src/models/pool.ts";
import type { SlateOrder } from "../src/models/slate.ts";
import { SLATE_JOBS } from "../src/models/slate.ts";
import { withoutDefaultRunner } from "./support/default-runner.ts";
import type { MovedRecord, HeldRecord, SlateRecord } from "../src/models/slate-store.ts";

// t598: the slate's records and effective pick on real Durable Object SQLite.
// The test runtime's default review runner would offer models at the real clock; these tests set the offers themselves.
withoutDefaultRunner();
const T0 = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000, HOUR = 3_600_000;

const model = (harness: ModelEntry["harness"], id: string, family: ModelEntry["family"]): ModelEntry =>
  ({ id, harness, where: "home", provider: "subscription", aliases: [], family, note: "", addedBy: "pavi", addedAt: "2026-10-13T12:00:00.000Z" });
const ASTRA = "codex/gpt-6-astra", OPUS = "claude-code/opus-5.5", GLM = "zcode/glm-5";
const everyJob = (list: string[]): SlateOrder => Object.fromEntries(SLATE_JOBS.map((j) => [j, list])) as SlateOrder;
const ORDER = everyJob([ASTRA, OPUS]);

const reportOf = (tool: string, at: number, windows: UsageReport["windows"] = [{ name: "weekly", usedPercent: 10, resetsAt: null, at: iso(at) }]): UsageReport =>
  ({ tool, runner: "home:studio", at: iso(at), windows, models: [], balances: [], notes: [], });
const limitWindow = (at: number, resetsAt: number): UsageReport["windows"] => [{ name: "limit", usedPercent: 100, resetsAt: iso(resetsAt), at: iso(at) }];
const offerOf = (runner: string, agent: string, id: string, readiness?: unknown): RunnerOffer =>
  ({ runner, kind: "home" as const, agents: [{ agent, models: [id] }], jobs: ["build", "review"], ...(readiness ? { readiness } : {}) }) as RunnerOffer;

async function ledgerOf(name: string, test: (ledger: Ledger) => Promise<void> | void) {
  const stub = env.LEDGER.get(env.LEDGER.idFromName(`slate:${name}`));
  await runInDurableObject(stub, async (instance) => {
    const ledger = instance as unknown as Ledger;
    for (const m of [model("codex", "gpt-6-astra", "openai"), model("claude-code", "opus-5.5", "anthropic"), model("zcode", "glm-5", "zai")]) ledger.putModel(m);
    await test(ledger);
  });
}
const approve = (ledger: Ledger, request: string, replaces: string | null, order = ORDER) =>
  ledger.writeSlateRecord({ kind: "approved", request, replaces, order, limits: {} }, iso(T0));
const put = (ledger: Ledger, r: UsageReport) => ledger.putUsage(r, DEFAULT_THRESHOLDS);
const kinds = (ledger: Ledger) => ledger.slateRecords().map((r) => r.kind);
const movedBuild = (ledger: Ledger) => ledger.slateRecords().filter((r): r is MovedRecord => r.kind === "moved" && r.job === "build");
const heldBuild = (ledger: Ledger) => ledger.slateRecords().filter((r): r is HeldRecord => r.kind === "held" && r.job === "build");

it("criterion 6: each record names the one it supersedes; a stale replaces is refused 409 with the current id; of two writes at once naming one id, one records", async () => {
  await ledgerOf("chain", async (ledger) => {
    const first = approve(ledger, "request-0001", null);
    expect(first.id).toBe("s1");
    expect(first.supersedes).toBeUndefined();
    const second = ledger.writeSlateRecord({ kind: "adjusted", request: "request-0002", replaces: "s1", order: everyJob([OPUS]), limits: {} }, iso(T0));
    expect(second).toMatchObject({ id: "s2", supersedes: "s1" });
    expect(() => approve(ledger, "request-0003", "s1")).toThrow(/s2 is current, not s1/);
    expect(() => approve(ledger, "request-0003", null)).toThrow(/s2 is current/);
    expect(() => ledger.writeSlateRecord({ kind: "moved", request: "request-0004", replaces: "s2", order: ORDER, limits: {} }, iso(T0))).toThrow(/slate write is one of/);
    try { approve(ledger, "request-0003", "s1"); } catch (e) { expect((e as { status: number }).status).toBe(409); }
    expect(kinds(ledger)).toEqual(["approved", "adjusted"]);
  });
  const stub = env.LEDGER.get(env.LEDGER.idFromName("slate:race"));
  await runInDurableObject(stub, (instance) => { (instance as unknown as Ledger).writeSlateRecord({ kind: "approved", request: "request-0001", replaces: null, order: ORDER, limits: {} }, iso(T0)); });
  const write = (request: string) => (stub as unknown as Ledger).writeSlateRecord({ kind: "adjusted", request, replaces: "s1", order: everyJob([OPUS]), limits: {} }, iso(T0));
  const settled = await Promise.allSettled([write("request-000a"), write("request-000b")]);
  expect(settled.map((s) => s.status).sort()).toEqual(["fulfilled", "rejected"]);
  await runInDurableObject(stub, (instance) => { expect((instance as unknown as Ledger).slateRecords().map((r) => r.id)).toEqual(["s1", "s2"]); });
});

it("criterion 7: a request id sent again with the same body returns the first record marked retried and writes nothing; another body or no id is refused", async () => {
  await ledgerOf("retry", (ledger) => {
    const first = approve(ledger, "request-0001", null);
    expect(first.retried).toBeUndefined();
    ledger.writeSlateRecord({ kind: "adjusted", request: "request-0002", replaces: "s1", order: everyJob([OPUS]), limits: {} }, iso(T0));
    // a resend after a lost response, even after later records
    const again = approve(ledger, "request-0001", null);
    expect(again).toMatchObject({ id: "s1", retried: true });
    expect(ledger.slateRecords()).toHaveLength(2);
    expect(() => approve(ledger, "request-0001", null, everyJob([GLM]))).toThrow(/request-0001 already recorded s1, with other content/);
    expect(() => ledger.writeSlateRecord({ kind: "approved", request: undefined, replaces: "s2", order: ORDER, limits: {} }, iso(T0))).toThrow(/needs a request id/);
    expect(() => ledger.writeSlateRecord({ kind: "approved", request: "", replaces: "s2", order: ORDER, limits: {} }, iso(T0))).toThrow(/needs a request id/);
    expect(ledger.slateRecords()).toHaveLength(2);
  });
});

it("criterion 8: an Eastern day's first proposeSlate records proposed, or approved 'unchanged from sN'; later calls and two at once record nothing more", async () => {
  // 04:59Z on 10 November is 23:59 on the 9th in New York (EST); 05:01Z is 00:01 on the 10th
  const before = "2026-11-10T04:59:00.000Z", still = "2026-11-10T04:59:30.000Z", after = "2026-11-10T05:01:00.000Z", later = "2026-11-10T20:00:00.000Z";
  await ledgerOf("propose", (ledger) => {
    expect(ledger.proposeSlate(before)?.kind).toBe("proposed");     // nothing stands yet
    expect(ledger.proposeSlate(still)).toBeNull();
    expect(kinds(ledger)).toEqual(["proposed"]);
    ledger.writeSlateRecord({ kind: "approved", request: "request-0001", replaces: "s1", order: ORDER, limits: {} }, before);
    const next = ledger.proposeSlate(after);                         // the next Eastern day, the same order
    expect(next).toMatchObject({ kind: "approved", note: "unchanged from s2" });
    expect(ledger.proposeSlate(later)).toBeNull();
    expect(kinds(ledger)).toEqual(["proposed", "approved", "approved"]);
    ledger.setSlateVendorLimits("atelier", ["anthropic", "openai"]);  // a limit differs from the standing record
    expect(ledger.proposeSlate("2026-11-11T15:00:00.000Z")?.kind).toBe("proposed");
    expect(ledger.proposeSlate("2026-11-11T16:00:00.000Z")).toBeNull();
  });
  const stub = env.LEDGER.get(env.LEDGER.idFromName("slate:propose-race"));
  const both = await Promise.all([(stub as unknown as Ledger).proposeSlate(after), (stub as unknown as Ledger).proposeSlate(after)]);
  expect(both.filter((r) => r !== null)).toHaveLength(1);
  await runInDurableObject(stub, (instance) => { expect((instance as unknown as Ledger).slateRecords()).toHaveLength(1); });
});

it("criterion 9: with no new record, a stale readiness report, a vanished offer or a passed resetsAt changes the effective pick; with no approved record there is none", async () => {
  await ledgerOf("effective-readiness", (ledger) => {
    expect(ledger.slatePicks(iso(T0)).build.pick).toBeNull();
    expect(Object.values(ledger.slatePicks(iso(T0))).every((p) => p.pick === null)).toBe(true);
    approve(ledger, "request-0001", null);
    put(ledger, reportOf("codex", T0)); put(ledger, reportOf("claude-code", T0));
    expect(ledger.slatePicks(iso(T0)).build.pick).toBe(ASTRA);
    const records = ledger.slateRecords().length;
    // codex was probed at T0, claude-code 20 minutes later; at T0+30 only codex's report has passed 25 minutes
    const ready = (probedAt: number, harness: string) => ({ harnesses: [{ harness, state: "ready", probedAt: iso(probedAt), recovery: null }], tokens: [] });
    ledger.putRunnerOffer(offerOf("home:a", "codex", "gpt-6-astra", ready(T0, "codex")), iso(T0));
    ledger.putRunnerOffer(offerOf("home:b", "claude-code", "opus-5.5", ready(T0 + 20 * MIN, "claude-code")), iso(T0 + 20 * MIN));
    expect(ledger.slatePicks(iso(T0 + 10 * MIN)).build.pick).toBe(ASTRA);
    expect(ledger.slatePicks(iso(T0 + 30 * MIN)).build.pick).toBe(OPUS);
    expect(ledger.slateRecords()).toHaveLength(records);
  });
  await ledgerOf("effective-offer", (ledger) => {
    approve(ledger, "request-0001", null);
    put(ledger, reportOf("codex", T0)); put(ledger, reportOf("claude-code", T0));
    ledger.putRunnerOffer(offerOf("home:a", "codex", "gpt-6-astra"), iso(T0));
    ledger.putRunnerOffer(offerOf("home:b", "claude-code", "opus-5.5"), iso(T0 + 90 * MIN));
    const records = ledger.slateRecords().length;
    expect(ledger.slatePicks(iso(T0 + 60 * MIN)).build.pick).toBe(ASTRA);
    // runner a last asked 150 minutes ago, past the two hours an offer lives; b is live and does not offer codex
    expect(ledger.slatePicks(iso(T0 + 150 * MIN)).build.pick).toBe(OPUS);
    expect(ledger.slateRecords()).toHaveLength(records);
  });
  await ledgerOf("effective-reset", (ledger) => {
    approve(ledger, "request-0001", null);
    put(ledger, reportOf("claude-code", T0));
    put(ledger, reportOf("codex", T0 + 1000, limitWindow(T0 + 1000, T0 + HOUR)));
    const records = ledger.slateRecords().length;
    expect(ledger.slatePicks(iso(T0 + 30 * MIN)).build.pick).toBe(OPUS);
    expect(ledger.slatePicks(iso(T0 + 90 * MIN)).build.pick).toBe(ASTRA);   // the limit's resetsAt has passed
    expect(ledger.slateRecords()).toHaveLength(records);
  });
});

// A write to model_slates that fails, as a crash between the usage write and the slate record would.
function crashOnSlateWrite(ledger: Ledger): () => void {
  const real = (ledger as unknown as { sql: SqlStorage }).sql;
  (ledger as unknown as { sql: unknown }).sql = new Proxy(real, {
    get: (target, key) => key === "exec"
      ? (query: string, ...args: unknown[]) => { if (/INSERT INTO model_slates/.test(query)) throw new Error("crash"); return (target.exec as (...a: unknown[]) => unknown)(query, ...args); }
      : typeof (target as never)[key] === "function" ? ((target as never)[key] as (...a: unknown[]) => unknown).bind(target) : (target as never)[key],
  });
  return () => { (ledger as unknown as { sql: unknown }).sql = real; };
}
const codexLimited = () => reportOf("codex", T0 + 1000, limitWindow(T0 + 1000, T0 + HOUR));
const codexWeekly = (percent: number, at: number) => reportOf("codex", at, [{ name: "weekly", usedPercent: percent, resetsAt: null, at: iso(at) }]);

it("criterion 10: a putUsage that changes a pick writes one moved record in the same call; the same report again, or a change that keeps the pick, writes none; a crash leaves both or neither", async () => {
  await ledgerOf("moved", (ledger) => {
    approve(ledger, "request-0001", null);
    put(ledger, reportOf("codex", T0)); put(ledger, reportOf("claude-code", T0));
    expect(movedBuild(ledger)).toEqual([]);
    put(ledger, codexLimited());
    expect(movedBuild(ledger)).toHaveLength(1);
    expect(movedBuild(ledger)[0]).toMatchObject({ job: "build", from: ASTRA, to: OPUS, supersedes: "s1" });
    expect(movedBuild(ledger)[0].cause).toMatch(/codex/);
    const records = ledger.slateRecords().length;
    put(ledger, codexLimited());                                      // the same report again
    put(ledger, reportOf("claude-code", T0 + 2000, [{ name: "weekly", usedPercent: 20, resetsAt: null, at: iso(T0 + 2000) }]));   // a change that keeps the pick
    expect(ledger.slateRecords()).toHaveLength(records);
  });
  await ledgerOf("moved-crash", (ledger) => {
    approve(ledger, "request-0001", null);
    put(ledger, reportOf("codex", T0)); put(ledger, reportOf("claude-code", T0));
    const restore = crashOnSlateWrite(ledger);
    expect(() => put(ledger, codexLimited())).toThrow(/crash/);
    restore();
    expect(ledger.usage().find((r) => r.tool === "codex")!.windows.map((w) => w.name)).toEqual(["weekly"]);   // neither
    expect(ledger.slateRecords()).toHaveLength(1);
    put(ledger, codexLimited());                                      // the replay writes both
    expect(ledger.usage().find((r) => r.tool === "codex")!.windows.map((w) => w.name)).toEqual(["limit"]);
    expect(movedBuild(ledger)).toHaveLength(1);
  });
  await ledgerOf("moved-pause", (ledger) => {
    approve(ledger, "request-0001", null);
    put(ledger, reportOf("codex", T0)); put(ledger, reportOf("claude-code", T0));
    const now = Date.now();
    const memory = { refused: [], gaveUp: [], failures: [], infrastructure: [], skipHeads: [], reasons: [], backoff: [], pauses: [{ harness: "codex", reason: "limit", resetAt: iso(now + HOUR), since: iso(now), fallback: false }] };
    ledger.askQueue({ ...offerOf("home:a", "codex", "gpt-6-astra"), memory } as never, iso(now));
    expect(movedBuild(ledger)).toMatchObject([{ job: "build", from: ASTRA, to: OPUS }]);
    expect(movedBuild(ledger)[0].cause).toMatch(/pause/);
    const records = ledger.slateRecords().length;
    ledger.askQueue({ ...offerOf("home:a", "codex", "gpt-6-astra"), memory } as never, iso(now + 1000));   // the same pause again
    expect(ledger.slateRecords()).toHaveLength(records);
  });
});

it("criterion 11: every approved model unavailable writes one held record naming the next pick outside the order, with the pick none; a repeat writes none; availability back writes moved back", async () => {
  await ledgerOf("held", (ledger) => {
    approve(ledger, "request-0001", null, everyJob([ASTRA]));
    put(ledger, reportOf("codex", T0)); put(ledger, reportOf("claude-code", T0));
    put(ledger, codexLimited());
    expect(ledger.slatePicks().build.pick).toBeNull();
    expect(heldBuild(ledger)).toHaveLength(1);
    expect(heldBuild(ledger)[0]).toMatchObject({ job: "build", from: ASTRA, next: OPUS });   // known usage first; the order does not hold it
    expect(movedBuild(ledger)).toEqual([]);
    const records = ledger.slateRecords().length;
    put(ledger, codexLimited());                                       // a repeat
    put(ledger, reportOf("codex", T0 + 2000, limitWindow(T0 + 2000, T0 + 2 * HOUR)));   // a change that keeps the pick none
    expect(heldBuild(ledger)).toHaveLength(1);
    expect(ledger.slateRecords()).toHaveLength(records);
    put(ledger, codexWeekly(10, T0 + 3000));                           // availability back
    expect(movedBuild(ledger)).toMatchObject([{ job: "build", from: null, to: ASTRA }]);
    expect(ledger.slatePicks().build.pick).toBe(ASTRA);
  });
  await ledgerOf("held-crash", (ledger) => {
    approve(ledger, "request-0001", null, everyJob([ASTRA]));
    put(ledger, reportOf("codex", T0));
    const now = Date.now();
    const memory = { refused: [], gaveUp: [], failures: [], infrastructure: [], skipHeads: [], reasons: [], backoff: [], pauses: [{ harness: "codex", reason: "limit", resetAt: iso(now + HOUR), since: iso(now), fallback: false }] };
    const restore = crashOnSlateWrite(ledger);
    expect(() => ledger.askQueue({ ...offerOf("home:a", "codex", "gpt-6-astra"), memory } as never, iso(now))).toThrow(/crash/);
    restore();
    expect(ledger.providerPauses()).toEqual([]);                      // neither the pause...
    expect(heldBuild(ledger)).toEqual([]);                            // ...nor the held record
    ledger.askQueue({ ...offerOf("home:a", "codex", "gpt-6-astra"), memory } as never, iso(now));   // the replay writes both
    expect(ledger.providerPauses()).toHaveLength(1);
    expect(heldBuild(ledger)).toHaveLength(1);
  });
});

it("criterion 5: a project whose vendor limits list anthropic, openai, google shows no zai model in any job; a project with no row is unfiltered; one slate is stored either way", async () => {
  await ledgerOf("limits", (ledger) => {
    const order = everyJob([GLM, OPUS, ASTRA]);
    approve(ledger, "request-0001", null, order);
    ledger.setSlateVendorLimits("limited", ["anthropic", "openai", "google"]);
    const now = iso(T0);
    const limited = ledger.slateFor("limited", now)!.slate, free = ledger.slateFor("free", now)!.slate;
    expect(free.build.recommended).toBe(GLM);
    for (const job of SLATE_JOBS) {
      expect([limited[job].recommended, ...limited[job].alternates].filter((a) => a?.includes("glm"))).toEqual([]);
      expect(limited[job].dropped.some((d) => d.actor === GLM && /zai/.test(d.reason))).toBe(true);
    }
    expect(limited.build.recommended).toBe(OPUS);
    expect(ledger.slateRecords()).toHaveLength(1);
  });
});

it("global pick: a runner scoped to one project still serves the global slate, and pausing its harness writes the held record in the same call", async () => {
  await ledgerOf("global-scoped", (ledger) => {
    approve(ledger, "request-0001", null, everyJob([ASTRA]));
    put(ledger, reportOf("codex", T0));
    const now = Date.now();
    const scoped = { ...offerOf("home:a", "codex", "gpt-6-astra"), projects: ["atelier"] };
    const memory = (pauses: unknown[]) => ({ refused: [], gaveUp: [], failures: [], infrastructure: [], skipHeads: [], reasons: [], backoff: [], pauses });
    ledger.askQueue({ ...scoped, memory: memory([]) } as never, iso(now));
    expect(ledger.slatePicks().build.pick).toBe(ASTRA);
    const pause = [{ harness: "codex", reason: "limit", resetAt: iso(now + HOUR), since: iso(now), fallback: false }];
    ledger.askQueue({ ...scoped, memory: memory(pause) } as never, iso(now + 1000));
    expect(ledger.slatePicks().build.pick).toBeNull();
    expect(heldBuild(ledger)).toHaveLength(1);
  });
});
