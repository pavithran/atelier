import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import type { LedgerEvent } from "../src/ledger.ts";
import { buildReliability, type ModelReliability, type RunReport } from "../src/models/reliability.ts";
import { signIn } from "./signin.ts";

// t109: each model's reliability across every project, through the Worker's
// own fetch handler: the run reports a runner sends, the defect the owner
// traces, where an owner's approval was recorded, the JSON route and the two
// pages that show it. Artifacts is a fake that answers each fork's head.

const TOKEN = "reliability-test-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const OPUS = "claude-code/opus-5.5", GPT = "codex/gpt-6-astra";
const [H0, H1, H2, H3] = ["0", "1", "2", "3"].map((c) => c.repeat(40));
const L = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));

function call(method: string, path: string, actor: string, body?: unknown, headers: Record<string, string> = {}, bindings: Env = testEnv) {
  return worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": actor, "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), bindings);
}

async function project(name: string) {
  const record = { name, repo: name, policy: { checks: [], protected: [] }, createdAt: new Date().toISOString() };
  await L(name).setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
}

// A new item, claimed, forked, pushed at `head` and submitted.
async function submitted(name: string, actor: string, head: string): Promise<string> {
  const { id } = await L(name).newItem(`Work by ${actor}`, ["docs/**"], "owner");
  await L(name).claim(id, actor);
  await L(name).setFork(id, `${name}--${id}`, H0, actor);
  await L(name).recordPush(id, actor, head, head);
  await L(name).submit(id, actor);
  return id;
}

async function accepted(name: string, id: string, head: string) {
  await L(name).addEvidence({ itemId: id, claim: "changed paths", grade: "observed", head, passed: true, by: "atelier/sandbox", at: new Date().toISOString(), changedPaths: ["docs/a.md"], where: "sandbox" });
  await L(name).accept(id, "owner", head);
}

// Artifacts as the review routes read it: each fork's head.
function artifacts(heads: Record<string, string>): Artifacts {
  return { get: async (repo: string) => ({ log: async () => [{ hash: heads[repo], parents: [] }], [Symbol.dispose]() {} }) } as unknown as Artifacts;
}

it("a runner reports a run under its name; the owner token reads the reports; an agent token cannot send one", async () => {
  const body = { actor: "opencode/glm-5.3", role: "review", outcome: "refused", project: "rel-runs", item: "t4", detail: "Select a model before continuing" };
  // No runner header: the owner records a run by hand, under the owner's name.
  expect((await call("POST", "/runs", "owner", body)).status).toBe(201);
  expect((await call("POST", "/runs", "owner", body, { "x-atelier-runner": "laptop" })).status).toBe(400);
  const bad = await call("POST", "/runs", "owner", { ...body, outcome: "crashed" }, { "x-atelier-runner": "home:studio" });
  expect(bad.status).toBe(400);
  expect(await bad.json()).toMatchObject({ error: "bad_run", detail: "outcome must be one of stalled, timed-out, refused, harness_failed, early_stop, permission_stop, duplicate_design, incomplete_merge" });
  const sent = await call("POST", "/runs", "owner", body, { "x-atelier-runner": "home:studio" });
  expect(sent.status).toBe(201);
  expect(await sent.json()).toMatchObject({ ...body, runner: "home:studio" });
  await call("POST", "/runs", "owner", { ...body, outcome: "stalled", role: "build" }, { "x-atelier-runner": "home:studio" });
  const read = (await (await call("GET", "/runs", "codex/gpt-6-astra")).json()) as RunReport[];
  expect(read.slice(0, 2).map((r) => [r.outcome, r.role])).toEqual([["stalled", "build"], ["refused", "review"]]);
  const issued = await (await call("POST", "/tokens", "owner", { actor: "opencode/glm-5.3" })).json() as { token: string };
  const agent = await worker.fetch(new Request("https://atelier.test/api/runs", {
    method: "POST", headers: { authorization: `Bearer ${issued.token}`, "x-atelier-runner": "home:studio", "content-type": "application/json" }, body: JSON.stringify(body),
  }), testEnv);
  expect(agent.status).toBe(403);
});

it("the owner traces a defect to an accepted revision; anyone else, an item never accepted and a blank note are refused", async () => {
  await project("rel-defect");
  const id = await submitted("rel-defect", OPUS, H1);
  const open = await submitted("rel-defect", OPUS, H2);
  await accepted("rel-defect", id, H1);
  const path = (item: string) => `/projects/rel-defect/items/${item}/defect`;
  expect((await call("POST", path(id), GPT, { note: "drops a page" })).status).toBe(403);
  const blank = await call("POST", path(id), "owner", { note: "  " });
  expect(blank.status).toBe(400);
  expect(await blank.json()).toMatchObject({ error: "defect_note" });
  const never = await call("POST", path(open), "owner", { note: "drops a page" });
  expect(never.status).toBe(409);
  expect(((await never.json()) as { detail: string }).detail).toContain(`${open} is not accepted at any revision`);
  const traced = await call("POST", path(id), "owner", { note: "drops a page", foundIn: "t9" });
  expect(traced.status).toBe(201);
  expect(await traced.json()).toMatchObject({ id, state: "accepted", acceptedHead: H1 });
  const events = (await L("rel-defect").events(id)) as unknown as LedgerEvent[];
  expect(events[0]).toMatchObject({ kind: "item.defect", actor: "owner", data: { head: H1, note: "drops a page", foundIn: "t9" } });
});

