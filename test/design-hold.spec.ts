import { env } from "./support/workers.ts";
import { expect, it } from "./support/vitest.ts";
import worker from "../src/index.ts";

// t538: two live tasks naming one design wait for each other, with the life of
// a core-file hold: the first claim holds until it merges or is abandoned. Each
// test enters through the server routes (create, edit, dispatch, the queue a
// runner polls) and the Ledger's claim, and the tasks share no file.

const TOKEN = "design-hold-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
type Queued = { project: string; item: { id: string } };

function call(method: string, path: string, body?: unknown) {
  return worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "x-atelier-acting": "claude-code/opus-5.5", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), testEnv);
}

async function project(name: string) {
  const record = { name, repo: name, policy: { checks: ["npm test"], protected: [], coreFiles: ["src/ledger.ts"] }, createdAt: new Date().toISOString() };
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  return L;
}

async function file(name: string, title: string, scope: string[], design?: string) {
  const res = await call("POST", `/projects/${name}/items`, { title, scope, ...(design === undefined ? {} : { design }) });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

const A = "codex/gpt-6-astra";
const dispatchOf = (L: Awaited<ReturnType<typeof project>>, id: string) => L.dispatch(id, "owner", { agent: "codex", model: "gpt-6-astra" });

// A holder (dispatched, then claimed) and a waiting task, each filed through
// the create route with its design; the runner claims through its own token.
async function pair(name: string, first?: string, second?: string) {
  const L = await project(name);
  const holder = await file(name, "Holder", ["src/a/**"], first);
  const waiting = await file(name, "Waiting", ["src/b/**"], second);
  await dispatchOf(L, holder);
  await dispatchOf(L, waiting);
  const runner = `home:${name}`;
  const { token } = await (await call("POST", "/tokens", { runner, projects: [name] })).json() as { token: string };
  const asRunner = (path: string, body: unknown) => worker.fetch(new Request(`https://atelier.test/api${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "x-atelier-actor": A, "content-type": "application/json" }, body: JSON.stringify(body) }), testEnv);
  const poll = async () => ((await (await asRunner("/queue", { runner, agents: [{ agent: "codex", models: ["gpt-6-astra"] }], jobs: ["build"] })).json()) as Queued[]).filter((q) => q.project === name).map((q) => q.item.id);
  await poll();
  await L.claim(holder, A, { runner: "home:other", kind: "home" });
  // The test pool serves no repository, so a claim past every check fails at
  // that step with a logged RepoError (a bare 500); a hold is a 409 "held".
  const claim = async () => {
    const was = console.error;
    console.error = () => {};
    try { const res = await asRunner(`/projects/${name}/items/${waiting}/claim`, {}); return { status: res.status, error: ((await res.json()) as { error?: string }).error }; }
    finally { console.error = was; }
  };
  return { L, holder, waiting, poll, claim };
}
const heldOf = async (L: Awaited<ReturnType<typeof project>>, id: string) => (await L.waiting()).find((i) => i.id === id)?.held;
const expectHeld = (r: { status: number; error?: string }, label: string) => { expect(r.status, label).toBe(409); expect(r.error, label).toBe("held"); };
const expectPast = (r: { status: number; error?: string }, label: string) => { expect(r.status, label).not.toBe(409); expect(r.error, label).not.toBe("held"); };

it("criterion 2: a task is held, not offered and not claimable, while another task naming its design is claimed", async () => {
  const { L, holder, waiting, poll, claim } = await pair("design-hold-same", "notify", "notify");
  expect(await heldOf(L, waiting)).toMatchObject({ id: holder, core: "design notify" });
  expect(await poll()).not.toContain(waiting);
  expectHeld(await claim(), "claim");
  // the hold ends with the holder's life: abandoned, the task is offered and its claim is past the hold
  await L.abandon(holder, "owner", "not needed");
  expect(await heldOf(L, waiting)).toBeUndefined();
  expect(await poll()).toContain(waiting);
  expectPast(await claim(), "after abandon");
});

it("criterion 3: different designs, or none, hold nothing", async () => {
  for (const [label, first, second] of [["different", "notify", "waking"], ["none", undefined, undefined], ["one-sided", "notify", undefined]] as const) {
    const { L, waiting, poll, claim } = await pair(`design-hold-${label}`, first, second);
    expect(await heldOf(L, waiting), label).toBeUndefined();
    expect(await poll(), label).toContain(waiting);
    expectPast(await claim(), label);
  }
});

it("criterion 4: edit --design \"\" clears the name and the next poll offers the task", async () => {
  const name = "design-hold-cleared";
  const { L, waiting, poll, claim } = await pair(name, "notify", "notify");
  expect(await poll()).not.toContain(waiting);
  expectHeld(await claim(), "before the edit");
  const edited = await call("POST", `/projects/${name}/items/${waiting}/edit`, { design: null });
  expect(edited.status).toBe(200);
  expect((await L.item(waiting)).design).toBeNull();
  expect(await heldOf(L, waiting)).toBeUndefined();
  expect(await poll()).toContain(waiting);
  expectPast(await claim(), "after the edit");
});
