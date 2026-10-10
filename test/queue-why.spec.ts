import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";

// t420: an idle runner hears why dispatches wait through its own poll, asked
// with `why`, since a runner token may not GET the owner's listing; and a
// claim a runner was refused is kept on the task, so status, show and the
// runner's next poll name it with the command that releases it.

const OWNER = "queue-why-owner";
const testEnv = { ...env, ATELIER_TOKEN: OWNER } as typeof env;
const index = () => env.LEDGER.get(env.LEDGER.idFromName("__index"));
type Why = { kind: string; line: string };
type Entry = { project: string; item: { id: string; why?: Why[] } };

function request(method: string, path: string, token: string, actor: string, body?: unknown) {
  return worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "x-atelier-actor": actor, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), testEnv);
}

it("a runner token's poll with why names each waiting dispatch's reason, a refused claim among them", async () => {
  const name = "queue-why-runner";
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  const p = { name, repo: name, policy: { checks: [], protected: [] }, createdAt: new Date().toISOString() };
  await L.setProject(p, "owner");
  await index().registerProject(p);
  const mine = await L.newItem("Mine", [], "owner");
  const other = await L.newItem("Another model's", [], "owner");
  await L.dispatch(mine.id, "owner", { to: "home", agent: "codex", model: "gpt-6-astra" });
  await L.dispatch(other.id, "owner", { to: "home", agent: "codex", model: "other" });
  const issued = await request("POST", "/tokens", OWNER, "owner", { runner: "home:why-token", projects: [name] });
  expect(issued.status).toBe(201);
  const token = (await issued.json() as { token: string }).token;
  const offer = { runner: "home:why-token", agents: [{ agent: "codex", models: ["gpt-6-astra"] }], jobs: ["build"], started: new Date(Date.now() - 60_000).toISOString() };
  const runner = (method: string, path: string, body?: unknown, actor = "codex/gpt-6-astra") => request(method, path, token, actor, body);
  const why = async (res: Response) => {
    expect(res.status, await res.clone().text()).toBe(200);
    const list = await res.json() as Entry[];
    return (id: string) => list.find((q) => q.project === name && q.item.id === id)?.item.why ?? [];
  };

  // The owner's listing stays the owner's.
  expect((await runner("GET", "/queue")).status).toBe(403);
  let of = await why(await runner("POST", "/queue", { ...offer, why: true }));
  expect(of(other.id).map((r) => r.kind)).toEqual(["unoffered"]);
  expect(of(mine.id)).toEqual([]);
  // A plain poll still answers with the tasks to claim, not the reasons.
  expect((await (await runner("POST", "/queue", offer)).json() as Entry[]).filter((q) => q.project === name).map((q) => q.item.id)).toEqual([mine.id]);

  // Its claim of the other task is refused, and the refusal says why in words.
  expect((await runner("POST", `/projects/${name}/items/${other.id}/claim`, {}, "codex/other")).status).toBe(403);
  of = await why(await runner("POST", "/queue", { ...offer, why: true }));
  const line = of(other.id).find((r) => r.kind === "refused")?.line;
  expect(line).toBe(`Claim refused: home:why-token claimed it as codex/other and was refused (runner_forbidden: its offer does not cover this dispatch (a home runner, codex with other)); that runner passes it by until it changes, so once that is fixed, dispatch it again with atelier dispatch ${other.id} --to home --agent codex --model other.`);
  // The owner's listing, which status and show read, says the same.
  const owner = await (await request("GET", "/queue", OWNER, "owner")).json() as Entry[];
  expect((owner.find((q) => q.project === name && q.item.id === other.id)?.item.why ?? []).map((r) => r.line)).toContain(line);

  // A runner restarted since the refusal has forgotten it, so it is not said.
  of = await why(await runner("POST", "/queue", { ...offer, started: new Date(Date.now() + 1000).toISOString(), why: true }));
  expect(of(other.id).map((r) => r.kind)).toEqual(["unoffered"]);
  await runner("POST", "/queue", offer);

  // Dispatching it again clears the refusal too: the runner tries it afresh.
  await new Promise((resolve) => setTimeout(resolve, 5));
  await L.dispatch(other.id, "owner", { to: "home", agent: "codex", model: "other" });
  of = await why(await runner("POST", "/queue", { ...offer, why: true }));
  expect(of(other.id).map((r) => r.kind)).toEqual(["unoffered"]);
});

it("asked by one runner, a dispatch another live runner offers is said to be for that one", async () => {
  const name = "queue-why-elsewhere";
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  const p = { name, repo: name, policy: { checks: [], protected: [] }, createdAt: new Date().toISOString() };
  await L.setProject(p, "owner");
  await index().registerProject(p);
  const task = await L.newItem("For the desk", [], "owner");
  await L.dispatch(task.id, "owner", { to: "home", agent: "opencode", model: "glm-5.3" });
  await request("POST", "/queue", OWNER, "owner", { runner: "home:why-desk", agents: [{ agent: "opencode", models: ["glm-5.3"] }] });
  const res = await request("POST", "/queue", OWNER, "owner", { runner: "home:why-studio", agents: [{ agent: "codex", models: ["gpt-6"] }], why: true });
  const entry = (await res.json() as Entry[]).find((q) => q.project === name && q.item.id === task.id);
  expect(entry?.item.why).toEqual([{ kind: "elsewhere", line: "Not for home:why-studio: it is dispatched to a home runner, opencode with glm-5.3, which this runner does not offer, and a live runner that does will take it." }]);
});
