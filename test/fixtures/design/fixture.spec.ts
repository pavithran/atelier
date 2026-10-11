import { env } from "cloudflare:workers";
import { afterAll, expect, it, vi } from "vitest";
import { EMPTY_PROJECT, FIXED_NOW, PLANS, SECRETS, STATE_OF, TOTAL_TASKS, UNAVAILABLE_PROJECT, seed, total, type Shape } from "./seed.ts";
import { ALIASES, designEnv, draw, pageStates, serveKeys, session } from "./pages.ts";

// The design captures' fixture (t499) holds what the brief says it holds:
// at least 300 tasks across three projects, each seeded state where it was
// put, and every page and state the brief lists drawn with the status and
// text it is captured for. The capture command (scripts/design/capture.ts)
// draws the same pages from the same seed in a browser; this spec keeps the
// fixture honest without one.

afterAll(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("seeds 310 tasks across three projects, each state where the brief says, and draws every page state", { timeout: 600_000 }, async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const seeded = await seed(env);
  expect(new Date().toISOString()).toBe(FIXED_NOW);

  // The totals, read back from the Ledgers rather than from the plan.
  expect(TOTAL_TASKS).toBe(310);
  let counted = 0;
  for (const plan of PLANS) {
    const items = await env.LEDGER.get(env.LEDGER.idFromName(`project:${plan.name}`)).items();
    expect(items.length, plan.name).toBe(total(plan));
    counted += items.length;
    for (const [shape, ids] of Object.entries(seeded.byShape[plan.name]) as [Shape, string[]][]) {
      expect(ids.length, `${plan.name} ${shape}`).toBe(plan.shapes[shape]);
      for (const id of ids) expect(items.find((i) => i.id === id)?.state, `${plan.name} ${id} ${shape}`).toBe(STATE_OF[shape]);
    }
  }
  expect(counted).toBe(310);
  expect(counted).toBeGreaterThanOrEqual(300);
  expect((await env.LEDGER.get(env.LEDGER.idFromName(`project:${EMPTY_PROJECT}`)).items()).length).toBe(0);
  const listed = (await env.LEDGER.get(env.LEDGER.idFromName("__index")).projects()).map((p: { name: string }) => p.name);
  expect(listed.sort()).toEqual([EMPTY_PROJECT, UNAVAILABLE_PROJECT, ...PLANS.map((p) => p.name)].sort());

  const keys = serveKeys();
  const pages = designEnv(env, seeded);
  const cookie = await session(pages);
  const failures: string[] = [];
  for (const p of pageStates(seeded)) {
    if (p.setup === "no-showcase") continue;
    const res = await draw(pages, p.path, p.audience, cookie);
    const body = await res.text();
    if (res.status !== p.status || !body.includes(p.marker)) failures.push(`${p.id} ${p.path}: ${res.status} (want ${p.status}), marker ${JSON.stringify(p.marker)} ${body.includes(p.marker) ? "found" : "missing"}`);
    // Nothing the anonymised project holds reaches a page a visitor reads.
    if (p.audience !== "owner") for (const secret of SECRETS) if (body.includes(secret)) failures.push(`${p.id} exposes ${JSON.stringify(secret)}`);
  }
  for (const a of ALIASES) {
    const res = await draw(pages, a.path, a.audience, cookie);
    const location = res.headers.get("location") ?? "";
    if (res.status !== a.status || (a.location && !location.endsWith(a.location))) failures.push(`alias ${a.path}: ${res.status} ${location}`);
  }
  // The no-showcase state, with the setting cleared and put back.
  const I = env.LEDGER.get(env.LEDGER.idFromName("__index"));
  for (const plan of PLANS) if (plan.mode) await I.removeShowcase(plan.name);
  const none = await draw(pages, "/", "public", cookie);
  expect(none.status).toBe(404);
  for (const plan of PLANS) if (plan.mode) await I.setShowcase(plan.name, plan.mode);
  keys.mockRestore();
  expect(failures).toEqual([]);
});
