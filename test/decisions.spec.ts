import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import type { DecisionView } from "../src/decisions.ts";
import type { LedgerEvent } from "../src/ledger.ts";
import { parseRuleError } from "../src/rules.ts";

// Standing decisions (t377) in the Ledger's own storage, over Durable Object
// RPC, and through the Worker's routes: the owner records and withdraws,
// anyone with a token reads, and a withdrawn decision stops standing.
// test/review-requests.spec.ts covers the review claim that carries them.

const TOKEN = "decisions-test-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const ledger = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));

async function project(name: string) {
  const record = { name, repo: name, policy: { checks: [], protected: [] }, createdAt: new Date().toISOString() };
  await ledger(name).setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  return ledger(name);
}

function api(method: string, path: string, actor: string, body?: unknown) {
  return worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method, headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": actor, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), testEnv);
}

async function refusal(p: Promise<unknown>, code: string, detail: RegExp): Promise<void> {
  const err = await p.then(() => new Error(`expected a ${code} refusal`), (e: unknown) => e as Error);
  const parsed = parseRuleError(err);
  expect(parsed?.code, err.message).toBe(code);
  expect(parsed?.detail).toMatch(detail);
}

const AGENT = "codex/gpt-6-astra";

it("the Ledger records a decision for the owner alone, dated, lists it, and withdraws it with a note", async () => {
  const L = await project("decisions-ledger");
  const text = "Another company reviews every change.";
  const d = await L.recordDecision({ text, quote: "another company reviews everywhere" }, "owner");
  expect(d).toMatchObject({ id: "d1", text, quote: "another company reviews everywhere", by: "owner", status: "standing" });
  expect(d.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  await refusal(L.recordDecision({ text: "No review is overridden.", quote: "no overrides" }, AGENT), "not_project_owner", /only the project owner records/);
  await refusal(L.recordDecision({ text, quote: "said again" }, "owner"), "already_decided", /d1 already records that decision/);
  await refusal(L.recordDecision({ text: "", quote: "words" }, "owner"), "bad_decision", /needs text/);
  await refusal(L.recordDecision({ text: "No review is overridden." }, "owner"), "bad_quote", /owner's words/);
  const d2 = await L.recordDecision({ text: "No review is overridden.", quote: "no overrides, ever" }, "owner");
  expect(d2.id).toBe("d2");
  expect((await L.standingDecisions()).map((x) => x.id)).toEqual(["d1", "d2"]);

  await refusal(L.withdrawDecision("d2", AGENT, "mine now"), "not_project_owner", /only the project owner withdraws/);
  await refusal(L.withdrawDecision("d2", "owner", ""), "bad_note", /needs a note/);
  await refusal(L.withdrawDecision("d2", "owner", undefined), "bad_note", /needs a note/);
  await refusal(L.withdrawDecision("d9", "owner", "gone"), "no_decision", /no decision d9/);
  const gone = await L.withdrawDecision("d2", "owner", "the owner allows one override");
  expect(gone).toMatchObject({ id: "d2", status: "withdrawn", withdrawn: { by: "owner", note: "the owner allows one override" } });
  await refusal(L.withdrawDecision("d2", "owner", "again"), "not_standing", /was withdrawn on/);
  // Withdrawn, it stops standing; the full list still shows it, marked.
  expect((await L.standingDecisions()).map((x) => x.id)).toEqual(["d1"]);
  expect((await L.decisions()).map((x) => [x.id, x.status])).toEqual([["d1", "standing"], ["d2", "withdrawn"]]);
  // The same decision can be recorded afresh once the old one is withdrawn.
  expect((await L.recordDecision({ text: "No review is overridden.", quote: "no overrides" }, "owner")).id).toBe("d3");
  const kinds = (await L.events() as unknown as LedgerEvent[]).filter((e) => e.kind.startsWith("decision.")).map((e) => [e.kind, e.data.id, e.actor]);
  expect(kinds).toEqual([["decision.recorded", "d3", "owner"], ["decision.withdrawn", "d2", "owner"], ["decision.recorded", "d2", "owner"], ["decision.recorded", "d1", "owner"]]);
});

it("the routes record and withdraw for the owner alone, and list for any actor", async () => {
  await project("decisions-routes");
  const made = await api("POST", "/projects/decisions-routes/decisions", "owner", { text: "Spend at most $5 a run.", quote: "five dollars a run" });
  expect(made.status).toBe(201);
  expect(await made.json()).toMatchObject({ id: "d1", status: "standing", by: "owner" });
  expect((await api("POST", "/projects/decisions-routes/decisions", AGENT, { text: "Mine.", quote: "mine" })).status).toBe(403);
  const bad = await api("POST", "/projects/decisions-routes/decisions", "owner", { text: "No words." });
  expect(bad.status).toBe(400);
  expect(((await bad.json()) as { error: string }).error).toBe("bad_quote");

  const listed = await api("GET", "/projects/decisions-routes/decisions", AGENT);
  expect(listed.status).toBe(200);
  expect(((await listed.json()) as { decisions: DecisionView[] }).decisions.map((d) => [d.id, d.status])).toEqual([["d1", "standing"]]);

  expect((await api("POST", "/projects/decisions-routes/decisions/d1/withdraw", AGENT, { note: "mine" })).status).toBe(403);
  const noNote = await api("POST", "/projects/decisions-routes/decisions/d1/withdraw", "owner", {});
  expect(noNote.status).toBe(400);
  const withdrawn = await api("POST", "/projects/decisions-routes/decisions/d1/withdraw", "owner", { note: "the budget changed" });
  expect(withdrawn.status).toBe(200);
  expect(await withdrawn.json()).toMatchObject({ id: "d1", status: "withdrawn", withdrawn: { note: "the budget changed" } });
  const after = ((await (await api("GET", "/projects/decisions-routes/decisions", "owner")).json()) as { decisions: DecisionView[] }).decisions;
  expect(after.map((d) => d.status)).toEqual(["withdrawn"]);
  expect((await api("GET", "/projects/decisions-routes/decisions/d1", "owner")).status).toBe(404);
  expect((await api("DELETE", "/projects/decisions-routes/decisions", "owner")).status).toBe(404);
});
