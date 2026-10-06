import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import type { LedgerEvent } from "../src/ledger.ts";
import { parseRuleError } from "../src/rules.ts";

// A push whose head no longer holds the head the Ledger recorded has
// rewritten the fork's history: the commits recorded before are off the
// branch. The Worker reads the fork's history to tell; the Ledger refuses
// such a push unless it declares the rebase `atelier update` made, by naming
// the recorded head, and records that rewrite with the head it replaced. A
// push seen through the queue that does the same leaves the head where it
// was and notes the fact. This is the server side of the t105 audit's
// gl-force-push.sh; test/update-force-push.test.mjs is the CLI side.

const H0 = "0".repeat(40), H1 = "1".repeat(40), H2 = "2".repeat(40), H3 = "3".repeat(40);
const M = "e".repeat(40), X = "f".repeat(40), Y = "d".repeat(40);
const A = "claude-code/opus-5.5";
const TOKEN = "lineage-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;

async function setup(name: string) {
  const record = { name, repo: name, policy: { checks: [], protected: [] }, createdAt: new Date().toISOString() };
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  await L.newItem("Keep every push", [], "owner");
  await L.claim("t1", A);
  await L.setFork("t1", `${name}--t1`, H0, A);
  return L;
}

async function refusal(p: Promise<unknown>, code: string, detail: RegExp): Promise<void> {
  const err = await p.then(() => new Error(`expected a ${code} refusal`), (e: unknown) => e as Error);
  const parsed = parseRuleError(err);
  expect(parsed?.code).toBe(code);
  expect(parsed?.detail).toMatch(detail);
}

// The generated stub types type events() as never (see test/ledger.spec.ts); the values arrive whole.
const events = async (L: Awaited<ReturnType<typeof setup>>) => (await L.events("t1")) as unknown as LedgerEvent[];

// A fork whose branch stands at head(), holding the commits `graph`
// describes, each hash mapped to its parents in Git order. log lists the
// first-parent chain from a ref, as Artifacts does; readCommit reads one
// commit. The counts say which the Worker needed.
function artifacts(head: () => string, graph: Record<string, string[]>) {
  const reads = { log: 0, commits: 0 };
  const chain = (from: string) => {
    const out: { hash: string; parents: string[] }[] = [];
    for (let h: string | undefined = from; h && graph[h]; h = graph[h][0]) out.push({ hash: h, parents: graph[h] });
    return out;
  };
  const binding = {
    get: async () => ({
      info: async () => ({ defaultBranch: "main" }),
      log: async ({ ref, limit }: { ref?: string; limit?: number } = {}) => { reads.log++; return chain(ref ?? head()).slice(0, limit ?? 50); },
      readCommit: async (h: string) => { reads.commits++; return graph[h] ? { hash: h, parents: graph[h] } : null; },
      [Symbol.dispose]() {},
    }),
  } as unknown as Artifacts;
  return { reads, binding };
}

const push = (name: string, body: unknown, bindings: typeof env) => worker.fetch(new Request(`https://atelier.test/api/projects/${name}/items/t1/push`, {
  method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": A, "content-type": "application/json" }, body: JSON.stringify(body),
}), bindings);

