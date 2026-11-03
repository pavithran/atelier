import { env, runInDurableObject } from "./support/workers.ts";
import { expect, it } from "./support/vitest.ts";
import worker from "../src/index.ts";
import { reportLimits, stuckReport } from "../src/stuck/report.ts";

const inside = runInDurableObject as unknown as (stub: unknown, fn: (ledger: any) => unknown) => Promise<any>;
const L = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
async function project(name: string) {
  const record = { name, repo: name, policy: { checks: ["npm test"], protected: [] }, createdAt: new Date().toISOString() };
  await L(name).setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  return L(name);
}

it("the stuck route never reads another project's snapshot or events", async () => {
  await project("reads-own");
  const other = await project("reads-other");
  await inside(other, (ledger) => {
    ledger.stuckSnapshot = () => { throw new Error("other snapshot read"); };
    ledger.events = () => { throw new Error("other events read"); };
    const exec = ledger.sql.exec.bind(ledger.sql);
    ledger.sql.exec = (query: string, ...args: unknown[]) => {
      if (/\bevents\b/i.test(query)) throw new Error("other SQL event read");
      return exec(query, ...args);
    };
  });
  const token = "stuck-read-token";
  const response = await worker.fetch(new Request("https://atelier.test/api/projects/reads-own/stuck", {
    headers: { authorization: `Bearer ${token}`, "x-atelier-actor": "owner" },
  }), { ...env, ATELIER_TOKEN: token } as typeof env);
  expect(response.status).toBe(200);
  expect((await response.json() as any).unavailable).toEqual([]);
});

it("long terminal history is omitted without changing held, orphaned or stalled findings", async () => {
  const stub = await project("reads-history");
  const held = await stub.newItem("Held", ["src/a.ts"], "owner", { accept: ["works"] });
  const orphan = await stub.newItem("Orphan", ["src/a.ts"], "owner", { accept: ["works"] });
  const stalled = await stub.newItem("Stalled", [], "owner", { accept: ["works"] });
  const terminal = await stub.newItem("Finished", [], "owner");
  await stub.claim(held.id, "codex/gpt-6-astra");
  await stub.claim(orphan.id, "codex/gpt-6-astra");
  await stub.claim(stalled.id, "codex/gpt-6-astra");
  const waiting = await stub.newItem("Waiting", ["src/a.ts"], "owner");
  await stub.dispatch(waiting.id, "owner", { to: "home", agent: "codex", model: "gpt-6-astra" });
  await inside(stub, (ledger) => {
    const at = "2026-11-01T00:00:00.000Z";
    ledger.sql.exec("UPDATE items SET state = 'merged' WHERE id = ?", terminal.id);
    ledger.sql.exec("UPDATE items SET updated_at = ? WHERE state = 'claimed'", at);
    ledger.sql.exec("UPDATE items SET runner = 'home:gone' WHERE id = ?", orphan.id);
    ledger.sql.exec("UPDATE events SET at = ?", at);
    for (let n = 0; n < 5000; n++) ledger.sql.exec("INSERT INTO events (item_id, at, actor, kind, data) VALUES (?, ?, 'owner', 'note', ?)", terminal.id, at, JSON.stringify({ text: "x".repeat(512) }));
    // Ship rules need old project events, and the check list includes terminal tasks.
    for (const [id, kind, data, time] of [
      [null, "action.started", { ship: "s1", step: "check", command: "npm test" }, at],
      [terminal.id, "evidence.observed", { passed: false }, "2026-11-03T00:00:00.000Z"],
      [stalled.id, "evidence.observed", { passed: false, head: "a" }, at],
      [stalled.id, "evidence.observed", { passed: false, head: "b" }, at],
    ]) ledger.sql.exec("INSERT INTO events (item_id, at, actor, kind, data) VALUES (?, ?, 'owner', ?, ?)", id, time, kind, JSON.stringify(data));
    const snapshot = { ...ledger.stuckSnapshot(), coreFiles: ["src/**"] };
    const full = { ...snapshot, events: ledger.events(undefined, Number.MAX_SAFE_INTEGER) };
    const report = (s: typeof snapshot) => stuckReport("reads-history", "https://atelier.test", new Date("2026-11-03T12:00:00Z"), reportLimits(), s, [{ runner: "home:gone", at: "2026-11-01T00:00:00.000Z" }] as any, [], []);
    expect(report(snapshot)).toEqual(report(full));
    expect(report(snapshot).entries.some((e: any) => e.subject === orphan.id && e.kind === "orphaned-claim")).toBe(true);
    expect(report(snapshot).entries.some((e: any) => e.subject === held.id && e.kind === "task")).toBe(true);
    expect(report(snapshot).entries.some((e: any) => e.subject === waiting.id && e.kind === "core-hold")).toBe(true);
    expect(report(snapshot).entries.some((e: any) => e.subject === stalled.id && e.reason.includes("last two"))).toBe(true);
    expect(snapshot.events.length).toBeLessThan(100);
  });
});
