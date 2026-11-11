import { env } from "./support/ledger.ts";
import { expect, it } from "./support/vitest.ts";
import worker from "../src/index.ts";
import { criteriaOf } from "../src/criteria.ts";
// @ts-expect-error plain JavaScript module
import { deployOnLanding } from "../cli/post-merge.mjs";

// t668: queue-landable and deploy-on-landing are recorded and act outside
// fast mode. reask-on-resubmit, post-merge-reviewer and notice-delay stay
// fast mode only, and so does the tick's review-on-checked ask.

const TOKEN = "standing-either-mode-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const BUILDER = "codex/gpt-6-astra", REVIEWER = "claude-code/opus-5.5";
const HEAD = "a".repeat(40), MIN = 60_000;
const ledger = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));

function api(method: string, path: string, body?: unknown) {
  return worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method, headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "x-atelier-acting": REVIEWER, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), testEnv);
}
const decide = (name: string, key: string, value: string) => api("POST", `/projects/${name}/decisions`, { standing: { key, value }, quote: "the developer said so" });
type Decision = { id: string; status: string; standing?: { key: string; value: string } };
const listed = async (name: string) => ((await (await api("GET", `/projects/${name}/decisions`)).json()) as { decisions: Decision[] }).decisions;

// A project in regular mode with a task whose checks passed and whose head a
// reviewer of another company approved, and a live lander runner.
async function fixture(name: string, approved = true) {
  const l = ledger(name);
  const record = { name, repo: name, policy: { checks: ["npm test"], protected: ["src/**"] }, createdAt: new Date().toISOString() };
  await l.setProject(record, "owner");
  const index = env.LEDGER.get(env.LEDGER.idFromName("__index"));
  await index.registerProject(record);
  await index.putRunnerOffer({ runner: `home:${name}`, kind: "home", agents: [], projects: [name], jobs: ["land"], checkouts: [name] }, new Date(Date.now() + 600 * MIN).toISOString());
  const { id } = await l.newItem("Work", ["src/a.ts"], "owner", { accept: ["Works"] });
  await l.claim(id, BUILDER);
  await l.setWorkspace(id, name, "0".repeat(40), BUILDER);
  await l.recordPush(id, BUILDER, HEAD, HEAD);
  await l.addEvidence({ itemId: id, claim: "npm test", grade: "observed", passed: true, head: HEAD, changedPaths: ["src/a.ts"], by: "owner", at: new Date().toISOString() });
  await l.submit(id, BUILDER);
  if (approved) await l.addReview({ itemId: id, by: REVIEWER, head: HEAD, approve: true, criteria: criteriaOf(await l.item(id)), note: "Works", at: new Date().toISOString() }, undefined, true);
  expect((await l.mode()).mode).not.toBe("fast");
  return { l, id, name };
}
const tick = (l: ReturnType<typeof ledger>, ms = 0) => l.stageTick(new Date(Date.now() + ms));
const queued = async (l: ReturnType<typeof ledger>, id: string) => (await l.events(id, 1000)).filter((e) => e.kind === "stage.land-queued");

it("criterion 1: queue-landable off and deploy-on-landing on are recorded in regular mode and listed as standing", async () => {
  await fixture("either-record");
  for (const [key, value] of [["queue-landable", "off"], ["deploy-on-landing", "on"]]) {
    const res = await decide("either-record", key, value);
    expect(res.status, await res.clone().text()).toBe(201);
  }
  const standing = (await listed("either-record")).filter((d) => d.status === "standing").map((d) => d.standing);
  expect(standing).toEqual([{ key: "queue-landable", value: "off" }, { key: "deploy-on-landing", value: "on" }]);
});

it("criterion 2: with queue-landable off, the tick queues no landing; withdrawn, the next tick queues it", async () => {
  const f = await fixture("either-queue");
  const res = await decide(f.name, "queue-landable", "off");
  expect(res.status, await res.clone().text()).toBe(201);
  const { id: decisionId } = (await res.json()) as { id: string };
  await tick(f.l, MIN);
  expect(await queued(f.l, f.id)).toHaveLength(0);
  const withdrawn = await api("POST", `/projects/${f.name}/decisions/${decisionId}/withdraw`, { note: "land again" });
  expect(withdrawn.status, await withdrawn.clone().text()).toBe(200);
  await tick(f.l, 2 * MIN);
  expect(await queued(f.l, f.id)).toHaveLength(1);
});

it("criterion 3: deploy-on-landing is read as on from the server's decisions in regular mode, and off once withdrawn", async () => {
  const f = await fixture("either-deploy");
  const res = await decide(f.name, "deploy-on-landing", "on");
  expect(res.status, await res.clone().text()).toBe(201);
  const { id } = (await res.json()) as { id: string };
  // The decisions come from the worker; the baseline and deploy list are fixed.
  const request = async (method: string, path: string) => {
    if (path.endsWith("/baseline-head")) return { head: HEAD };
    if (path.endsWith("/deploys")) return { deploys: [] };
    const answer = await api(method, path);
    return answer.json();
  };
  const started: unknown[] = [];
  const run = () => deployOnLanding({ request, name: f.name, print: () => undefined, start: (s: unknown) => started.push(s) });
  expect(await run()).toBe("started");
  expect(started).toHaveLength(1);
  await api("POST", `/projects/${f.name}/decisions/${id}/withdraw`, { note: "deploy by hand" });
  expect(await run()).toBe("off");
  expect(started).toHaveLength(1);
});

it("criterion 4: reask-on-resubmit, post-merge-reviewer and notice-delay are still refused outside fast mode", async () => {
  await fixture("either-refused");
  for (const [key, value] of [["reask-on-resubmit", "on"], ["post-merge-reviewer", REVIEWER], ["notice-delay", "30"]]) {
    const res = await decide("either-refused", key, value);
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("not_fast");
  }
  expect(await listed("either-refused")).toEqual([]);
});

it("criterion 4: a recorded review-on-checked makes the tick ask no review in regular mode", async () => {
  const f = await fixture("either-review", false);
  const res = await decide(f.name, "review-on-checked", `openai=${REVIEWER}`);
  expect(res.status, await res.clone().text()).toBe(201);
  await tick(f.l, MIN);
  expect((await f.l.events(f.id, 1000)).filter((e) => e.kind === "review.requested")).toHaveLength(0);
});

it("criterion 6: the same instruction recorded twice leaves one standing, and a second tick still queues nothing", async () => {
  const f = await fixture("either-twice");
  expect((await decide(f.name, "queue-landable", "off")).status).toBe(201);
  const again = await decide(f.name, "queue-landable", "off");
  expect(again.status).toBe(409);
  expect(await again.text()).toContain("already_decided");
  expect((await listed(f.name)).filter((d) => d.status === "standing" && d.standing?.key === "queue-landable")).toHaveLength(1);
  await tick(f.l, MIN);
  await tick(f.l, 2 * MIN);
  expect(await queued(f.l, f.id)).toHaveLength(0);
});
