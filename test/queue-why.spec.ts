import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import worker from "../src/index.ts";
import { RUN_REPORTS } from "../src/ledger.ts";

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

  // Narrowing its scope changes it (updatedAt) under the same dispatch, as
  // the runner's refusedKey sees it, so the runner claims it afresh and the
  // refusal is no longer said.
  await new Promise((resolve) => setTimeout(resolve, 5));
  await L.editItem(other.id, "owner", {}, ["docs/**"]);
  of = await why(await runner("POST", "/queue", { ...offer, why: true }));
  expect(of(other.id).map((r) => r.kind)).toEqual(["unoffered"]);

  // Refused again, then dispatched again: that clears it too.
  expect((await runner("POST", `/projects/${name}/items/${other.id}/claim`, {}, "codex/other")).status).toBe(403);
  of = await why(await runner("POST", "/queue", { ...offer, why: true }));
  expect(of(other.id).map((r) => r.kind)).toEqual(["refused", "unoffered"]);
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

// t420: infrastructure failures in a row send no run report, so a runner
// reports the skip itself (run-skip), under a runner token for a job its
// poll was offered, and the owner's listing names it with no run report.
it("a runner's reported infrastructure skip reaches the owner's listing, for a job its poll was offered only", async () => {
  const name = "queue-why-infra";
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  const p = { name, repo: name, policy: { checks: [], protected: [] }, createdAt: new Date().toISOString() };
  await L.setProject(p, "owner");
  await index().registerProject(p);
  const task = await L.newItem("Broken workspace", [], "owner");
  const unasked = await L.newItem("Not offered", [], "owner");
  await L.dispatch(task.id, "owner", { to: "home", agent: "codex", model: "gpt-6-astra" });
  await L.dispatch(unasked.id, "owner", { to: "home", agent: "codex", model: "other" });
  const issued = await request("POST", "/tokens", OWNER, "owner", { runner: "home:why-infra", projects: [name] });
  const token = (await issued.json() as { token: string }).token;
  const offer = { runner: "home:why-infra", agents: [{ agent: "codex", models: ["gpt-6-astra"] }], jobs: ["build"], started: new Date(Date.now() - 60_000).toISOString() };
  expect((await request("POST", "/queue", token, "codex/gpt-6-astra", offer)).status).toBe(200);
  const skip = { project: name, item: task.id, actor: "codex/gpt-6-astra", role: "build", kind: "infrastructure", failures: 3, note: "git reset failed: index.lock exists" };
  const res = await request("POST", `/projects/${name}/items/${task.id}/run-skip`, token, "codex/gpt-6-astra", skip);
  expect(res.status, await res.clone().text()).toBe(200);
  expect(await res.json()).toEqual({ kept: true });
  // Nor for a job its poll was not offered, nor of a kind it does not know.
  expect((await request("POST", `/projects/${name}/items/${unasked.id}/run-skip`, token, "codex/other", { ...skip, item: unasked.id, actor: "codex/other" })).status).toBe(403);
  expect((await request("POST", `/projects/${name}/items/${task.id}/run-skip`, token, "codex/gpt-6-astra", { ...skip, kind: "tired" })).status).toBe(400);

  const listing = async () => (await (await request("GET", "/queue", OWNER, "owner")).json() as Entry[]).find((q) => q.project === name && q.item.id === task.id)?.item.why ?? [];
  expect(await listing()).toEqual([{ kind: "skipped", line: `Skipped by home:why-infra after 3 infrastructure failures in a row under this dispatch (the last: git reset failed: index.lock exists); that runner passes it by until it is dispatched again or the runner restarts: fix the runner's workspace, git or harness, then atelier dispatch ${task.id} --to home --agent codex --model gpt-6-astra.` }]);
  // The owner's token, naming the runner, reports one too (the runner on the owner's token).
  const owned = await worker.fetch(new Request(`https://atelier.test/api/projects/${name}/items/${task.id}/run-skip`, {
    method: "POST", body: JSON.stringify({ ...skip, kind: "failures", failures: 2, note: "harness made no new commit" }),
    headers: { authorization: `Bearer ${OWNER}`, "x-atelier-actor": "owner", "x-atelier-runner": "home:why-infra", "content-type": "application/json" },
  }), testEnv);
  expect(owned.status, await owned.clone().text()).toBe(200);
  expect((await listing()).map((r) => r.line)).toEqual([expect.stringMatching(/^Skipped by home:why-infra after 2 failed runs under this dispatch \(the last: harness made no new commit\)/)]);
  // Dispatching it again starts afresh, as the runner's count does.
  await new Promise((resolve) => setTimeout(resolve, 5));
  await L.dispatch(task.id, "owner", { to: "home", agent: "codex", model: "gpt-6-astra" });
  expect(await listing()).toEqual([]);
});

