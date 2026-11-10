import { env, runInDurableObject } from "./support/workers.ts";
import { expect, it } from "./support/vitest.ts";
import worker from "../src/index.ts";

// t601: a design records how many tasks it plans (design.planned), and the
// stuck list and GET /projects/P/designs show the designs that fewer tasks
// name than planned. Every request goes through worker.fetch.

const TOKEN = "designs-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const inside = runInDurableObject as unknown as (stub: unknown, fn: (ledger: any) => unknown) => Promise<any>;
const ACTING = "claude-code/opus-5.5";

function call(method: string, path: string, body?: unknown, token = TOKEN, actor = "owner") {
  return worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "x-atelier-actor": actor, ...(token === TOKEN ? { "x-atelier-acting": ACTING } : {}), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), testEnv);
}

async function project(name: string) {
  const record = { name, repo: name, policy: { checks: ["npm test"], protected: [] }, createdAt: new Date().toISOString() };
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  return L;
}
const plan = (name: string, design: unknown, planned: unknown, quote: unknown = "yes, both") => call("POST", `/projects/${name}/designs`, { name: design, planned, quote });
const planned = async (L: Awaited<ReturnType<typeof project>>) => (await L.events()).filter((e) => e.kind === "design.planned");
const named = async (L: Awaited<ReturnType<typeof project>>, name: string) => (await planned(L)).filter((e) => e.data.name === name);
async function file(name: string, title: string, design?: string) {
  const res = await call("POST", `/projects/${name}/items`, { title, scope: ["src/**"], ...(design === undefined ? {} : { design }) });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}
const stuckKinds = async (name: string) => ((await (await call("GET", `/projects/${name}/stuck`)).json()) as { entries: { kind: string; subject: string; reason: string }[] }).entries.filter((e) => e.kind === "unfiled-plan");
const designsOf = async (name: string) => ((await (await call("GET", `/projects/${name}/designs`)).json()) as { designs: Record<string, unknown>[] }).designs;

it("criterion 1: a record is one design.planned event with name, planned, quote, by and acting, and is answered", async () => {
  const L = await project("dp-record");
  const res = await plan("dp-record", "model-slate", 5, "Yes, both");
  expect(res.status).toBe(201);
  expect(await res.json()).toMatchObject({ name: "model-slate", planned: 5, quote: "Yes, both", by: "owner", acting: ACTING });
  const events = await planned(L);
  expect(events).toHaveLength(1);
  expect(events[0].data).toEqual({ name: "model-slate", planned: 5, quote: "Yes, both", by: "owner", acting: ACTING });
});

it("criterion 2: a missing quote, a bad count, a bad name or an agent token is refused and nothing is recorded", async () => {
  const L = await project("dp-refuse");
  const { token } = await (await call("POST", "/tokens", { actor: "codex/gpt-6-astra", projects: ["dp-refuse"] })).json() as { token: string };
  const asAgent = await call("POST", "/projects/dp-refuse/designs", { name: "d", planned: 2, quote: "yes" }, token, "codex/gpt-6-astra");
  expect(asAgent.status).toBe(403);
  expect((await call("POST", "/projects/dp-refuse/designs", { name: "d", planned: 2 })).status).toBe(400);
  expect((await plan("dp-refuse", "d", 2, "   ")).status).toBe(400);
  for (const bad of [0, 51, 2.5, -1, "3", null, 1e9]) expect((await plan("dp-refuse", "d", bad)).status, String(bad)).toBe(400);
  for (const bad of ["", "   ", "a\nb", "x".repeat(81), 7, null]) expect((await plan("dp-refuse", bad, 2)).status, JSON.stringify(bad)).toBe(400);
  expect(await planned(L)).toHaveLength(0);
  expect((await plan("dp-refuse", "d", 1)).status).toBe(201);
  expect((await plan("dp-refuse", "d", 50)).status).toBe(201);
});

