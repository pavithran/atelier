import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { env, runInDurableObject } from "./support/workers.ts";
import { NO_CRITERIA } from "../src/criteria.ts";
import { expect, it } from "./support/vitest.ts";
import worker from "../src/index.ts";
import type { LedgerEvent } from "../src/ledger.ts";
import { parsePostMerge, preparePostMerge, reservePostMerge } from "../src/post-merge.ts";
import type { Finding } from "../src/review/verdict.ts";

// t536: a finding's cause is corrected with `atelier finding --index N
// --cause` (criterion 2), and a required check that fails at landing or on
// main after a merge records its failing test names against the task, with a
// cause the orchestrator sets through the same command (criterion 3).
// Through the Worker's own fetch handler, with local fixtures only.

const TOKEN = "finding-cause-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const OPUS = "claude-code/opus-5.5", GPT = "codex/gpt-6-astra";
const ORCHESTRATOR = "zcode/glm-5.3";
const [H0, H1] = ["0", "1"].map((c) => c.repeat(40));
const L = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
const tagged: Finding = { file: "a.ts", line: 1, severity: "blocking", text: "drops rows", criterion: 2, cause: "coding" };
const old: Finding = { file: "b.ts", line: 2, severity: "blocking", text: "recorded before causes" };
const followUp: Finding = { file: "c.ts", line: 3, severity: "follow-up", text: "name it" };

