import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import { familyOf, type ModelEntry, type ModelNote } from "../src/models/pool.ts";

// The owner keeps dated notes under a pool model (t406): the route stores
// them, the pool read carries them oldest first, and a builder suggestion
// names the latest one that bears on the task.

const TOKEN = "model-notes-test-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const AT = new Date().toISOString();
const entry = (id: string, harness: ModelEntry["harness"]): ModelEntry => ({
  id, harness, where: "home", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: AT,
});

const index = () => env.LEDGER.get(env.LEDGER.idFromName("__index"));
const ledger = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));

function call(method: string, path: string, body?: unknown, actor = "owner") {
  return worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": actor, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), testEnv);
}

it("the owner keeps dated notes under a pool model, listed oldest first with the entry", async () => {
  await index().putModel(entry("notes-model", "codex"));
  const first = await call("POST", "/models/notes-model/notes", { text: "Stalled twice on long refactors.", item: "t12" });
  expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({ by: "owner", text: "Stalled twice on long refactors.", item: "t12" });
  await call("POST", "/models/notes-model/notes", { text: "Commits without the full suite; run it before submitting." });

  const pool = await (await call("GET", "/models")).json() as (ModelEntry & { notes?: ModelNote[] })[];
  const notes = pool.find((m) => m.id === "notes-model")!.notes!;
  expect(notes.map((n) => n.text)).toEqual(["Stalled twice on long refactors.", "Commits without the full suite; run it before submitting."]);
  expect(notes[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(notes[1].item).toBeUndefined();
  expect(pool.find((m) => m.id !== "notes-model")?.notes).toBeUndefined();
});

it("a note needs a pool model, the owner, text without a key, and a task name", async () => {
  await index().putModel(entry("refused-model", "codex"));
  expect((await call("POST", "/models/no-such-model/notes", { text: "fine" })).status).toBe(404);
  expect((await call("POST", "/models/refused-model/notes", { text: "fine" }, "codex/other")).status).toBe(403);
  expect((await call("POST", "/models/refused-model/notes", { text: "   " })).status).toBe(400);
  expect((await call("POST", "/models/refused-model/notes", { text: "key sk-proj-AbC123xyzQrS456" })).status).toBe(400);
  expect((await call("POST", "/models/refused-model/notes", { text: "fine", item: "406" })).status).toBe(400);
  expect((await (await call("GET", "/models")).json() as ModelEntry[]).find((m) => m.id === "refused-model")?.notes).toBeUndefined();
});

it("a builder suggestion names the latest note that bears on the task", async () => {
  const name = "notes-suggest";
  const record = { name, repo: name, policy: { checks: ["npm test"], protected: ["src/**"] }, createdAt: AT };
  await ledger(name).setProject(record, "owner");
  await index().registerProject(record);
  await index().putModel(entry("suggest-note-model", "codex"));
  const created = await (await call("POST", `/projects/${name}/items`, { title: "Small edit", scope: ["docs/**"] })).json() as { id: string };
  const path = `/projects/${name}/items/${created.id}/dispatch`;

  await call("POST", "/models/suggest-note-model/notes", { text: "Stalls on refactors." });
  const other = await (await call("POST", "/models/suggest-note-model/notes", { text: "Only another task is affected.", item: "t999" })).json() as ModelNote;
  expect(other.item).toBe("t999");
  const general = await (await call("POST", path, { suggest: true, model: "suggest-note-model" })).json() as { suggestion: { reasons: string[] } };
  expect(general.suggestion.reasons).toContain(`Latest note, ${AT.slice(0, 10)} by owner: Stalls on refactors.`);
  expect(general.suggestion.reasons.join(" ")).not.toMatch(/Only another task/);

  await call("POST", "/models/suggest-note-model/notes", { text: "Runs the full suite on this task.", item: created.id });
  const named = await (await call("POST", path, { suggest: true, model: "suggest-note-model" })).json() as { suggestion: { reasons: string[] } };
  expect(named.suggestion.reasons.some((r) => r.startsWith(`Latest note, ${AT.slice(0, 10)} by owner on ${created.id}: Runs the full suite`))).toBe(true);
});