it("each model's reliability across projects: the JSON route, the Models page and the Usage page; owner approvals kept apart by where they were made", async () => {
  await project("rel-a");
  await project("rel-b");
  // rel-a t1: sent back at its first review, approved at the second, merged, then a defect traced to it.
  const t1 = await submitted("rel-a", OPUS, H1);
  await L("rel-a").addReview({ itemId: t1, by: GPT, head: H1, approve: false, note: "<b>needs a test</b>", at: new Date().toISOString() });
  await L("rel-a").recordPush(t1, OPUS, H2, H2);
  await L("rel-a").addReview({ itemId: t1, by: GPT, head: H2, approve: true, note: "good", at: new Date().toISOString() });
  const t2 = await submitted("rel-a", OPUS, H3);
  const bindings = { ...testEnv, ARTIFACTS: artifacts({ [`rel-a--${t1}`]: H2, [`rel-a--${t2}`]: H3 }) } as typeof env;
  // The owner approves t1 through the API, as the orchestrator does, and t2 on the task page.
  expect((await call("POST", `/projects/rel-a/items/${t1}/review`, "owner", { approve: true, head: H2, note: "go" }, {}, bindings)).status).toBe(200);
  const cookie = await signIn(TOKEN, testEnv);
  const page = await worker.fetch(new Request(`https://atelier.test/ui/rel-a/${t2}/approve`, {
    method: "POST", headers: { cookie, origin: "https://atelier.test" }, body: new URLSearchParams({ head: H3, note: "looks right" }), redirect: "manual",
  }), bindings);
  expect(page.status).toBe(303);
  const vias = ((await L("rel-a").events(undefined, 100)) as unknown as LedgerEvent[]).filter((e) => e.kind === "review.approved").map((e) => [e.itemId, e.actor, e.data.via ?? null]);
  expect(vias).toEqual([[t2, "owner", "page"], [t1, "owner", "api"], [t1, GPT, null]]);
  await accepted("rel-a", t1, H2);
  await L("rel-a").merged(t1, "owner", "f".repeat(40), true, H2);
  expect((await call("POST", `/projects/rel-a/items/${t1}/defect`, "owner", { note: "loses the last page" })).status).toBe(201);
  // rel-b: the same model under another harness and a registered alias, approved at its first review.
  const b1 = await submitted("rel-b", "antigravity/claude-opus-5-5", H1);
  await L("rel-b").addReview({ itemId: b1, by: GPT, head: H1, approve: true, note: "fine", at: new Date().toISOString() });
  await call("POST", "/runs", "owner", { actor: "opencode/glm-5.3", role: "review", outcome: "refused", detail: "no model" }, { "x-atelier-runner": "home:studio" });

  const answer = await call("GET", "/reliability", "owner");
  expect(answer.status).toBe(200);
  const { events, models } = (await answer.json()) as { events: number; models: ModelReliability[] };
  // Every event is read, so the count is what the projects hold, not a page's size.
  expect(events).toBeGreaterThan(0);
  expect(events).toBeLessThan(1000);
  const opus = models.find((m) => m.model === "opus-5.5")!;
  expect(opus).toMatchObject({
    actors: ["antigravity/claude-opus-5-5", OPUS], firstReviews: 2, approvedFirst: 1, merged: 1, mergedReviewed: 1, rounds: 2,
    ownerApprovals: { page: 1, api: 1, unrecorded: 0 }, approvals: 0,
  });
  expect(opus.projects).toEqual(expect.arrayContaining(["rel-a", "rel-b"]));
  expect(opus.rejections.map((c) => [c.project, c.by, c.note])).toEqual([["rel-a", GPT, "<b>needs a test</b>"]]);
  // Storage lasts the file, so the earlier test's project is read too.
  expect(opus.defects.map((c) => [c.project, c.note])).toEqual([["rel-a", "loses the last page"], ["rel-defect", "drops a page"]]);
  const gpt = models.find((m) => m.model === "gpt-6-astra")!;
  expect([gpt.approvals, gpt.rejectionsGiven, gpt.contradicted.length]).toEqual([2, 1, 1]);
  const glm = models.find((m) => m.model === "glm-5.3")!;
  // At least this test's report; an earlier test's may still be stored.
  expect(glm.runs.refused).toBeGreaterThanOrEqual(1);
  expect(glm.unfinishedReviews).toBeGreaterThanOrEqual(1);

  const models_ = await (await worker.fetch(new Request("https://atelier.test/models", { headers: { cookie } }), testEnv)).text();
  expect(models_).toContain("Reliability by model");
  expect(models_).toContain("<code>opus-5.5</code>");
  expect(models_).toContain("&lt;b&gt;needs a test&lt;/b&gt;");
  expect(models_).not.toContain("<b>needs a test</b>");
  expect(models_).toContain("1 by the owner on the page");
  expect(models_).toContain("1 through the API");
  expect(models_).toContain("Its approvals a defect contradicted · 1");
  const usage = await (await worker.fetch(new Request("https://atelier.test/usage", { headers: { cookie } }), testEnv)).text();
  expect(usage).toContain("Reliability by model");
  expect(usage).toContain("<code>glm-5.3</code>");
  expect(usage).toContain("review run refused: no model");
});

