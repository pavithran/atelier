import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import worker from "../src/index.ts";

// t264: the land request the route records: who asked, the optional quote,
// once per task however often it is asked again.

const TOKEN = "land-request-test";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const AT = new Date().toISOString();
const ledger = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
const call = (method: string, path: string, body?: unknown) => worker.fetch(new Request(`https://atelier.test/api${path}`, {
  method, headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
}), testEnv);

it("records the land request once with its actor and quote, and says so on a second ask", async () => {
  const name = "land-request";
  const L = ledger(name);
  await L.setProject({ name, repo: `${name}--baseline`, policy: { checks: ["npm test"], protected: ["src/**"] }, createdAt: AT }, "owner");
  const { id } = await L.newItem("Land request", ["src/**"], "owner", { accept: ["Works"] });
  const first = await call("POST", `/projects/${name}/items/${id}/land-job`, { quote: "land it" });
  expect(first.status).toBe(201);
  expect(await first.json()).toMatchObject({ item: id, by: "owner", quote: "land it", queued: true });
  const again = await call("POST", `/projects/${name}/items/${id}/land-job`, { quote: "different words" });
  expect(await again.json()).toMatchObject({ by: "owner", quote: "land it", queued: false });
  const events = (await L.events(id) as { kind: string; data: Record<string, unknown> }[]).filter((e) => e.kind === "land.requested");
  expect(events).toHaveLength(1);
  expect(events[0].data).toMatchObject({ by: "owner", quote: "land it" });
});

it("the stage tick's requeue keeps the owner's actor and quote on the land request row", async () => {
  const name = "land-request-tick";
  const L = ledger(name);
  await L.setProject({ name, repo: `${name}--baseline`, policy: { checks: ["npm test"], protected: ["src/**"] }, createdAt: AT }, "owner");
  const { id } = await L.newItem("Land request tick", ["src/**"], "owner", { accept: ["Works"] });
  await call("POST", `/projects/${name}/items/${id}/land-job`, { quote: "keep these words" });
  const row = await runInDurableObject(L, async (instance: object) => {
    const self = instance as unknown as { queueLandFromTick(id: string, head: string, main: string | null, verdict: unknown, at: string): void; sql: { exec(q: string, ...a: unknown[]): { toArray(): Record<string, unknown>[] } } };
    self.queueLandFromTick(id, "abc", null, { queue: "ready", note: "n" }, "2030-01-01T00:00:00.000Z");
    return self.sql.exec(`SELECT by, at, quote FROM land_jobs WHERE item = ?`, id).toArray()[0];
  });
  expect(row).toMatchObject({ by: "owner", quote: "keep these words", at: "2030-01-01T00:00:00.000Z" });
});
