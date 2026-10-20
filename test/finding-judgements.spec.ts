import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { renderItem, type Detail } from "../src/ui.ts";
import type { ProjectPolicy } from "../src/rules.ts";

// t47: a merged task's page lists each blocking finding with the developer's
// newest verdict or "Unjudged", the judged and total counts and the
// precision of the judged alone. Finding it would have caught: a figure
// built on a few judgements looked the same as one built on all of them.
// The rows are read by kind, so 250 later events do not hide the reviews.

const AT = "2026-10-13T12:00:00.000Z";
const policy: ProjectPolicy = { checks: [], protected: [] };
const H = "a".repeat(40);
const GPT = "codex/gpt-6-astra";
const ledger = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));

async function seeded(name: string, state: string) {
  const record = { name, repo: `${name}--baseline`, policy, createdAt: AT };
  await ledger(name).setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  const L = ledger(name);
  const item = await L.newItem("Finished", ["src/**"], "owner", { accept: ["Works"] });
  const findings = [1, 2, 3].map((n) => ({ file: "src/x.ts", line: n, severity: "blocking", text: `finding number ${n}` }));
  await runInDurableObject(L, async (_i, s) => {
    const insert = (actor: string, kind: string, data: unknown) => s.storage.sql.exec(`INSERT INTO events (item_id, at, actor, kind, data) VALUES (?, ?, ?, ?, ?)`, item.id, AT, actor, kind, JSON.stringify(data));
    insert(GPT, "review.rejected", { head: H, note: "", findings });
    const review = s.storage.sql.exec(`SELECT MAX(seq) AS seq FROM events WHERE kind = 'review.rejected'`).one().seq;
    const judge = (index: number, verdict: string) => insert("owner", "review.finding", { head: H, index, verdict, note: `note ${verdict}`, by: GPT, review, finding: findings[index - 1] });
    judge(1, "refuted"); judge(1, "confirmed"); judge(2, "refuted");
    for (let i = 0; i < 250; i++) insert("owner", "item.edited", { nextGate: null });
    s.storage.sql.exec(`UPDATE items SET state = ?, head = ?, accepted_head = ? WHERE id = ?`, state, H, H, item.id);
  });
  return { L, id: item.id };
}

it("a merged task shows each blocking finding with its newest verdict or Unjudged, and judged of total", async () => {
  const { L, id } = await seeded("judgements-merged", "merged");
  const d = await L.detail(id) as unknown as Detail;
  expect(d.events.some((x) => x.kind === "review.rejected")).toBe(false);
  const html = renderItem(await L.project(), d);
  expect(html).toContain("Blocking findings · 2 of 3 judged");
  expect(html).toContain("1 of 2 judged held up, 50% precision");
  expect(html).toContain("finding number 1");
  expect(html).toContain("corrected: refuted");
  expect(html).toContain("note confirmed");
  expect(html).toContain(">Unjudged<");
  expect(html).toContain(">refuted<");
  expect(html).toContain(">confirmed<");
});

it("a task not merged shows no finding judgements", async () => {
  const { L, id } = await seeded("judgements-submitted", "submitted");
  const html = renderItem(await L.project(), await L.detail(id) as unknown as Detail);
  expect(html).not.toContain("Blocking findings ·");
});
