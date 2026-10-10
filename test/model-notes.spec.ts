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
  const first = await call("POST", "/models/notes-model/notes", { text: "Stalled twice on long refactors.", item: "t12", project: "alpha" });
  expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({ by: "owner", text: "Stalled twice on long refactors.", item: "t12", project: "alpha" });
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
  expect((await call("POST", "/models/refused-model/notes", { text: "fine", item: "406", project: "alpha" })).status).toBe(400);
  expect((await call("POST", "/models/refused-model/notes", { text: "fine", item: "t1" })).status).toBe(400);
  expect((await (await call("GET", "/models")).json() as ModelEntry[]).find((m) => m.id === "refused-model")?.notes).toBeUndefined();
});

it("a builder suggestion names the latest note that bears on the task in its own project, where another project has the same task id", async () => {
  const projects = ["notes-alpha", "notes-beta", "notes-gamma"];
  const items: Record<string, string> = {};
  for (const name of projects) {
    const record = { name, repo: name, policy: { checks: ["npm test"], protected: ["src/**"] }, createdAt: AT };
    await ledger(name).setProject(record, "owner");
    await index().registerProject(record);
    items[name] = (await (await call("POST", `/projects/${name}/items`, { title: "Small edit", scope: ["docs/**"] })).json() as { id: string }).id;
  }
  expect(Object.values(items)).toEqual(["t1", "t1", "t1"]);
  await index().putModel(entry("suggest-note-model", "codex"));
  const suggest = async (name: string) => (await (await call("POST", `/projects/${name}/items/${items[name]}/dispatch`, { suggest: true, model: "suggest-note-model" })).json() as { suggestion: { reasons: string[] } }).suggestion.reasons;
  const day = AT.slice(0, 10);

  await call("POST", "/models/suggest-note-model/notes", { text: "Stalls on refactors." });
  await call("POST", "/models/suggest-note-model/notes", { text: "Only alpha's task is affected.", item: "t1", project: "notes-alpha" });
  const beta = await (await call("POST", "/models/suggest-note-model/notes", { text: "Only beta's task is affected.", item: "t1", project: "notes-beta" })).json() as ModelNote;
  expect(beta).toMatchObject({ item: "t1", project: "notes-beta" });

  expect(await suggest("notes-alpha")).toContain(`Latest note, ${day} by owner on notes-alpha/t1: Only alpha's task is affected.`);
  expect(await suggest("notes-beta")).toContain(`Latest note, ${day} by owner on notes-beta/t1: Only beta's task is affected.`);
  const gamma = await suggest("notes-gamma");
  expect(gamma).toContain(`Latest note, ${day} by owner: Stalls on refactors.`);
  expect(gamma.join(" ")).not.toMatch(/Only (alpha|beta)/);
});

it("a renamed project keeps its task notes under its current name, and a note named by either name bears on the task", async () => {
  const record = { name: "notes-old", repo: "notes-old", policy: { checks: ["npm test"], protected: ["src/**"] }, createdAt: AT };
  await ledger("notes-old").setProject(record, "owner");
  await index().registerProject(record);
  const { id } = await (await call("POST", "/projects/notes-old/items", { title: "Small edit", scope: ["docs/**"] })).json() as { id: string };
  await index().putModel(entry("rename-note-model", "codex"));
  await call("POST", "/models/rename-note-model/notes", { text: "Only the renamed task is affected.", item: id, project: "notes-old" });
  expect((await call("POST", "/projects/notes-old/rename", { to: "notes-new" })).status).toBe(200);

  const suggest = async () => (await (await call("POST", `/projects/notes-new/items/${id}/dispatch`, { suggest: true, model: "rename-note-model" })).json() as { suggestion: { reasons: string[] } }).suggestion.reasons;
  expect(await suggest()).toContain(`Latest note, ${AT.slice(0, 10)} by owner on notes-new/${id}: Only the renamed task is affected.`);

  const former = await call("POST", "/models/rename-note-model/notes", { text: "Named by the former name.", item: id, project: "notes-old" });
  expect(await former.json()).toMatchObject({ project: "notes-old", projectName: "notes-new" });
  const pool = await (await call("GET", "/models")).json() as (ModelEntry & { notes?: ModelNote[] })[];
  expect(pool.find((m) => m.id === "rename-note-model")!.notes!.map((n) => n.projectName)).toEqual(["notes-new", "notes-new"]);
  expect(await suggest()).toContain(`Latest note, ${AT.slice(0, 10)} by owner on notes-new/${id}: Named by the former name.`);
});
