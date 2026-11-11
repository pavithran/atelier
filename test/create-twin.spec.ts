import { env, runInDurableObject } from "./support/workers.ts";
import { expect, it } from "./support/vitest.ts";
import worker from "../src/index.ts";
import type { Ledger } from "../src/ledger.ts";

// t552: the server's create route refuses a create equal in title, brief and
// scope to a live task of the project filed in the last 10 minutes, naming
// that task, unless the request says duplicateOk.

const TOKEN = "create-twin-owner";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const A = "claude-code/opus-5.5";
const call = (method: string, path: string, body?: unknown) => worker.fetch(new Request(`https://atelier.test/api${path}`, {
  method, headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "x-atelier-acting": A, "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
}), testEnv);
const FILING = { title: "Retry the upload", brief: "The upload gives up after one try.", scope: ["src/upload/**"] };
const ledger = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
async function project(name: string) {
  const r = await call("PUT", `/projects/${name}`, { checks: ["npm test"] });
  expect(r.status, await r.clone().text()).toBe(200);
}
const file = (name: string, body: Record<string, unknown> = FILING) => call("POST", `/projects/${name}/items`, body);
const count = async (name: string) => ((await (await call("GET", `/projects/${name}/items`)).json()) as unknown[]).length;
const set = (name: string, id: string, sql: string, ...args: unknown[]) =>
  runInDurableObject(ledger(name), (_: Ledger, state: DurableObjectState) => { state.storage.sql.exec(`UPDATE items SET ${sql} WHERE id = ?`, ...args, id); });

it("refuses an identical create within 10 minutes, names the task and files nothing", async () => {
  const name = "twin-refuse";
  await project(name);
  const first = await file(name);
  expect(first.status).toBe(201);
  const { id } = await first.json() as { id: string };
  const second = await file(name);
  expect(second.status).toBe(409);
  const refusal = await second.json() as { error: string; detail: string };
  expect(refusal.error).toBe("duplicate");
  expect(refusal.detail).toContain(`already filed as ${id}`);
  expect(await count(name)).toBe(1);
});

it("files a second task when the request says duplicateOk", async () => {
  const name = "twin-ok";
  await project(name);
  await file(name);
  const again = await file(name, { ...FILING, duplicateOk: true });
  expect(again.status).toBe(201);
  expect(await count(name)).toBe(2);
});

it("files as before when title, brief or scope differs", async () => {
  const name = "twin-differs";
  await project(name);
  await file(name);
  expect((await file(name, { ...FILING, title: "Retry the download" })).status).toBe(201);
  expect((await file(name, { ...FILING, brief: "A different brief." })).status).toBe(201);
  expect((await file(name, { ...FILING, scope: ["src/other/**"] })).status).toBe(201);
  expect(await count(name)).toBe(4);
});

it("files as before after 10 minutes", async () => {
  const name = "twin-old";
  await project(name);
  await file(name);
  await set(name, "t1", "created_at = ?", new Date(Date.now() - 11 * 60_000).toISOString());
  expect((await file(name)).status).toBe(201);
});

it("files as before against an abandoned or merged task", async () => {
  const name = "twin-closed";
  await project(name);
  await file(name);
  await set(name, "t1", "state = 'abandoned'");
  expect((await file(name)).status).toBe(201);
  await set(name, "t2", "state = 'merged'");
  await set(name, "t1", "state = 'merged'");
  expect((await file(name)).status).toBe(201);
});

it("is not stopped by an identical live task in another project", async () => {
  await project("twin-here");
  await project("twin-there");
  expect((await file("twin-there")).status).toBe(201);
  expect((await file("twin-here")).status).toBe(201);
});
