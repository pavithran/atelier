import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { briefFor, definingOf } from "../src/brief.ts";
import { landingOf } from "../src/diff.ts";
import { criteriaOf } from "../src/criteria.ts";
import worker from "../src/index.ts";
import { signIn } from "./signin.ts";
import { standingFastReady } from "../src/rules.ts";
import { renderItem, type Detail } from "../src/ui.ts";
import type { ProjectPolicy } from "../src/rules.ts";

// t661, the follow-up of t637: detail() carries only the newest 200 events,
// so a task page block defined by an older event lost it once 200 more
// followed (the merge receipt, the submission summary, the defect links, the
// ready report, the override's availability line, the merge recorded
// afterwards). Each is read by kind now (Ledger.definingEvents); this seeds
// each with 250 later events and checks every block.

const AT = "2026-10-13T12:00:00.000Z";
const policy: ProjectPolicy = { checks: [], protected: [] };
const H = "a".repeat(40), C1 = "c".repeat(40), M1 = "d".repeat(40), M2 = "e".repeat(40);
const OPUS = "claude-code/opus-5.5";

const ledger = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
async function project(name: string) {
  const record = { name, repo: `${name}--baseline`, policy, createdAt: AT };
  await ledger(name).setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  return ledger(name);
}
// Raw rows, as the ledger would have logged them, then 250 later events.
async function seed(name: string, id: string, rows: { actor?: string; kind: string; data: Record<string, unknown> }[], item: Record<string, string | null> = {}) {
  await runInDurableObject(ledger(name), async (_i, s) => {
    const insert = (actor: string, kind: string, data: unknown) => s.storage.sql.exec(`INSERT INTO events (item_id, at, actor, kind, data) VALUES (?, ?, ?, ?, ?)`, id, AT, actor, kind, JSON.stringify(data));
    for (const r of rows) insert(r.actor ?? "owner", r.kind, r.data);
    for (let i = 0; i < 250; i++) insert("owner", "item.edited", { nextGate: null });
    for (const [col, v] of Object.entries(item)) s.storage.sql.exec(`UPDATE items SET ${col} = ? WHERE id = ?`, v, id);
  });
}

it("a merged task's receipt, diff landing, recorded merge and defect links render from events older than the newest 200", async () => {
  const name = "defining-merged";
  const L = await project(name);
  const item = await L.newItem("Finished", ["src/**"], "owner", { accept: ["Works"] });
  await seed(name, item.id, [
    { kind: "item.merged", data: { mergeCommit: M1, head: C1 } },
    { kind: "item.merge_recorded", data: { commit: C1, mergeCommit: M1, reviews: [] } },
    { kind: "item.defect_of", data: { itemId: "t901" } },
    { kind: "item.defect", data: { mergeCommit: M2, foundIn: "t902" } },
  ], { state: "merged", head: C1, accepted_head: C1 });
  const d = await L.detail(item.id) as unknown as Detail;
  expect(d.events.some((x) => x.kind === "item.merged")).toBe(false);
  // The landing the diff and the receipt read, and the closed-task line.
  expect(landingOf(d.item, d.events)).toBeNull();
  expect(landingOf(d.item, definingOf(d))?.commit).toBe(M1);
  expect(briefFor(d).recommendation.reason).toContain(`merged as ${M1.slice(0, 8)}`);
  const html = renderItem(await L.project(), d);
  expect(html).toContain("Merged outside Atelier");
  expect(html).toContain("Defect from post-merge review of");
  expect(html).toContain(">t901<");
  expect(html).toContain("Post-merge defect:");
  expect(html).toContain(">t902<");
});

it("a task in review keeps its submission summary, ready report and override availability line beyond the window", async () => {
  const name = "defining-review";
  const L = await project(name);
  const item = await L.newItem("In review", ["src/**"], "owner", { accept: ["Works"] });
  const override = { head: H, by: "owner", reason: "no reviewer", at: AT };
  await seed(name, item.id, [
    { kind: "item.submitted", actor: OPUS, data: { head: H, summary: "Did the whole thing" } },
    { kind: "item.fast_ready", actor: OPUS, data: { commit: C1, base: H, builder: OPUS } },
    { kind: "review.overridden", data: { head: H, availability: { known: false, why: "the pool was unreadable" } } },
  ], { state: "submitted", head: H, review_override: JSON.stringify(override) });
  const d = await L.detail(item.id) as unknown as Detail;
  expect(d.events.some((x) => x.kind === "item.submitted")).toBe(false);
  expect(standingFastReady(d.events)).toBeNull();
  expect(standingFastReady(definingOf(d))?.commit).toBe(C1);
  const html = renderItem(await L.project(), d);
  expect(html).toContain("Did the whole thing");
  expect(html).toContain(`Ready to merge at <code>${C1.slice(0, 12)}</code>`);
  expect(html).toContain("Reviewer availability: unknown, the pool was unreadable");
});

it("an item with few events is drawn from the same events as before", async () => {
  const L = await project("defining-few");
  const item = await L.newItem("Small", ["src/**"], "owner", { accept: ["Works"] });
  const d = await L.detail(item.id) as unknown as Detail;
  expect(definingOf(d).map((x) => x.seq)).toEqual(d.events.map((x) => x.seq));
});