function call(name: string, id: string, route: string, actor: string, body: unknown) {
  return worker.fetch(new Request(`https://atelier.test/api/projects/${name}/items/${id}/${route}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": actor, ...(actor === "owner" ? { "x-atelier-acting": ORCHESTRATOR } : {}), "content-type": "application/json" },
    body: JSON.stringify(body),
  }), testEnv);
}

async function task(name: string): Promise<string> {
  const record = { name, repo: name, policy: { checks: [], protected: [] }, createdAt: new Date().toISOString() };
  await L(name).setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  const { id } = await L(name).newItem("Rows", ["docs/**"], "owner");
  await L(name).claim(id, OPUS);
  await L(name).setWorkspace(id, `${name}--${id}`, H0, OPUS);
  await L(name).recordPush(id, OPUS, H1, H1);
  await L(name).submit(id, OPUS);
  return id;
}

const events = async (name: string, id: string, kind: string) => ((await L(name).events(id)) as unknown as LedgerEvent[]).filter((e) => e.kind === kind).sort((a, b) => a.seq - b.seq);
const review = (name: string, id: string, by: string, findings: Finding[]) =>
  L(name).addReview({ itemId: id, by, head: H1, criteria: NO_CRITERIA, approve: false, note: "no", at: new Date().toISOString(), findings });
const text = async (res: Response) => JSON.stringify(await res.json());

it("criterion 2: a finding's cause is corrected, recording who changed it and from what, and the reviewer's record is untouched", async () => {
  const name = "cause-correct";
  const id = await task(name);
  await review(name, id, GPT, [tagged, old, followUp]);
  const [{ seq }] = await events(name, id, "review.rejected");

  // A finding recorded without a cause shows unknown, and the first correction says so.
  const first = await call(name, id, "finding-cause", "owner", { index: 2, cause: "spec" });
  expect(first.status).toBe(201);
  expect(await first.json()).toMatchObject({ id, review: seq, by: GPT, from: "unknown", cause: "spec", acting: ORCHESTRATOR });
  // A correction of a reviewer's own tag says what it was.
  const second = await call(name, id, "finding-cause", "owner", { index: 1, cause: "wiring", head: H1 });
  expect(second.status).toBe(201);
  expect(await second.json()).toMatchObject({ from: "coding", cause: "wiring" });
  // A later correction of the same finding is from the one before it.
  expect(await (await call(name, id, "finding-cause", "owner", { index: 2, cause: "tests", reviewSeq: seq })).json()).toMatchObject({ from: "spec", cause: "tests" });
  // The same cause again records nothing.
  const same = await call(name, id, "finding-cause", "owner", { index: 2, cause: "tests" });
  expect(same.status).toBe(201);
  expect(await same.json()).toMatchObject({ from: "tests", cause: "tests", event: null });

  const recorded = await events(name, id, "review.finding_cause");
  expect(recorded.map((e) => [e.data.index, e.data.from, e.data.cause, e.data.acting, e.actor])).toEqual([
    [2, "unknown", "spec", ORCHESTRATOR, "owner"],
    [1, "coding", "wiring", ORCHESTRATOR, "owner"],
    [2, "spec", "tests", ORCHESTRATOR, "owner"],
  ]);
  expect(recorded[0].data).toMatchObject({ review: seq, by: GPT, finding: { file: "b.ts", severity: "blocking" } });
  // The review event itself still holds the findings as the reviewer gave them.
  const [rejected] = await events(name, id, "review.rejected");
  expect(rejected.data.findings).toEqual([tagged, old, followUp]);
});

it("criterion 2: each refusal writes nothing", async () => {
  const name = "cause-refused";
  const id = await task(name);
  await review(name, id, GPT, [tagged, old, followUp]);
  await review(name, id, GPT, [tagged]);
  const [one, two] = (await events(name, id, "review.rejected")).map((e) => e.seq);
  const refusals: [string, string, unknown, number][] = [
    ["only the developer", GPT, { index: 1, cause: "spec", reviewSeq: one }, 403],
    ["not a cause", "owner", { index: 1, cause: "typo", reviewSeq: one }, 400],
    ["unknown is not chosen", "owner", { index: 1, cause: "unknown", reviewSeq: one }, 400],
    ["no cause", "owner", { index: 1, reviewSeq: one }, 400],
    ["an index of zero", "owner", { index: 0, cause: "spec", reviewSeq: one }, 400],
    ["a fractional index", "owner", { index: 1.5, cause: "spec", reviewSeq: one }, 400],
    ["a short head", "owner", { index: 1, cause: "spec", head: "abc", reviewSeq: one }, 400],
    ["both selectors", "owner", { index: 1, cause: "spec", reviewSeq: one, reviewer: GPT }, 400],
    ["a follow-up has no cause", "owner", { index: 3, cause: "spec", reviewSeq: one }, 409],
    ["an index outside the review", "owner", { index: 4, cause: "spec", reviewSeq: one }, 409],
    ["a sequence that is no review", "owner", { index: 1, cause: "spec", reviewSeq: two + 1000 }, 409],
    ["two reviews with findings and no selector", "owner", { index: 1, cause: "spec" }, 409],
    ["one reviewer twice", "owner", { index: 1, cause: "spec", reviewer: GPT }, 409],
  ];
  for (const [why, actor, body, status] of refusals) {
    const res = await call(name, id, "finding-cause", actor, body);
    expect([why, res.status, (await res.text()).slice(0, 120)]).toEqual([why, status, expect.any(String)]);
  }
  expect(await events(name, id, "review.finding_cause")).toEqual([]);
});

// The names the fixture suite's failing tests carry (test/fixtures/check-logs/tap.txt).
const SUITE = readFileSync(resolve("test/fixtures/check-logs/tap.txt"), "utf8");
const NAMES = ["fails: the cap is enforced", "fails inside: names are read", "a suite"];

it("criterion 3: a required check failing at landing records each failing test's name, and the orchestrator sets its cause", async () => {
  const name = "cause-landing";
  const id = await task(name);
  await L(name).landEvent(id, "owner", "start", 0, { head: H1 });
  // The tail the landing records is cut to its last lines; the failing names come with it when the merge read them from the whole output.
  await L(name).landEvent(id, "owner", "checks", 5, { failed: true, failedCheck: "npm test", tail: SUITE.slice(-1500), failingTests: NAMES, mergeCommit: H1, attempt: 1 });
  const [failure] = await events(name, id, "check.failed_tests");
  expect(failure.data).toMatchObject({ where: "landing", check: "npm test", tests: NAMES, namesRead: true, cause: "unknown", mergeCommit: H1 });

  const set = await call(name, id, "check-cause", "owner", { failure: failure.seq, cause: "wiring" });
  expect(set.status).toBe(201);
  expect(await set.json()).toMatchObject({ failure: failure.seq, from: "unknown", cause: "wiring", acting: ORCHESTRATOR });
  const again = await call(name, id, "check-cause", "owner", { failure: failure.seq, cause: "spec" });
  expect(await again.json()).toMatchObject({ from: "wiring", cause: "spec" });
  expect((await events(name, id, "check.cause")).map((e) => [e.data.failure, e.data.from, e.data.cause, e.data.acting, e.actor])).toEqual([
    [failure.seq, "unknown", "wiring", ORCHESTRATOR, "owner"],
    [failure.seq, "wiring", "spec", ORCHESTRATOR, "owner"],
  ]);
});

it("criterion 3: a failure whose landing record sent no names has them read from the tail, and an output with none says so", async () => {
  const name = "cause-tail";
  const id = await task(name);
  await L(name).landEvent(id, "owner", "start", 0, { head: H1 });
  await L(name).landEvent(id, "owner", "checks", 5, { failed: true, failedCheck: "npm test", tail: SUITE.slice(-1900), attempt: 1 });
  const [read] = await events(name, id, "check.failed_tests");
  expect(read.data.namesRead).toBe(true);
  expect((read.data.tests as string[]).length).toBeGreaterThan(0);

  const other = await task("cause-tail-none");
  await L("cause-tail-none").landEvent(other, "owner", "start", 0, { head: H1 });
  await L("cause-tail-none").landEvent(other, "owner", "checks", 5, { failed: true, failedCheck: "npm run build", tail: "error: out of disk", attempt: 1 });
  const [none] = await events("cause-tail-none", other, "check.failed_tests");
  expect(none.data).toMatchObject({ tests: [], namesRead: false, cause: "unknown" });
  // A step that is not the checks, or that did not fail, records no failed check.
  await L("cause-tail-none").landEvent(other, "owner", "check", 5, { failed: true, tail: SUITE });
  expect(await events("cause-tail-none", other, "check.failed_tests")).toHaveLength(1);
});

it("criterion 3: a check step failing on main after a merge records its failing names against every merged task", async () => {
  const name = "cause-main";
  const a = await task(name), b = (await L(name).newItem("Second", ["docs/**"], "owner")).id;
  const policy = parsePostMerge({ version: 1, steps: [{ name: "suite", command: "npm test", class: "check", when: "always", protect: ["package.json"], timeoutMs: 1000 }], approval: { reason: "owner authorizes these commands" } }, "owner", new Date().toISOString())!;
  const run = reservePostMerge(policy, [a, b], H0, "run-1", new Date().toISOString());
  run.after = H1;
  preparePostMerge(run, []);
  await runInDurableObject(L(name), (instance) => (instance as unknown as { savePostMerge(r: unknown, actor: string, action: string): void }).savePostMerge(run, "owner", "prepared"));
  const started = await L(name).postMergeAction(a, "owner", { run: "run-1", action: "start" });
  const attempt = started.steps[0].attempts[0].id;
  await L(name).postMergeAction(a, "owner", { run: "run-1", action: "finish", attempt, passed: false, output: SUITE });
  for (const id of [a, b]) {
    const [failure] = await events(name, id, "check.failed_tests");
    expect(failure.data).toMatchObject({ where: "main", check: "npm test", tests: NAMES, cause: "unknown", step: "suite", run: "run-1", after: H1 });
  }
  // The orchestrator sets one task's record; the other task's stands apart.
  const [failure] = await events(name, a, "check.failed_tests");
  expect((await call(name, a, "check-cause", "owner", { failure: failure.seq, cause: "failure-path" })).status).toBe(201);
  expect(await events(name, b, "check.cause")).toEqual([]);
});

it("criterion 3: setting a check's cause is refused for anyone else, a bad cause or a record that is not the task's, and writes nothing", async () => {
  const name = "cause-check-refused";
  const id = await task(name);
  const other = (await L(name).newItem("Other", ["docs/**"], "owner")).id;
  await L(name).landEvent(id, "owner", "start", 0, { head: H1 });
  await L(name).landEvent(id, "owner", "checks", 5, { failed: true, failedCheck: "npm test", tail: SUITE.slice(-1500), failingTests: NAMES, attempt: 1 });
  const [{ seq }] = await events(name, id, "check.failed_tests");
  const refusals: [string, string, string, unknown, number][] = [
    ["not the developer", id, GPT, { failure: seq, cause: "spec" }, 403],
    ["a cause outside the list", id, "owner", { failure: seq, cause: "typo" }, 400],
    ["unknown is not set", id, "owner", { failure: seq, cause: "unknown" }, 400],
    ["no failure", id, "owner", { cause: "spec" }, 400],
    ["a fractional failure", id, "owner", { failure: 1.5, cause: "spec" }, 400],
    ["a sequence that is no failed check", id, "owner", { failure: seq + 1000, cause: "spec" }, 409],
    ["another task's failed check", other, "owner", { failure: seq, cause: "spec" }, 409],
  ];
  for (const [why, target, actor, body, status] of refusals) {
    const res = await call(name, target, "check-cause", actor, body);
    expect([why, res.status, (await res.text()).slice(0, 120)]).toEqual([why, status, expect.any(String)]);
  }
  expect(await events(name, id, "check.cause")).toEqual([]);
  expect(await events(name, other, "check.cause")).toEqual([]);
  expect(await text(await call(name, id, "check-cause", "owner", { failure: seq + 1000, cause: "spec" }))).toContain(String(seq));
});

it("criterion 1: the ledger refuses a finding whose criterion or cause is malformed, and keeps a tagged one whole", async () => {
  const name = "cause-validated";
  const id = await task(name);
  for (const bad of [{ cause: "typo" }, { cause: 3 }, { criterion: 0 }, { criterion: 1.5 }, { criterion: "2" }]) {
    await expect(review(name, id, GPT, [{ ...tagged, ...bad } as unknown as Finding])).rejects.toThrow(/findings must be a list/);
  }
  expect(await events(name, id, "review.rejected")).toEqual([]);
  await review(name, id, GPT, [{ ...tagged, criterion: null, cause: "unknown" }]);
  const [kept] = await events(name, id, "review.rejected");
  expect(kept.data.findings).toEqual([{ ...tagged, criterion: null, cause: "unknown" }]);
});