it("criterion 3: the latest count wins; an equal record, resent or sent twice at once, adds no event; a crash leaves nothing", async () => {
  const L = await project("dp-latest");
  await plan("dp-latest", "d", 5, "five");
  await plan("dp-latest", "d", 3, "three");
  expect((await designsOf("dp-latest"))).toMatchObject([{ name: "d", planned: 3, quote: "three" }]);
  expect(await planned(L)).toHaveLength(2);
  // resent after a timeout: equal to the latest
  expect((await plan("dp-latest", "d", 3, "three")).status).toBe(201);
  expect(await planned(L)).toHaveLength(2);
  // an earlier value sent again is a change, not a repeat
  await plan("dp-latest", "d", 5, "five");
  expect(await planned(L)).toHaveLength(3);
  // twice at once
  await Promise.all([plan("dp-latest", "other", 4, "four"), plan("dp-latest", "other", 4, "four")]);
  expect(await named(L, "other")).toHaveLength(1);
  // the same count with other words is a new record
  await plan("dp-latest", "other", 4, "four, confirmed");
  expect(await named(L, "other")).toHaveLength(2);
  // a crash while the event is written leaves nothing
  await project("dp-crash");
  const crash = env.LEDGER.get(env.LEDGER.idFromName("project:dp-crash"));
  await inside(crash, (ledger) => {
    const exec = ledger.sql.exec.bind(ledger.sql);
    ledger.sql.exec = (query: string, ...args: unknown[]) => {
      if (/INSERT INTO events/i.test(query)) throw new Error("crash");
      return exec(query, ...args);
    };
  });
  const was = console.error;
  console.error = () => {};
  try { expect((await plan("dp-crash", "d", 3)).status).toBeGreaterThanOrEqual(500); } finally { console.error = was; }
  await inside(crash, (ledger) => { ledger.sql.exec = Object.getPrototypeOf(ledger.sql).exec; });
  expect(await designsOf("dp-crash")).toEqual([]);
});

it("criterion 5: unfiled-plan shows from the record, counts every state, and clears at N or when N is lowered", async () => {
  const L = await project("dp-stuck");
  await file("dp-stuck", "A", "slate");
  expect(await stuckKinds("dp-stuck")).toEqual([]);
  await plan("dp-stuck", "slate", 3, "file all three");
  const open = await stuckKinds("dp-stuck");
  expect(open).toMatchObject([{ kind: "unfiled-plan", reason: "Design slate: 1 of 3 tasks filed" }]);
  const merged = await file("dp-stuck", "B", "slate");
  await inside(L, (ledger) => { ledger.sql.exec("UPDATE items SET state = 'merged' WHERE id = ?", merged); });
  expect((await stuckKinds("dp-stuck"))[0].reason).toBe("Design slate: 2 of 3 tasks filed");
  // lowering N with the developer's words clears it
  await plan("dp-stuck", "slate", 2, "two is enough");
  expect(await stuckKinds("dp-stuck")).toEqual([]);
  await plan("dp-stuck", "slate", 4, "four after all");
  expect((await stuckKinds("dp-stuck"))[0].reason).toBe("Design slate: 2 of 4 tasks filed");
  const abandoned = await file("dp-stuck", "C", "slate");
  await L.abandon(abandoned, "owner", "not needed");
  await file("dp-stuck", "D", "other-design");
  expect((await stuckKinds("dp-stuck"))[0].reason).toBe("Design slate: 3 of 4 tasks filed");
  await file("dp-stuck", "E", "slate");
  expect(await stuckKinds("dp-stuck")).toEqual([]);
});

it("criterion 6: GET designs lists name, planned, filed, quote and at, and only designs a record names", async () => {
  await project("dp-list");
  await file("dp-list", "A", "slate");
  await file("dp-list", "B", "slate");
  await file("dp-list", "C", "unplanned");
  expect(await designsOf("dp-list")).toEqual([]);
  await plan("dp-list", "slate", 5, "yes, five");
  const [only, ...rest] = await designsOf("dp-list");
  expect(rest).toEqual([]);
  expect(Object.keys(only).sort()).toEqual(["at", "filed", "name", "planned", "quote"]);
  expect(only).toMatchObject({ name: "slate", planned: 5, filed: 2, quote: "yes, five" });
  expect(Date.parse(only.at as string)).not.toBeNaN();
});
