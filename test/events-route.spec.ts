import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import { tokenFromBytes } from "../src/tokens.ts";

// GET /api/projects/NAME/events: the owner's export of a project's ledger,
// newest first in pages. Every credential here is synthetic.

const OWNER = "events-route-owner";
const NAME = "events-route";
const AGENT = "claude-code/opus-5.5";
const bindings = { ...env, ATELIER_TOKEN: OWNER } as typeof env;

const call = (bearer: string, path: string, actor?: string) =>
  worker.fetch(new Request(`https://atelier.test/api${path}`, { headers: { authorization: `Bearer ${bearer}`, ...(actor ? { "x-atelier-actor": actor } : {}) } }), bindings);

type Page = { events: { seq: number; actor: string; data: Record<string, unknown> }[]; next: number | null };

async function setup() {
  const record = { name: NAME, repo: NAME, policy: { checks: ["npm test"], protected: [] }, createdAt: new Date().toISOString() };
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${NAME}`));
  await L.setProject(record as never, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record as never);
  return L;
}

it("serves the owner pages by cursor, refuses an agent, and sends no secret", async () => {
  const L = await setup();
  const secretToken = tokenFromBytes(new Uint8Array(32).fill(171));
  await L.newItem(`Brief with a pasted ${secretToken} in it`, [], "owner");
  for (let i = 0; i < 4; i++) await L.newItem(`Task ${i}`, [], "owner");

  const first = await call(OWNER, `/projects/${NAME}/events?limit=2`, "owner");
  expect(first.status).toBe(200);
  const p1 = (await first.json()) as Page;
  expect(p1.events).toHaveLength(2);
  expect(p1.next).toBe(p1.events[1].seq);
  const second = (await (await call(OWNER, `/projects/${NAME}/events?limit=2&before=${p1.next}`, "owner")).json()) as Page;
  expect(second.events.every((e) => e.seq < p1.next!)).toBe(true);
  expect(second.events[0].seq).toBeLessThan(p1.events[1].seq);

  let all: Page["events"] = [], before: number | null = null;
  do {
    const page = (await (await call(OWNER, `/projects/${NAME}/events?limit=2${before ? `&before=${before}` : ""}`, "owner")).json()) as Page;
    all = all.concat(page.events);
    before = page.next;
  } while (before !== null);
  expect(new Set(all.map((e) => e.seq)).size).toBe(all.length);
  expect(all.length).toBeGreaterThan(4);
  expect(JSON.stringify(all)).not.toContain(secretToken);
  expect(JSON.stringify(all)).toContain("[redacted]");

  expect((await call(OWNER, `/projects/${NAME}/events?before=abc`, "owner")).status).toBe(400);

  const issued = await (await worker.fetch(new Request("https://atelier.test/api/tokens", {
    method: "POST",
    headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json", "x-atelier-actor": "owner" },
    body: JSON.stringify({ actor: AGENT, projects: [NAME] }),
  }), bindings)).json() as { token: string };
  const denied = await call(issued.token, `/projects/${NAME}/events`);
  expect(denied.status).toBeGreaterThanOrEqual(400);
  expect(denied.status).toBeLessThan(500);
  expect(await denied.text()).not.toContain("newItem");
});
