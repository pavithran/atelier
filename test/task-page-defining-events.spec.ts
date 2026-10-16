import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { briefFor, definingOf } from "../src/brief.ts";
import { landingOf } from "../src/diff.ts";
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
    for (let i = 0; i < 250; i++) insert("owner", "item.edited", { area: null });
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
  expect(html).toContain(`Ready for fast land at <code>${C1.slice(0, 12)}</code>`);
  expect(html).toContain("Reviewer availability: unknown, the pool was unreadable");
});

it("an item with few events is drawn from the same events as before", async () => {
  const L = await project("defining-few");
  const item = await L.newItem("Small", ["src/**"], "owner", { accept: ["Works"] });
  const d = await L.detail(item.id) as unknown as Detail;
  expect(definingOf(d).map((x) => x.seq)).toEqual(d.events.map((x) => x.seq));
});
