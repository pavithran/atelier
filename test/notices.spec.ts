import { env } from "./support/workers.ts";
import { runInDurableObject } from "./support/workers.ts";
import { expect, it, vi } from "./support/vitest.ts";
import worker from "../src/index.ts";

// t533: GET /api/notices is what `atelier status` prints. Who may call: the
// developer's token only (an agent token is refused). The window is fixed on
// the server, 24 hours, and no request parameter widens it. Output paths by
// kind: inbox.notice and stuck.digest_notice come from the project's ledger,
// usage.alert from the index; every other event kind stays out.

const TOKEN = "notices-test-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const I = () => env.LEDGER.get(env.LEDGER.idFromName("__index"));
const L = (key: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${key}`));
const HOUR = 3_600_000;
const ago = (h: number) => new Date(Date.now() - h * HOUR).toISOString();
const get = (actor: string, query = "") => worker.fetch(new Request(`https://atelier.test/api/notices${query}`, {
  headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": actor },
}), testEnv);

async function put(stub: ReturnType<typeof L>, at: string, kind: string, data: unknown, item: string | null = null) {
  await runInDurableObject(stub, async (_i, state) => {
    state.storage.sql.exec("INSERT INTO events (item_id, at, actor, kind, data) VALUES (?, ?, 'atelier', ?, ?)", item, at, kind, JSON.stringify(data));
  });
}

type Read = { notices: { at: string; kind: string; project: string | null; item: string | null; text: string }[]; unread: string[] };

it("lists the last 24 hours of the three notice kinds, newest first, from the index and every project", async () => {
  const name = "notices-a";
  const record = { name, repo: name, policy: { checks: ["npm test"], protected: [] }, createdAt: new Date().toISOString() };
  await L(name).setProject(record, "owner");
  await I().registerProject(record);
  const send = vi.spyOn(globalThis, "fetch");
  try {
    await put(L(name), ago(30), "inbox.notice", { title: "Too old", brief: "b", reason: "submitted" }, "t9");
    await put(L(name), ago(5), "inbox.notice", { title: "Waiting", brief: "Decide.", reason: "submitted" }, "t1");
    await put(L(name), ago(1), "stuck.digest_notice", { project: name, episodes: [{ item: "t2", reason: "no push" }] });
    await put(L(name), ago(2), "item.blocked", { reason: "not a notice kind" }, "t3");
    await put(I(), ago(3), "usage.alert", { key: "k", title: "codex: weekly window 81% used" });
    const res = await get("owner");
    expect(res.status).toBe(200);
    const read = (await res.json()) as Read;
    const mine = read.notices.filter((n) => n.project === name || n.project === null);
    expect(mine.map((n) => [n.kind, n.project, n.item, n.text])).toEqual([
      ["stuck.digest_notice", name, null, "1 stuck episode: t2: no push"],
      ["usage.alert", null, null, "codex: weekly window 81% used"],
      ["inbox.notice", name, "t1", "Waiting is waiting on you: Decide."],
    ]);
    const times = read.notices.map((n) => Date.parse(n.at));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(JSON.stringify(read)).not.toContain("Too old");
    expect(JSON.stringify(read)).not.toContain("not a notice kind");
    expect(read.unread).toEqual([]);
    // A caller cannot widen the window.
    expect(JSON.stringify(await (await get("owner", "?since=0&hours=999")).json())).not.toContain("Too old");
    expect(send).not.toHaveBeenCalled();
  } finally { send.mockRestore(); }
});

it("refuses a caller who is not the developer, and an anonymous one", async () => {
  expect((await get("codex/gpt-6-astra")).status).toBe(403);
  const anonymous = await worker.fetch(new Request("https://atelier.test/api/notices"), testEnv);
  expect(anonymous.status).toBe(401);
});

it("answers the same with NTFY_TOPIC set or unset", async () => {
  const read = async (e: typeof env) => ((await (await worker.fetch(new Request("https://atelier.test/api/notices", { headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner" } }), e)).json()) as Read).notices;
  expect(await read({ ...testEnv, NTFY_TOPIC: "some-topic" } as typeof env)).toEqual(await read(testEnv));
});