it("the owner records a verdict on one review finding; anyone else, a bad verdict and a missing finding are refused", async () => {
  await project("rel-finding");
  const id = await submitted("rel-finding", OPUS, H1);
  await L("rel-finding").addReview({ itemId: id, by: GPT, head: H1, approve: false, note: "no", at: new Date().toISOString(), findings: [
    { file: "a.ts", line: 1, severity: "blocking", text: "drops rows" },
    { file: "b.ts", line: 2, severity: "follow-up", text: "name it" },
  ] });
  const path = `/projects/rel-finding/items/${id}/finding`;
  expect((await call("POST", path, GPT, { head: H1, index: 1, verdict: "confirmed" })).status).toBe(403);
  expect((await call("POST", path, "owner", { head: H1, index: 1, verdict: "maybe" })).status).toBe(400);
  expect((await call("POST", path, "owner", { head: H2, index: 1, verdict: "confirmed" })).status).toBe(409);
  expect((await call("POST", path, "owner", { head: H1, index: 3, verdict: "confirmed" })).status).toBe(409);
  const ok = await call("POST", path, "owner", { head: H1, index: 2, verdict: "refuted", note: "the code already names it" });
  expect(ok.status).toBe(201);
  expect(await ok.json()).toMatchObject({ id, head: H1, index: 2, verdict: "refuted" });
  const events = (await L("rel-finding").events(id)) as unknown as LedgerEvent[];
  const finding = events.find((e) => e.kind === "review.finding");
  expect(finding).toMatchObject({ actor: "owner", data: { head: H1, index: 2, verdict: "refuted", by: GPT, note: "the code already names it" } });
});

it("the owner records a run by hand for a run outside the runner, in a new outcome kind", async () => {
  const body = { actor: "opencode/glm-5.3", role: "build", outcome: "early_stop", project: "rel-handrun", item: "t4", detail: "stopped after a refused read" };
  // No runner header, owner token: recorded under the owner's name.
  const byOwner = await call("POST", "/runs", "owner", body);
  expect(byOwner.status).toBe(201);
  expect(await byOwner.json()).toMatchObject({ ...body, runner: "owner" });
  // The new outcome is read back as part of the model's record.
  const read = (await (await call("GET", "/runs", "codex/gpt-6-astra")).json()) as RunReport[];
  expect(read.some((r) => r.outcome === "early_stop" && r.runner === "owner")).toBe(true);
});

it("the Models page shows finding precision, median timings and the comparison by kind of work", async () => {
  const { reliabilitySection } = await import("../src/ui.ts");
  const ev = (seq: number, itemId: string, actor: string, kind: string, data: Record<string, unknown> = {}): LedgerEvent =>
    ({ seq, itemId, actor, kind, data, at: new Date(Date.UTC(2026, 9, 6, 12, seq)).toISOString() });
  const events: LedgerEvent[] = [
    ev(1, "t1", "owner", "item.created", { title: "Build", scope: ["src/**"], partKind: "build" }),
    ev(2, "t1", "claude-code/opus-5.5", "item.claimed"),
    ev(3, "t1", "claude-code/opus-5.5", "push.observed", { head: H1 }),
    ev(4, "t1", "claude-code/opus-5.5", "item.submitted", { head: H1 }),
    ev(5, "t1", "antigravity/gemini-3.1-pro", "review.rejected", { head: H1, note: "no", findings: [{ file: "a.ts", line: 1, severity: "blocking", text: "x" }] }),
    ev(6, "t1", "owner", "review.finding", { head: H1, index: 1, verdict: "confirmed", by: "antigravity/gemini-3.1-pro" }),
  ];
  const rel = buildReliability([{ project: "a", events }], [], "owner");
  const html = reliabilitySection(rel, "Pavi", { events: 1000, unread: [] });
  expect(html).toContain('<th scope="col">Findings</th>');
  expect(html).toContain('<th scope="col">Median timings</th>');
  expect(html).toContain("By kind of work");
  expect(html).toContain("build");
  expect(html).toContain("1 of 1 kept");
  expect(html).toContain("none timed");
  expect(html).toContain("Findings adjudicated · 1");
});