// The index keeps the newest RUN_REPORTS reports in its global listing, so a
// waiting task's failures are read task by task: other tasks' reports never
// push them out, and the skip is still said.
it("a skip is said however many other run reports follow its failures", async () => {
  const name = "queue-why-window";
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  const p = { name, repo: name, policy: { checks: [], protected: [] }, createdAt: new Date().toISOString() };
  await L.setProject(p, "owner");
  await index().registerProject(p);
  const task = await L.newItem("Failed twice", [], "owner");
  await L.dispatch(task.id, "owner", { to: "home", agent: "codex", model: "gpt-6-astra" });
  const now = new Date().toISOString();
  await index().putRunnerOffer({ runner: "home:why-window", kind: "home", agents: [{ agent: "codex", models: ["gpt-6-astra"] }] }, now);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const at = new Date().toISOString();
  for (const outcome of ["stalled", "refused"] as const) {
    await index().putRun({ actor: "codex/gpt-6-astra", role: "build", outcome, project: name, item: task.id, detail: "", runner: "home:why-window", at });
  }
  await runInDurableObject(index(), async (_instance, state) => {
    const other = JSON.stringify({ actor: "codex/gpt-6-astra", role: "build", outcome: "stalled", project: "elsewhere", item: "t1", detail: "", runner: "home:other", at });
    for (let i = 0; i <= RUN_REPORTS; i++) state.storage.sql.exec(`INSERT INTO runs (json) VALUES (?)`, other);
  });
  expect((await index().runs()).some((r) => r.project === name)).toBe(false);
  const all = await (await request("GET", "/queue", OWNER, "owner")).json() as Entry[];
  expect((all.find((q) => q.project === name && q.item.id === task.id)?.item.why ?? []).map((r) => r.line)).toEqual([
    `Skipped by home:why-window after 2 failed runs under this dispatch (the last refused); that runner passes it by until it is dispatched again or the runner restarts: fix the cause, then atelier dispatch ${task.id} --to home --agent codex --model gpt-6-astra.`,
  ]);
});

// Pre-review finding (t420): a runner token's why poll gave it the full item
// of every waiting dispatch in scope, the brief, the dispatch's note and
// other runners' refusals included, though GET items/tN refuses it that task
// with 403. It now gets id, title, dispatch and why, its own reasons alone.
it("a runner token's why poll carries no brief, note or other runner's refusal of a task it may not read", async () => {
  const name = "queue-why-private";
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  const p = { name, repo: name, policy: { checks: [], protected: [] }, createdAt: new Date().toISOString() };
  await L.setProject(p, "owner");
  await index().registerProject(p);
  const task = await L.newItem("Someone else's", [], "owner", { brief: "SECRET-BRIEF the owner wrote" });
  await L.dispatch(task.id, "owner", { to: "home", agent: "codex", model: "other", note: "SECRET-NOTE for the other runner" });
  await index().putRunnerOffer({ runner: "home:why-peer", kind: "home", agents: [{ agent: "codex", models: ["other"] }], started: new Date(Date.now() - 60_000).toISOString() } as never, new Date().toISOString());
  await L.noteClaimRefusal(task.id, "home:why-peer", "codex/other", "check_failed", "SECRET-REFUSAL from the peer's workspace");
  const issued = await request("POST", "/tokens", OWNER, "owner", { runner: "home:why-private", projects: [name] });
  const token = (await issued.json() as { token: string }).token;
  const offer = { runner: "home:why-private", agents: [{ agent: "codex", models: ["gpt-6-astra"] }], jobs: ["build"], started: new Date(Date.now() - 60_000).toISOString() };

  // The owner's listing names the peer's refusal: the secrets are there to leak.
  const owner = await (await request("GET", "/queue", OWNER, "owner")).json() as Entry[];
  expect(JSON.stringify(owner.find((q) => q.project === name && q.item.id === task.id))).toContain("SECRET-REFUSAL");
  // The runner may not read the task itself...
  expect((await request("GET", `/projects/${name}/items/${task.id}`, token, "codex/gpt-6-astra")).status).toBe(403);
  // ...and its why poll gives it no more than id, title, dispatch and why.
  const res = await request("POST", "/queue", token, "codex/gpt-6-astra", { ...offer, why: true });
  expect(res.status, await res.clone().text()).toBe(200);
  const body = await res.text();
  for (const secret of ["SECRET-BRIEF", "SECRET-NOTE", "SECRET-REFUSAL"]) expect(body).not.toContain(secret);
  const entry = (JSON.parse(body) as Entry[]).find((q) => q.project === name && q.item.id === task.id);
  expect(Object.keys(entry?.item ?? {}).sort()).toEqual(["dispatch", "id", "title", "why"]);
  expect(entry?.item).toMatchObject({ title: "Someone else's", dispatch: { to: "home", agent: "codex", model: "other", job: null } });
  expect(entry?.item.why?.map((r) => r.kind)).not.toContain("refused");
});