// The pages themselves (review 1 of t661): every changed call site is driven
// through the page or route it serves. The Artifacts binding is a spy that
// records which repository is opened and which commit is read, and reads
// nothing, so the diff comes back "unavailable" and what the page asked for
// is the proof of which landing it saw. A page that lost the landing past the
// window would open nothing at all (no fork, no landing, no diff).
const TOKEN = "defining-pages-owner";
const spy = () => {
  const opened: string[] = [], read: string[] = [];
  const ARTIFACTS = { async get(name: string) { opened.push(name); return { readCommit: async (h: string) => { read.push(h); return null; }, [Symbol.dispose]() {} }; } };
  return { opened, read, env: { ...env, ATELIER_TOKEN: TOKEN, ARTIFACTS } as unknown as typeof env };
};
const get = async (path: string, bindings: typeof env, cookie: string) => (await worker.fetch(new Request(`https://atelier.test${path}`, { headers: { cookie } }), bindings)).text();
// What each page says of a diff it could not read.
const UNREAD = { task: "The diff could not be read from Artifacts just now", decisions: "Could not be read just now" };

it("the task page and the decisions page diff a merged task from its merge beyond the window", async () => {
  const name = "defining-pages-merged";
  const L = await project(name);
  const item = await L.newItem("Merged long ago", ["src/**"], "owner", { accept: ["Works"] });
  await seed(name, item.id, [{ kind: "item.merged", data: { mergeCommit: M1, head: C1 } }], { state: "merged", head: C1, accepted_head: C1 });
  const cookie = await signIn(TOKEN, { ...env, ATELIER_TOKEN: TOKEN } as typeof env);
  for (const [path, said] of [[`/p/${name}/${item.id}`, UNREAD.task], [`/decisions?project=${name}&task=${item.id}`, UNREAD.decisions]]) {
    const s = spy();
    expect(await get(path, s.env, cookie), path).toContain(said);
    expect(s.opened, path).toContain(`${name}--baseline`);
    expect(s.read, path).toContain(M1);
  }
});

it("a plan part integrated beyond the window is diffed from the plan branch at the commit it went in as, on both pages", async () => {
  const name = "defining-pages-part";
  const L = await project(name);
  const plan = await L.newItem("The plan", ["src/**"], "owner", { accept: ["Works"] });
  const part = await L.newItem("A part", ["src/**"], "owner", { accept: ["Works"] });
  await runInDurableObject(L, async (_i, s) => { s.storage.sql.exec(`UPDATE items SET fork = ? WHERE id = ?`, `${name}--plan`, plan.id); });
  await seed(name, part.id, [
    { kind: "item.merged", data: { mergeCommit: M1, head: C1, via: plan.id } },
    { kind: "part.integrated", data: { mergeCommit: M2, head: C1 } },
  ], { state: "merged", head: C1, accepted_head: C1, kind: "part", plan: plan.id });
  const now = await L.item(part.id);
  // A review of the landed commit, bound to its criteria, past the window too.
  await runInDurableObject(L, async (_i, s) => {
    const review = { itemId: part.id, by: "gpt-6-astra", head: M2, approve: true, note: "Audit of the landed integration", at: AT, criteria: criteriaOf(now) };
    s.storage.sql.exec(`INSERT INTO reviews (item_id, json) VALUES (?, ?)`, part.id, JSON.stringify(review));
  });
  const cookie = await signIn(TOKEN, { ...env, ATELIER_TOKEN: TOKEN } as typeof env);
  const d = await L.detail(part.id) as unknown as Detail;
  expect(d.events.some((x) => x.kind === "part.integrated")).toBe(false);

  const task = spy();
  const page = await get(`/p/${name}/${part.id}`, task.env, cookie);
  expect(page).toContain(UNREAD.task);
  expect(task.opened).toContain(`${name}--plan`);
  expect(task.read).toContain(M2);
  expect(task.read).not.toContain(M1);
  // The review of the landed head, beside the reviews of the item's own.
  expect(page).toContain("Audit of the landed integration");

  const decisions = spy();
  expect(await get(`/decisions?project=${name}&task=${part.id}`, decisions.env, cookie)).toContain(UNREAD.decisions);
  expect(decisions.opened).toContain(`${name}--plan`);
  expect(decisions.read).toContain(M2);
  expect(decisions.read).not.toContain(M1);
});

it("a ready report stale by an event after it stays hidden once both are buried", async () => {
  const name = "defining-stale";
  const L = await project(name);
  const item = await L.newItem("Reported then released", ["src/**"], "owner", { accept: ["Works"] });
  await seed(name, item.id, [
    { kind: "item.fast_ready", actor: OPUS, data: { commit: C1, base: H, builder: OPUS } },
    { kind: "item.released", actor: OPUS, data: {} },
  ], { state: "open" });
  const d = await L.detail(item.id) as unknown as Detail;
  expect(standingFastReady(definingOf(d))).toBeNull();
  expect(renderItem(await L.project(), d)).not.toContain("Ready to merge");
});
