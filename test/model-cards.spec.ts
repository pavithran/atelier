import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import type { CardRecord, CardView } from "../src/models/cards.ts";

// Vendor model cards (t625) through the routes: the developer records them
// under a model's canonical key, a retry adds nothing, a model's cards are
// one set under every name and harness, they outlive the pool entry, and
// nothing the pool, routing or the notes read changes when one is added.

const TOKEN = "model-cards-test-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const AT = new Date().toISOString();
const TODAY = AT.slice(0, 10);
const entry = (id: string, harness: ModelEntry["harness"], aliases: string[] = []): ModelEntry => ({
  id, harness, where: "cloud", provider: "subscription", aliases, family: familyOf(id), note: "", addedBy: "owner", addedAt: AT,
});
const index = () => env.LEDGER.get(env.LEDGER.idFromName("__index"));

function call(method: string, path: string, body?: unknown, actor = "owner", token: string | null = TOKEN) {
  return worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "x-atelier-actor": actor, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), testEnv);
}
const card = (score: number, extra: Record<string, unknown> = {}) => ({
  vendor: "Anthropic", source: "https://vendor.example/opus-card", published: "2026-09-01", read: TODAY,
  claims: [{ benchmark: "SWE-bench Pro", score, unit: "%", conditions: { harness: "vendor scaffold", effort: "max" } }],
  limitations: ["Can over-engineer small fixes."], ...extra,
});
type Added = { record: CardRecord; retried: boolean; view: CardView };
const post = async (model: string, body: unknown) => {
  const res = await call("POST", `/models/${encodeURIComponent(model)}/cards`, body);
  return { status: res.status, ...(await res.json() as Added) };
};
const view = async (model: string) => await (await call("GET", `/models/${encodeURIComponent(model)}/cards`)).json() as CardView;

