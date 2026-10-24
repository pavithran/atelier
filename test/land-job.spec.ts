import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { RunnerOffer } from "../src/dispatch/rules.ts";
import { parseRuleError } from "../src/rules.ts";
import worker from "../src/index.ts";
import type { Ledger } from "../src/ledger.ts";
import { ROUTE_LEVEL, SERVER_CAPABILITIES } from "../src/route-level.ts";

// The land job's queue side (t226): a queued landing is offered to a runner
// whose offer lists the job and names the project among its checkouts, and to
// no other; a task that has merged or been closed drops out.

const OWNER = "owner";
const ledger = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));

async function setup(name: string) {
  const record = { name, repo: `${name}--baseline`, policy: { checks: ["npm test"], protected: [] }, createdAt: new Date().toISOString() };
  const L = ledger(name);
  await L.setProject(record, OWNER);
  return L;
}
const offer = (over: Partial<RunnerOffer> = {}): RunnerOffer => ({ runner: "home:studio", kind: "home", agents: [], jobs: ["land"], checkouts: ["land-job"], ...over });

it("a queued landing is offered to a runner that lists the job and holds the checkout, and to no other", async () => {
  const L = await setup("land-job");
  const { id } = await L.newItem("Land me", ["src/**"], OWNER);
  expect(await L.landJobs(offer(), ["land-job"])).toEqual([]);
  expect((await L.requestLand(id, OWNER)).queued).toBe(true);
  // Asked twice, it keeps its place.
  expect((await L.requestLand(id, OWNER)).queued).toBe(false);
  const jobs = await L.landJobs(offer(), ["land-job"]);
  expect(jobs.map((j) => [j.id, j.dispatch?.job])).toEqual([[id, "land"]]);
  // No checkout of this project, no checkouts at all, or the job unlisted.
  expect(await L.landJobs(offer({ checkouts: ["other"] }), ["land-job"])).toEqual([]);
  expect(await L.landJobs(offer({ checkouts: undefined }), ["land-job"])).toEqual([]);
  expect(await L.landJobs(offer({ jobs: ["build", "review"] }), ["land-job"])).toEqual([]);
  // A project renamed since the checkout was registered still answers to the old name.
  expect((await L.landJobs(offer({ checkouts: ["old-name"] }), ["land-job", "old-name"])).length).toBe(1);
});

it("a task that has merged or been closed has nothing to land", async () => {
  const L = await setup("land-job-done");
  const { id } = await L.newItem("Shelved", ["src/**"], OWNER);
  await L.requestLand(id, OWNER);
  await L.abandon(id, OWNER, "no longer needed");
  expect(await L.landJobs(offer({ checkouts: ["land-job-done"] }), ["land-job-done"])).toEqual([]);
  const refused = await L.requestLand(id, OWNER).then(() => null, (e: unknown) => parseRuleError(e as Error));
  expect(refused?.code).toBe("not_landable");
});

const TOKEN = "land-job-token";
const queue = (body: unknown) => worker.fetch(new Request("https://atelier.test/api/queue", { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "content-type": "application/json" }, body: JSON.stringify(body) }), { ...env, ATELIER_TOKEN: TOKEN } as typeof env);

it("a queued landing of a claimed task is in the runner's queue answer, as ordinary land lands claimed tasks", async () => {
  const name = "land-job-claimed";
  const L = await setup(name);
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject({ name, repo: `${name}--baseline`, policy: { checks: ["npm test"], protected: [] }, createdAt: new Date().toISOString() });
  const { id } = await L.newItem("Held", ["src/**"], OWNER);
  await L.claim(id, "codex/gpt-6-astra");
  await L.requestLand(id, OWNER);
  const res = await queue({ runner: "home:studio", kind: "home", agents: [], jobs: ["land"], checkouts: [name] });
  expect(res.status).toBe(200);
  const listed = ((await res.json()) as { project: string; actor?: string; item: { id: string; state: string; dispatch?: { job?: string } } }[]).filter((q) => q.project === name);
  expect(listed.map((q) => [q.item.id, q.item.state, q.item.dispatch?.job, q.actor])).toEqual([[id, "claimed", "land", "atelier/lander"]]);
  // A runner that does not hold the checkout is offered nothing.
  const other = await queue({ runner: "home:laptop", kind: "home", agents: [], jobs: ["land"], checkouts: ["elsewhere"] });
  expect(((await other.json()) as { project: string }[]).filter((q) => q.project === name)).toEqual([]);
});

it("a merged task keeps its landing while post-merge work is open, and drops it once the run is complete", async () => {
  const L = await setup("land-job-post");
  const { id } = await L.newItem("Merged", ["src/**"], OWNER);
  await L.requestLand(id, OWNER);
  const o = offer({ checkouts: ["land-job-post"] });
  const state = { run: null as null | { id: string; state: string } };
  await runInDurableObject(L, async (instance: Ledger, st: DurableObjectState) => {
    st.storage.sql.exec(`UPDATE items SET state = 'merged' WHERE id = ?`, id);
    const put = (run: object) => {
      st.storage.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, "post-merge-item:" + id, "pm1");
      st.storage.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, "post-merge:pm1", JSON.stringify(run));
    };
    const run = { id: "pm1", members: [id], before: "a", after: "b", policy: { steps: [] }, createdAt: new Date().toISOString(), state: "pending", paths: [], steps: [] };
    put(run);
    state.run = run;
    expect((await instance.landJobs(o, ["land-job-post"])).map((j) => j.id)).toEqual([id]);
    put({ ...run, state: "complete" });
    expect(await instance.landJobs(o, ["land-job-post"])).toEqual([]);
  });
  // Dropped for good: a later run record does not bring it back.
  expect(await L.landJobs(o, ["land-job-post"])).toEqual([]);
});

it("a merged task with no post-merge run drops its landing at once", async () => {
  const L = await setup("land-job-nopost");
  const { id } = await L.newItem("Plain", ["src/**"], OWNER);
  await L.requestLand(id, OWNER);
  await runInDurableObject(L, async (_i: Ledger, st: DurableObjectState) => { st.storage.sql.exec(`UPDATE items SET state = 'merged' WHERE id = ?`, id); });
  expect(await L.landJobs(offer({ checkouts: ["land-job-nopost"] }), ["land-job-nopost"])).toEqual([]);
});

it("the land-job route is published as a named capability, since the route level is frozen", () => {
  expect(ROUTE_LEVEL).toBe(28);
  expect(SERVER_CAPABILITIES).toContain("land.runner-job.v1");
});
