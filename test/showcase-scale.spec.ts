import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import { signIn } from "./signin.ts";

// t578's first deploy (7c6086e2) emptied the live showcase: every project
// came back unreadable on Atelier's own ledger, hundreds of thousands of
// events deep. This seeds a ledger at that scale and times the whole-record
// read that a project's showcase page (/p/NAME/showcase) draws from.
const testEnv = { ...env, ATELIER_TOKEN: "scale-token" } as typeof env;
const I = () => env.LEDGER.get(env.LEDGER.idFromName("__index"));
const L = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
const ITEMS = 600, MERGED = 400, EVENTS = 150_000, SERVED = 2000;
const ACTORS = ["codex/gpt-6", "zcode/glm-5.3", "claude-code/opus-5.5", "opencode/glm-5.3-flash", "atelier/sandbox", "atelier/events", "owner"];
const KINDS = ["push.observed", "evidence.observed", "evidence.reported", "item.submitted", "review.rejected", "review.approved", "fork.moved", "session.wrapped"];

async function seed(name: string) {
  const record = { name, repo: name, title: "Scale", policy: { checks: [], protected: [] }, createdAt: "2026-09-01T00:00:00Z" };
  await L(name).setProject(record, "owner");
  await I().registerProject(record);
  await runInDurableObject(L(name), async (_: unknown, state: DurableObjectState) => {
    const sql = state.storage.sql;
    const start = Date.parse("2026-09-01T00:00:00Z"), span = Date.parse("2026-10-13T12:00:00Z") - start;
    const at = (i: number) => new Date(start + Math.floor((span * i) / EVENTS)).toISOString();
    for (let n = 1; n <= ITEMS; n++) {
      const state = n <= MERGED ? "merged" : n % 3 ? "open" : "claimed";
      sql.exec(`INSERT INTO items (id, title, scope, state, created_at, updated_at) VALUES (?, ?, '[]', ?, ?, ?)`, `t${n}`, `Task ${n}`, state, at(0), at(EVENTS));
    }
    const rows: unknown[][] = [];
    for (let i = 0; i < EVENTS; i++) {
      const n = (i % ITEMS) + 1, item = `t${n}`, round = Math.floor(i / ITEMS);
      let kind = KINDS[i % KINDS.length], actor = ACTORS[i % ACTORS.length], data: Record<string, unknown> = { head: "a".repeat(40) };
      if (round === 0) { kind = "item.created"; actor = "owner"; }
      else if (round === 1) { kind = "item.claimed"; actor = ACTORS[n % 4]; }
      else if (round === 200 && n <= MERGED) { kind = "item.accepted"; actor = "owner"; }
      else if (round === 201 && n <= MERGED) { kind = "item.merged"; actor = "owner"; data = { mergeCommit: "c".repeat(40) }; }
      else if (i % 75 === 0 && rows.length < EVENTS) { kind = "event.served"; actor = "owner"; data = { seq: i, served: "deepseek-flash", note: "x".repeat(200) }; }
      if (kind === "evidence.observed") data = { passed: i % 2 === 0, where: i % 4 ? "sandbox" : "runner", claim: "npm test" };
      rows.push([item, at(i), actor, kind, JSON.stringify(data)]);
    }
    for (let i = 0; i < rows.length; i += 20) {
      const part = rows.slice(i, i + 20);
      sql.exec(`INSERT INTO events (item_id, at, actor, kind, data) VALUES ${part.map(() => "(?, ?, ?, ?, ?)").join(", ")}`, ...part.flat());
    }
  });
}

it("the whole-record counts a project showcase draws from read a ledger of 150,000 events quickly", { timeout: 120_000 }, async () => {
  await seed("scale");
  const served = await runInDurableObject(L("scale"), async (_: unknown, s: DurableObjectState) => Number(s.storage.sql.exec(`SELECT COUNT(*) AS n FROM events WHERE kind = 'event.served'`).one().n));
  expect(served).toBeGreaterThanOrEqual(SERVED - 100);
  // An existing ledger builds the kind index once, when the new code first starts it.
  const built = await runInDurableObject(L("scale"), async (_: unknown, s: DurableObjectState) => {
    s.storage.sql.exec(`DROP INDEX events_kind`);
    const a = performance.now();
    s.storage.sql.exec(`CREATE INDEX IF NOT EXISTS events_kind ON events (kind, actor, item_id)`);
    return performance.now() - a;
  });
  console.log(`events_kind index built over ${EVENTS} events in ${built.toFixed(0)} ms`);
  const t0 = performance.now();
  const counts = await L("scale").showcaseCounts(new Date(Date.parse("2026-10-13T12:00:00Z") - 15 * 86400_000).toISOString());
  const ms = performance.now() - t0;
  console.log(`showcaseCounts over ${EVENTS} events: ${ms.toFixed(0)} ms, ${JSON.stringify(counts).length} bytes`);
  expect(counts.merges).toBe(MERGED);
  expect(counts.taken).toBe(ITEMS);
  expect(counts.story).not.toBeNull();
  const cookie = await signIn("scale-token", testEnv);
  const t1 = performance.now();
  const body = await (await worker.fetch(new Request("https://atelier.test/p/scale/showcase", { headers: { cookie } }), testEnv)).text();
  const pageMs = performance.now() - t1;
  console.log(`project showcase page: ${pageMs.toFixed(0)} ms`);
  expect(body).not.toContain("could not be read");
  expect(body).toContain(`<dt>merged, all time</dt><dd>${MERGED}</dd>`);
  expect(ms).toBeLessThan(2000);
  // The answer stays small however long the record: counts by actor, kind and day.
  expect(JSON.stringify(counts).length).toBeLessThan(200_000);
  expect(pageMs).toBeLessThan(3000);
});