it("the developer records a card, a retry adds nothing, and one model's cards are one set under its aliases and harnesses", async () => {
  await index().putModel(entry("opus-5.5", "claude-code"));
  await index().putModel(entry("claude-opus-5-5", "antigravity"));
  const first = await post("opus-5.5", card(80.9));
  expect(first.status).toBe(201);
  expect(first.record).toMatchObject({ kind: "card", model: "opus-5.5", named: "opus-5.5", by: "owner", read: TODAY });
  expect(first.record.id).toMatch(/^c\d+$/);
  expect(first.record.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(first.view.pool).toEqual(["antigravity/claude-opus-5-5", "claude-code/opus-5.5"]);
  expect(first.view.priors).toEqual([expect.objectContaining({ kind: "model-card", prior: true, source: "Task t14: supplied cloud model prior" })]);

  // The same card again, by the vendor's API id under another harness: the same record.
  const again = await post("antigravity/claude-opus-5-5", card(80.9));
  expect(again.status).toBe(200);
  expect(again.retried).toBe(true);
  expect(again.record.id).toBe(first.record.id);

  // Another card under the alias: the same model, oldest first.
  const second = await post("claude-opus-5-5", card(78.2, { source: "https://other.example/leaderboard" }));
  expect(second.record.model).toBe("opus-5.5");
  for (const name of ["opus-5.5", "claude-opus-5-5", "claude-code/Opus-5.5", "antigravity/claude-opus-5-5"]) {
    expect((await view(name)).cards.map((c) => c.id)).toEqual([first.record.id, second.record.id]);
  }
  // Both stay visible, with their sources and conditions, as a conflict.
  expect(second.view.disagreements).toEqual([expect.objectContaining({
    kind: "conflict", benchmark: "SWE-bench Pro",
    claims: [
      { card: first.record.id, score: 80.9, source: "https://vendor.example/opus-card", conditions: { harness: "vendor scaffold", effort: "max" } },
      { card: second.record.id, score: 78.2, source: "https://other.example/leaderboard", conditions: { harness: "vendor scaffold", effort: "max" } },
    ],
  })]);
});

it("corrections, supersessions and withdrawals name a card and keep the history", async () => {
  const a = await post("sonnet-5.5", card(70));
  const fixed = await post("sonnet-5.5", card(71, { corrects: a.record.id, reason: "Misread the table." }));
  expect(fixed.status).toBe(201);
  expect((await post("sonnet-5.5", card(72, { corrects: a.record.id }))).status).toBe(409);
  expect((await post("sonnet-5.5", card(72, { supersedes: "c99999" }))).status).toBe(404);
  // A card of another model cannot be replaced from this one.
  const other = await post("glm-5.3", card(50));
  expect((await post("sonnet-5.5", card(72, { supersedes: other.record.id }))).status).toBe(404);

  const gone = await post("sonnet-5.5", { withdraws: fixed.record.id, reason: "The vendor withdrew the figure." });
  expect(gone.status).toBe(201);
  const retry = await post("sonnet-5.5", { withdraws: fixed.record.id, reason: "The vendor withdrew the figure." });
  expect(retry).toMatchObject({ status: 200, retried: true, record: { id: gone.record.id } });
  const shown = await view("sonnet-5.5");
  expect(shown.cards.map((c) => [c.id, c.state, c.endedBy])).toEqual([[a.record.id, "corrected", fixed.record.id], [fixed.record.id, "withdrawn", gone.record.id]]);
  expect(shown.withdrawals).toEqual([expect.objectContaining({ withdraws: fixed.record.id, reason: "The vendor withdrew the figure." })]);
  expect(shown.disagreements).toEqual([]);
});

it("a card is listed by the key its name gives, which no pool removal, re-addition or alias changes", async () => {
  // The fourth reviews of t625, 2026-10-13: every reading of pool aliases moved cards across models.
  await index().putModel(entry("gpt-6.1-sol", "codex", ["sol-preview"]));
  const sol = await post("codex/gpt-6.1-sol", card(64));
  expect(sol.record.model).toBe("gpt-6.1-sol");
  await index().removeModel("gpt-6.1-sol");
  expect((await view("gpt-6.1-sol")).cards.map((c) => c.id)).toEqual([sol.record.id]);
  await index().putModel(entry("gpt-6.1-sol", "codex", ["sol-preview"]));
  expect((await view("opencode/gpt-6.1-sol")).cards.map((c) => c.id)).toEqual([sol.record.id]);
  // A pool alias is not the model's name for cards: a card sent under it is kept under it.
  const preview = await post("sol-preview", card(65));
  expect(preview.record.model).toBe("sol-preview");
  expect(preview.view).toMatchObject({ model: "sol-preview", known: false, pool: [] });
  expect((await view("gpt-6.1-sol")).cards.map((c) => c.id)).toEqual([sol.record.id]);

  // A model nobody registered is kept under its normalised name, and the answer says so.
  const unknown = await post("Gemini-3.8-Flash-Preview", card(55));
  expect(unknown.view).toMatchObject({ model: "gemini-3.8-flash-preview", known: false, pool: [], priors: [] });
  expect(sol.view.known).toBe(true);
});

it("one model's name under any harness is one key; the same model through a registry alias too", async () => {
  // gemini-4-argon's fourth review: removing one harness's entry hid a surviving harness's cards.
  await index().putModel(entry("argon-x", "gemini-cli"));
  await index().putModel(entry("argon-x", "antigravity"));
  const one = await post("antigravity/argon-x", card(30));
  const two = await post("gemini-cli/argon-x", card(31));
  await index().removeModel("argon-x");
  for (const name of ["argon-x", "gemini-cli/argon-x", "antigravity/argon-x", "opencode/Argon-X"]) {
    expect((await view(name)).cards.map((c) => c.id)).toEqual([one.record.id, two.record.id]);
  }
});

it("a model never withdraws, corrects or replays another model's card, whatever the pool's aliases say", async () => {
  // Astra's fourth review of t625, 2026-10-13, finding 1: B could withdraw A's card after an alias moved.
  await index().putModel(entry("alias-model-a", "codex", ["alias-preview"]));
  const c1 = await post("alias-model-a", card(33));
  await index().putModel(entry("alias-model-a", "codex"));
  await index().putModel(entry("alias-model-b", "codex", ["alias-preview", "alias-model-a"]));
  expect((await post("alias-model-b", { withdraws: c1.record.id, reason: "Not B's." })).status).toBe(404);
  expect((await post("alias-preview", card(34, { corrects: c1.record.id }))).status).toBe(404);
  // The same content sent for B is B's own card, not a retry of A's.
  const b1 = await post("alias-model-b", card(33));
  expect(b1).toMatchObject({ status: 201, retried: false, record: { model: "alias-model-b" } });
  expect((await view("alias-model-b")).cards.map((c) => c.id)).toEqual([b1.record.id]);

  // A withdraws its own card; no pool change shows it active anywhere.
  await post("alias-model-a", { withdraws: c1.record.id, reason: "Recorded twice." });
  await index().removeModel("alias-model-a");
  await index().removeModel("alias-model-b");
  await index().putModel(entry("alias-model-c", "opencode", ["alias-model-a"]));
  expect((await view("alias-model-a")).cards.map((c) => [c.id, c.state])).toEqual([[c1.record.id, "withdrawn"]]);
  expect((await view("alias-model-c")).cards).toEqual([]);
  const replay = await post("alias-model-a", card(33));
  expect(replay).toMatchObject({ status: 200, retried: true, record: { id: c1.record.id } });
});

it("cards are the developer's alone, are checked on the server, and change neither the pool nor its notes", async () => {
  await index().putModel(entry("private-card-model", "codex"));
  await call("POST", "/models/private-card-model/notes", { text: "Stalls on long refactors." });
  const before = await (await call("GET", "/models")).json();
  expect((await post("private-card-model", card(40))).status).toBe(201);
  expect(await (await call("GET", "/models")).json()).toEqual(before);
  expect((await call("GET", "/models")).headers.get("content-type")).toMatch(/json/);
  const pool = before as (ModelEntry & { notes?: unknown[]; cards?: unknown })[];
  const mine = pool.find((m) => m.id === "private-card-model")!;
  expect(mine.notes).toHaveLength(1);
  expect(mine.cards).toBeUndefined();

  expect((await call("GET", "/models/private-card-model/cards", undefined, "codex/other")).status).toBe(403);
  expect((await call("POST", "/models/private-card-model/cards", card(41), "codex/other")).status).toBe(403);
  expect((await call("GET", "/models/private-card-model/cards", undefined, "owner", null)).status).toBe(401);
  for (const bad of [card(Number.NaN), card(1, { source: "http://vendor.example/x" }), card(1, { read: "2026-02-30" }), card(1, { extra: true }), { claims: [] }]) {
    expect((await call("POST", "/models/private-card-model/cards", bad)).status).toBe(400);
  }
  expect((await call("POST", "/models/not%20a%20model/cards", card(1))).status).toBe(400);
  expect((await view("private-card-model")).cards).toHaveLength(1);
});
