import { env } from "./support/workers.ts";
import { expect, it } from "./support/vitest.ts";
import worker from "../src/index.ts";
import type { LedgerEvent } from "../src/ledger.ts";
import { OUTPUT_MAX, CLAIM_MAX } from "../src/text.ts";

// t497: the orchestrator, acting for the developer, records text evidence at
// a task's head (POST .../evidence-note, atelier evidence). It is kept apart
// from a builder's reports and from checks: the gate does not read it.
//
// Trust checks of the route: the caller must hold the developer token (an
// agent's own token is refused, not_project_owner); the actor is the
// developer's, never one the body names; the acting model comes from the
// X-Atelier-Acting header the door requires; the head must be the task's
// recorded head; a merged or abandoned task takes nothing.

const TOKEN = "relayed-evidence-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const AT = "2026-11-11T12:00:00.000Z";
const OPUS = "claude-code/opus-5.5", GPT = "codex/gpt-6-astra";
const H1 = "a".repeat(40), H2 = "b".repeat(40);

const ledger = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
async function project(name: string, checks: string[] = []) {
  const record = { name, repo: `${name}--baseline`, policy: { checks, protected: [] }, createdAt: AT };
  await ledger(name).setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  for (const [harness, id] of [["claude-code", "opus-5.5"], ["codex", "gpt-6-astra"]]) {
    expect((await worker.fetch(new Request(`https://atelier.test/api/models/${id}`, {
      method: "PUT", headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "x-atelier-acting": OPUS, "content-type": "application/json" }, body: JSON.stringify({ harness, where: "cloud" }),
    }), testEnv)).status).toBe(200);
  }
  const L = ledger(name);
  await L.newItem("Restyle the toolbar", [], "owner", { accept: ["Works"] });
  await L.claim("t1", OPUS);
  await L.recordPush("t1", OPUS, H1, H1);
  return L;
}
const note = (name: string, body: Record<string, unknown>, headers: Record<string, string> = { "x-atelier-acting": OPUS }, bearer = TOKEN, actor = "owner", id = "t1") =>
  worker.fetch(new Request(`https://atelier.test/api/projects/${name}/items/${id}/evidence-note`, {
    method: "POST", headers: { authorization: `Bearer ${bearer}`, "x-atelier-actor": actor, "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  }), testEnv);
const agentToken = async (name: string) => (await (await worker.fetch(new Request("https://atelier.test/api/tokens", {
  method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "x-atelier-acting": OPUS, "content-type": "application/json" }, body: JSON.stringify({ actor: GPT, projects: [name] }),
}), testEnv)).json() as { token: string }).token;
const kept = async (L: ReturnType<typeof ledger>) => (await L.evidenceFor("t1")).filter((e) => e.grade === "relayed");
const events = async (L: ReturnType<typeof ledger>) => (await L.events(undefined, 100) as unknown as LedgerEvent[]).filter((e) => e.kind === "evidence.relayed");

it("records the note at the head with the actor, the acting model and the time, and the detail lists it", async () => {
  const name = "relay-record";
  const L = await project(name);
  const res = await note(name, { head: H1, note: "Ran the journey suite on the Mac: 226 passed, 0 failed" });
  expect(res.status).toBe(200);
  const body = await res.json() as { evidence: Record<string, unknown>[]; alreadyRecorded: boolean };
  expect(body.alreadyRecorded).toBe(false);
  expect(body.evidence.filter((e) => e.grade === "relayed")).toMatchObject([{ claim: "Ran the journey suite on the Mac: 226 passed, 0 failed", head: H1, by: "owner", acting: OPUS, passed: null }]);
  const [e] = await kept(L);
  expect(Date.parse(e!.at)).toBeGreaterThan(0);
  expect(e).not.toHaveProperty("quote");
  expect(await events(L)).toMatchObject([{ actor: "owner", data: { head: H1, claim: "Ran the journey suite on the Mac: 226 passed, 0 failed", acting: OPUS } }]);
});

it("keeps a file's last OUTPUT_MAX characters and says it was cut; a note over CLAIM_MAX is refused, not cut", async () => {
  const name = "relay-file";
  const L = await project(name);
  const whole = `${"x".repeat(OUTPUT_MAX + 50)}END`;
  const res = await note(name, { head: H1, note: "budget output", outputTail: whole.slice(-OUTPUT_MAX), outputLength: whole.length });
  expect(res.status).toBe(200);
  const [e] = await kept(L);
  expect(e).toMatchObject({ outputLength: whole.length });
  expect(e!.outputTail).toHaveLength(OUTPUT_MAX);
  expect(e!.outputTail!.endsWith("END")).toBe(true);
  // The server does not cut: a tail over the limit is refused.
  expect((await note(name, { head: H1, note: "too much", outputTail: "y".repeat(OUTPUT_MAX + 1), outputLength: OUTPUT_MAX + 1 })).status).toBe(400);
  const long = await note(name, { head: H1, note: "n".repeat(CLAIM_MAX + 1) });
  expect(long.status).toBe(400);
  expect(await long.json()).toMatchObject({ error: "too_long" });
  expect((await note(name, { head: H1, note: "  " })).status).toBe(400);
  expect(await kept(L)).toHaveLength(1);
});

it("stores the developer's words with the acting model, as a decision's words are; without them none are stored", async () => {
  const name = "relay-quote";
  const L = await project(name);
  expect((await note(name, { head: H1, note: "Captures beside the mockup, seen by the developer", quote: "that matches the mockup" })).status).toBe(200);
  expect((await note(name, { head: H1, note: "No words here" })).status).toBe(200);
  const [withWords, without] = await kept(L);
  expect(withWords).toMatchObject({ quote: "that matches the mockup", acting: OPUS });
  expect(without).not.toHaveProperty("quote");
  expect((await events(L)).find((e) => e.data.quote)).toMatchObject({ data: { quote: "that matches the mockup", acting: OPUS } });
  // Blank words are refused, and so are words from a caller that is not the developer.
  expect((await note(name, { head: H1, note: "blank", quote: "   " })).status).toBe(400);
  expect((await note(name, { head: H1, note: "other actor", quote: "yes" }, { "x-atelier-acting": OPUS }, TOKEN, OPUS)).status).toBe(403);
  expect(await kept(L)).toHaveLength(2);
});

it("refuses, recording nothing: an agent's own token, a head that is not the recorded head, no head, a merged or abandoned task", async () => {
  const name = "relay-refused";
  const L = await project(name);
  await L.newItem("No head yet", [], "owner", { accept: ["Works"] });
  await L.newItem("Closed", [], "owner", { accept: ["Works"] });
  await L.abandon("t3", "owner", "not needed");

  const agent = await agentToken(name);
  const own = await note(name, { head: H1, note: "mine" }, {}, agent, GPT);
  expect(own.status).toBe(403);
  expect(await own.json()).toMatchObject({ error: "not_project_owner" });
  // The developer token naming an agent's actor is no better.
  expect(await (await note(name, { head: H1, note: "mine" }, { "x-atelier-acting": OPUS }, TOKEN, GPT)).json()).toMatchObject({ error: "not_project_owner" });

  const stale = await note(name, { head: H2, note: "wrong head" });
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ error: "stale_head" });

  const headless = await note(name, { head: H1, note: "no head" }, undefined, TOKEN, "owner", "t2");
  expect(headless.status).toBe(409);
  expect(await headless.json()).toMatchObject({ error: "no_head" });

  const closed = await note(name, { head: H1, note: "abandoned" }, undefined, TOKEN, "owner", "t3");
  expect(closed.status).toBe(409);
  expect(await closed.json()).toMatchObject({ error: "closed" });

  for (const id of ["t1", "t2", "t3"]) expect((await L.evidenceFor(id)).filter((e) => e.grade === "relayed")).toEqual([]);
  expect(await events(L)).toEqual([]);
});

it("the same head, note, words and file sent again records nothing new and says so; another note is a second entry", async () => {
  const name = "relay-repeat";
  const L = await project(name);
  const body = { head: H1, note: "journey 226 ran on the Mac", quote: "go on", outputTail: "ok 226", outputLength: 6 };
  const first = await (await note(name, body)).json() as { alreadyRecorded: boolean };
  expect(first.alreadyRecorded).toBe(false);
  const again = await note(name, body);
  expect(again.status).toBe(200);
  expect(((await again.json()) as { alreadyRecorded: boolean }).alreadyRecorded).toBe(true);
  // Two calls at once are two calls in either order: one entry, one event.
  const both = await Promise.all([note(name, { head: H1, note: "at once" }), note(name, { head: H1, note: "at once" })]);
  expect(both.map((r) => r.status)).toEqual([200, 200]);
  expect((await Promise.all(both.map(async (r) => (await r.json() as { alreadyRecorded: boolean }).alreadyRecorded))).sort()).toEqual([false, true]);
  expect((await kept(L)).map((e) => e.claim)).toEqual(["journey 226 ran on the Mac", "at once"]);
  expect(await events(L)).toHaveLength(2);
  // A different note, different words or different file content is a second entry.
  for (const other of [{ ...body, note: "journey 226 ran again" }, { ...body, quote: "no" }, { ...body, outputTail: "ok 225" }]) expect((await note(name, other)).status).toBe(200);
  expect(await kept(L)).toHaveLength(5);
});