it("the Ledger refuses a head that does not hold the recorded one unless the push declares the rebase from it", async () => {
  const L = await setup("lineage-ledger");
  await L.recordPush("t1", A, H1, H1);
  await refusal(L.recordPush("t1", A, H2, H2, false, { holdsRecorded: false, rebasedFrom: null }), "history_rewritten", /t1's workspace is at 22222222, which does not hold 11111111, the head Atelier recorded/);
  await refusal(L.recordPush("t1", A, H2, H2, false, { holdsRecorded: false, rebasedFrom: H0 }), "history_rewritten", /does not hold 11111111/);
  expect((await L.item("t1")).head).toBe(H1);
  expect((await events(L)).some((e) => e.kind === "push.observed" && e.data.head === H2)).toBe(false);
  // The declaration names the recorded head: the rewrite is recorded with it.
  expect(await L.recordPush("t1", A, H2, H2, false, { holdsRecorded: false, rebasedFrom: H1 })).toMatchObject({ head: H2, state: "claimed" });
  expect((await events(L)).find((e) => e.kind === "push.observed")?.data).toMatchObject({ head: H2, rebasedFrom: H1 });
  // A head that holds the recorded one needs no declaration, and one it carries anyway marks no rewrite.
  expect(await L.recordPush("t1", A, H3, H3, false, { holdsRecorded: true, rebasedFrom: H2 })).toMatchObject({ head: H3 });
  expect((await events(L)).find((e) => e.kind === "push.observed")?.data).not.toHaveProperty("rebasedFrom");
});

it("a push seen on the fork that does not hold the recorded head leaves the head and is noted", async () => {
  const L = await setup("lineage-observe");
  await L.recordPush("t1", A, H1, H1);
  expect(await L.observePush("t1", H2, H1, false)).toMatchObject({ head: H1, state: "claimed" });
  expect((await events(L)).find((e) => e.kind === "push.unrecorded")?.data).toMatchObject({ head: H2, recorded: H1, source: "artifacts", reason: "history_rewritten" });
  expect((await events(L)).some((e) => e.kind === "push.observed" && e.data.head === H2)).toBe(false);
  // The same sighting delivered again is noted once; another head is noted on its own.
  await L.observePush("t1", H2, H1, false);
  expect((await events(L)).filter((e) => e.kind === "push.unrecorded")).toHaveLength(1);
  await L.observePush("t1", H3, H1, false);
  expect((await events(L)).filter((e) => e.kind === "push.unrecorded").map((e) => e.data.head)).toEqual([H3, H2]);
  expect(await L.observePush("t1", H2, H1, true)).toMatchObject({ head: H2 });
});

it("the push route reads the fork's history: a fast-forward passes, a rewrite needs the declaration, a merge's second parent counts", async () => {
  const name = "lineage-route";
  const L = await setup(name);
  // H1 and H2 on H0 in a line; H3 on H0 alone, as a rebase leaves it; M a
  // merge whose first parent X is on H0 and whose second parent Y is on H3.
  const graph: Record<string, string[]> = { [H0]: [], [H1]: [H0], [H2]: [H1], [H3]: [H0], [X]: [H0], [Y]: [H3], [M]: [X, Y] };
  let head = H1;
  const { reads, binding } = artifacts(() => head, graph);
  const bindings = { ...testEnv, ARTIFACTS: binding } as typeof env;
  expect((await push(name, { head: H1 }, bindings)).status).toBe(200);
  head = H2;
  expect((await push(name, { head: H2 }, bindings)).status).toBe(200);
  expect((await L.item("t1")).head).toBe(H2);
  expect(reads.commits).toBe(0);
  // H3 does not hold H2: refused, and refused again when the declaration names another head.
  head = H3;
  const refused = await push(name, { head: H3 }, bindings);
  expect(refused.status).toBe(409);
  expect(((await refused.json()) as { error: string }).error).toBe("history_rewritten");
  expect((await push(name, { head: H3, rebasedFrom: H1 }, bindings)).status).toBe(409);
  expect((await push(name, { head: H3, rebasedFrom: "not a hash" }, bindings)).status).toBe(409);
  expect((await L.item("t1")).head).toBe(H2);
  const declared = await push(name, { head: H3, rebasedFrom: H2 }, bindings);
  expect(declared.status).toBe(200);
  expect((await L.item("t1")).head).toBe(H3);
  expect((await events(L)).find((e) => e.kind === "push.observed")?.data).toMatchObject({ head: H3, rebasedFrom: H2 });
  // The merge's first-parent chain lacks H3; the chain behind its second parent is listed and holds it.
  head = M;
  reads.log = 0;
  expect((await push(name, { head: M }, bindings)).status).toBe(200);
  expect((await L.item("t1")).head).toBe(M);
  expect(reads).toEqual({ log: 3, commits: 0 });
  expect((await events(L)).find((e) => e.kind === "push.observed")?.data).not.toHaveProperty("rebasedFrom");
});

// Hashes for histories built by count: 40 hex characters, one family letter
// first, so families stay apart from each other and from H0..Y above.
const hash = (family: string, i: number) => `${family}${i.toString(16).padStart(39, "0")}`;
// n commits in a line, numbered from 1 at the bottom; the first stands on
// `onto`, or alone. Returns the tip.
function line(graph: Record<string, string[]>, family: string, n: number, onto: string | null): string {
  for (let i = 1; i <= n; i++) graph[hash(family, i)] = i === 1 ? (onto ? [onto] : []) : [hash(family, i - 1)];
  return hash(family, n);
}

it("the walk continues past a log page: a recorded head deeper than one page, or behind a merge's second parent, is found", async () => {
  const name = "lineage-deep";
  const L = await setup(name);
  const graph: Record<string, string[]> = { [H0]: [] };
  // 1105 commits on H0 in a line; the recorded head is the fifth from the
  // bottom, 1100 commits below the tip, past the first page of a thousand.
  const tip = line(graph, "a", 1105, H0);
  let head = hash("a", 5);
  const { reads, binding } = artifacts(() => head, graph);
  const bindings = { ...testEnv, ARTIFACTS: binding } as typeof env;
  expect((await push(name, { head }, bindings)).status).toBe(200);
  head = tip;
  reads.log = 0;
  expect((await push(name, { head: tip }, bindings)).status).toBe(200);
  expect((await L.item("t1")).head).toBe(tip);
  // headOf reads one page; the walk reads the first page, then the next from its last commit's first parent.
  expect(reads).toEqual({ log: 3, commits: 0 });
  expect((await events(L)).find((e) => e.kind === "push.observed")?.data).not.toHaveProperty("rebasedFrom");
  // A merge whose first parent stands on H0 alone and whose second parent
  // heads 1500 commits on the tip: the chain behind the second parent is
  // read a page at a time, not a commit at a time, and is not cut short.
  const branch = line(graph, "c", 1500, tip);
  graph[M] = [line(graph, "b", 1, H0), branch];
  head = M;
  reads.log = 0;
  expect((await push(name, { head: M }, bindings)).status).toBe(200);
  expect((await L.item("t1")).head).toBe(M);
  expect(reads).toEqual({ log: 4, commits: 0 });
  expect((await events(L)).find((e) => e.kind === "push.observed")?.data).not.toHaveProperty("rebasedFrom");
});

it("a search that stops at its budget is refused as unverified, not as a rewrite, unless the push declares the rebase", async () => {
  const name = "lineage-budget";
  const L = await setup(name);
  const graph: Record<string, string[]> = { [H0]: [], [H1]: [H0] };
  let head = H1;
  const { reads, binding } = artifacts(() => head, graph);
  const bindings = { ...testEnv, ARTIFACTS: binding } as typeof env;
  expect((await push(name, { head: H1 }, bindings)).status).toBe(200);
  // A history of 10,050 commits that never reaches H1: the search stops at ten thousand.
  const tip = line(graph, "a", 10_050, null);
  head = tip;
  reads.log = 0;
  const refused = await push(name, { head: tip }, bindings);
  expect(refused.status).toBe(409);
  const body = (await refused.json()) as { error: string; detail: string };
  expect(body.error).toBe("ancestry_unverified");
  expect(body.detail).toMatch(/could not verify ancestry within 10000 commits/);
  expect(reads).toEqual({ log: 11, commits: 0 });
  expect((await L.item("t1")).head).toBe(H1);
  expect((await events(L)).some((e) => e.kind === "push.observed" && e.data.head === tip)).toBe(false);
  // Seen through the queue, the same head is left where it is and the note says why.
  const notice = { type: "cf.artifacts.repo.pushed", source: { namespace: "atelier", repoName: `${name}--t1` }, payload: { ref: "refs/heads/main", after: tip } };
  let acks = 0, retries = 0;
  await worker.queue({ messages: [{ body: notice, ack() { acks++; }, retry() { retries++; } }] } as unknown as MessageBatch<unknown>, bindings);
  expect([acks, retries]).toEqual([1, 0]);
  expect((await L.item("t1")).head).toBe(H1);
  expect((await events(L)).find((e) => e.kind === "push.unrecorded")?.data).toMatchObject({ head: tip, recorded: H1, reason: "ancestry_unverified" });
  // A declaration naming another head is refused the same way; one naming the
  // recorded head is taken as a rewrite, and the record says it was not confirmed.
  const other = await push(name, { head: tip, rebasedFrom: H0 }, bindings);
  expect(other.status).toBe(409);
  expect(((await other.json()) as { error: string }).error).toBe("ancestry_unverified");
  expect((await push(name, { head: tip, rebasedFrom: H1 }, bindings)).status).toBe(200);
  expect((await L.item("t1")).head).toBe(tip);
  expect((await events(L)).find((e) => e.kind === "push.observed")?.data).toMatchObject({ head: tip, rebasedFrom: H1, unverified: true });
});

it("the Ledger tells a search that stopped short from a rewrite: its own refusal, or a declared rebase marked unconfirmed", async () => {
  const L = await setup("lineage-unverified");
  await L.recordPush("t1", A, H1, H1);
  await refusal(L.recordPush("t1", A, H2, H2, false, { holdsRecorded: null, searched: 10_000, rebasedFrom: null }), "ancestry_unverified", /could not verify ancestry within 10000 commits of the fork's history: 11111111, the head it recorded/);
  await refusal(L.recordPush("t1", A, H2, H2, false, { holdsRecorded: null, searched: 10_000, rebasedFrom: H0 }), "ancestry_unverified", /push with atelier push --force/);
  expect((await L.item("t1")).head).toBe(H1);
  expect((await events(L)).some((e) => e.kind === "push.observed" && e.data.head === H2)).toBe(false);
  expect(await L.recordPush("t1", A, H2, H2, false, { holdsRecorded: null, searched: 10_000, rebasedFrom: H1 })).toMatchObject({ head: H2, state: "claimed" });
  expect((await events(L)).find((e) => e.kind === "push.observed")?.data).toMatchObject({ head: H2, rebasedFrom: H1, unverified: true });
  // A verified rewrite, declared, is recorded as before, without the mark.
  expect(await L.recordPush("t1", A, H3, H3, false, { holdsRecorded: false, rebasedFrom: H2 })).toMatchObject({ head: H3 });
  expect((await events(L)).find((e) => e.kind === "push.observed")?.data).toMatchObject({ head: H3, rebasedFrom: H2 });
  expect((await events(L)).find((e) => e.kind === "push.observed")?.data).not.toHaveProperty("unverified");
  // Seen through the queue, such a head is left and the note says the search stopped short.
  expect(await L.observePush("t1", M, H3, null)).toMatchObject({ head: H3 });
  expect((await events(L)).find((e) => e.kind === "push.unrecorded")?.data).toMatchObject({ head: M, recorded: H3, reason: "ancestry_unverified" });
});

it("a push event whose head does not hold the recorded one leaves the head and notes it until the CLI declares the rebase", async () => {
  const name = "lineage-queue";
  const L = await setup(name);
  await L.recordPush("t1", A, H1, H1);
  const graph: Record<string, string[]> = { [H0]: [], [H1]: [H0], [H3]: [H0] };
  const { binding } = artifacts(() => H3, graph);
  const notice = { type: "cf.artifacts.repo.pushed", source: { namespace: "atelier", repoName: `${name}--t1` }, payload: { ref: "refs/heads/main", after: H3 } };
  let acks = 0, retries = 0;
  const send = () => worker.queue({ messages: [{ body: notice, ack() { acks++; }, retry() { retries++; } }] } as unknown as MessageBatch<unknown>, { ...env, ARTIFACTS: binding });
  await send();
  expect([acks, retries]).toEqual([1, 0]);
  expect((await L.item("t1")).head).toBe(H1);
  expect((await events(L)).find((e) => e.kind === "push.unrecorded")?.data).toMatchObject({ head: H3, recorded: H1 });
  // The CLI's own call, declaring the head it rebased from, records the push; the event seen again changes nothing.
  expect((await push(name, { head: H3, rebasedFrom: H1 }, { ...testEnv, ARTIFACTS: binding } as typeof env)).status).toBe(200);
  expect((await L.item("t1")).head).toBe(H3);
  await send();
  expect([acks, retries]).toEqual([2, 0]);
  expect((await events(L)).filter((e) => e.kind === "push.unrecorded")).toHaveLength(1);
});
