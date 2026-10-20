import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { NO_CRITERIA } from "../src/criteria.ts";
import type { Finding } from "../src/review/verdict.ts";

// t14: the job-brief route of an ordinary task sends the past findings other
// tasks of the same project had confirmed or fixed, as data beside its text.
// The finding it would have caught: t363, t478 and t705 each went six review
// rounds on defects an earlier review had already found and the developer had
// confirmed. Local fixtures only, through the Ledger as the route calls it.

const OPUS = "claude-code/opus-5.5", GPT = "codex/gpt-6-astra";
const [H0, H1] = ["0", "1"].map((c) => c.repeat(40));
const L = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
const blocker = (file: string, text: string): Finding => ({ file, line: 4, severity: "blocking", text });

async function project(name: string) {
  const record = { name, repo: name, policy: { checks: [], protected: [] }, createdAt: new Date().toISOString() };
  await L(name).setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
}

// A submitted task of the project, reviewed with `findings`, each judged by `verdicts`.
async function judged(name: string, scope: string[], findings: Finding[], verdicts: string[]): Promise<string> {
  const { id } = await L(name).newItem("Past work", scope, "owner");
  await L(name).claim(id, OPUS);
  await L(name).setFork(id, `${name}--${id}`, H0, OPUS);
  await L(name).recordPush(id, OPUS, H1, H1);
  await L(name).submit(id, OPUS);
  await L(name).addReview({ itemId: id, by: GPT, head: H1, criteria: NO_CRITERIA, approve: false, note: "no", at: new Date().toISOString(), findings });
  for (const [i, verdict] of verdicts.entries()) L(name).addFinding(id, "owner", H1, i + 1, verdict, "judged", { reviewer: GPT });
  return id;
}

// The task being built, claimed by OPUS and not yet pushed.
async function building(name: string, scope: string[]): Promise<string> {
  const { id } = await L(name).newItem("Now", scope, "owner");
  await L(name).claim(id, OPUS);
  return id;
}

type Brief = { text: string; history?: { entries?: { task: string; file: string; line: number | null; verdict: string; text: string }[]; unavailable?: true } };
const brief = async (name: string, id: string) => (await L(name).jobBrief(id, OPUS)) as unknown as Brief;

it("sends the latest confirmed or fixed blocking verdicts of other non-abandoned tasks on files in scope, newest first", async () => {
  const name = "history-select";
  await project(name);
  const first = await judged(name, ["src/**"], [blocker("src/a.ts", "drops rows"), blocker("docs/x.md", "outside the scope"), blocker("src/c.ts", "refuted one")], ["confirmed", "confirmed", "refuted"]);
  const second = await judged(name, ["src/**"], [blocker("src/b.ts", "leaks a handle")], ["fixed"]);
  const gone = await judged(name, ["src/**"], [blocker("src/d.ts", "from a closed task")], ["confirmed"]);
  L(name).abandon(gone, "owner", "not needed");
  // A later verdict on the same finding replaces the earlier one.
  const changed = await judged(name, ["src/**"], [blocker("src/e.ts", "changed its mind")], ["confirmed"]);
  L(name).addFinding(changed, "owner", H1, 1, "refuted", "after all", { reviewer: GPT });
  const id = await building(name, ["src/**"]);
  const got = await brief(name, id);
  expect(got.history?.entries).toEqual([
    { task: second, file: "src/b.ts", line: 4, verdict: "fixed", text: "leaks a handle" },
    { task: first, file: "src/a.ts", line: 4, verdict: "confirmed", text: "drops rows" },
  ]);
  // `text` is the brief as it was: history is carried beside it.
  expect(got.text).not.toContain("History");
});

it("a task with an empty scope is sent findings on every file", async () => {
  const name = "history-empty-scope";
  await project(name);
  await judged(name, ["docs/**"], [blocker("docs/x.md", "other task")], ["confirmed"]);
  const { id } = await L(name).newItem("Everything", [], "owner");
  await L(name).claim(id, OPUS);
  expect((await brief(name, id)).history?.entries?.map((e) => e.file)).toEqual(["docs/x.md"]);
});

it("never sends another project's findings", async () => {
  const a = "history-iso-a", b = "history-iso-b";
  await project(a); await project(b);
  await judged(b, ["src/**"], [blocker("src/secret.ts", "belongs to project b")], ["confirmed"]);
  const id = await building(a, ["src/**"]);
  expect((await brief(a, id)).history).toEqual({ entries: [] });
});

it("says the history is unavailable, not empty, when the read fails", async () => {
  const name = "history-unavailable";
  await project(name);
  await judged(name, ["src/**"], [blocker("src/a.ts", "drops rows")], ["confirmed"]);
  const id = await building(name, ["src/**"]);
  const got = await runInDurableObject(L(name), async (instance: object) => {
    const ledger = instance as unknown as { sql: { exec: (q: string, ...a: unknown[]) => unknown }; jobBrief: (id: string, actor: string) => Promise<Brief> };
    const real = ledger.sql;
    ledger.sql = { exec: (q: string, ...a: unknown[]) => { if (q.includes("kind = 'review.finding'")) throw new Error("storage unavailable"); return real.exec(q, ...a); } };
    try { return await ledger.jobBrief(id, OPUS); } finally { ledger.sql = real; }
  });
  expect(got.history).toEqual({ unavailable: true });
  expect(got.text).not.toContain("History");
});
