import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { RunnerOffer } from "../src/dispatch/rules.ts";
import { parseRuleError } from "../src/rules.ts";

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
