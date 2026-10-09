import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import type { LedgerEvent } from "../src/ledger.ts";
import type { Item } from "../src/rules.ts";

// The push scan through the Worker's two push paths (t332): the push route
// and the queue consumer. Each records the head with its scan pending, scans
// that exact commit, and records the result only for it, so a scan that
// fails, a reader that shows another commit, or a result for a head since
// superseded never passes a push silently. The key in the fixture is built
// at runtime from obviously fake parts, so no key-shaped value sits in this
// file; the flag the scan records never holds it either.

const TOKEN = "secret-push-owner";
const A = "claude-code/opus-5.5";
const H0 = "0".repeat(40), H1 = "1".repeat(40), H2 = "2".repeat(40);
const T0 = "a".repeat(40), T1 = "b".repeat(40), T2 = "c".repeat(40);
const B0 = "d".repeat(40), B1 = "e".repeat(40), B2 = "f".repeat(40);
const FAKE_KEY = ["sk", "proj", "x".repeat(24)].join("-");
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;

type Commit = { hash: string; parents: string[]; treeHash: string };
type Faults = { tree?: () => boolean };

// A baseline at H0 and a fork whose branch stands at `branch()`: H1 adds
// keys.ts holding the fake key, H2 on top of it replaces the key with a
// placeholder. `byRef` says whether a read by commit id shows that commit;
// when false the fork answers every read with `shows()`, as a reader that
// can only show its live head does. `faults.tree` fails a tree read.
function fakeArtifacts(name: string, branch: () => string, opts: { byRef: () => boolean; shows: () => string; faults: Faults }) {
  const commits: Record<string, Commit> = {
    [H0]: { hash: H0, parents: [], treeHash: T0 },
    [H1]: { hash: H1, parents: [H0], treeHash: T1 },
    [H2]: { hash: H2, parents: [H1], treeHash: T2 },
  };
  const trees: Record<string, Record<string, string>> = {
    [T0]: { "README.md": B0 },
    [T1]: { "README.md": B0, "keys.ts": B1 },
    [T2]: { "README.md": B0, "keys.ts": B2 },
  };
  const blobs: Record<string, string> = {
    [B0]: "# Keys\n",
    [B1]: `export const key = "${FAKE_KEY}";\n`,
    [B2]: "export const key = process.env.KEY ?? \"\";\n",
  };
  const chain = (from: string) => {
    const out: Commit[] = [];
    for (let h: string | undefined = from; h && commits[h]; h = commits[h].parents[0]) out.push(commits[h]);
    return out;
  };
  const counts = { tree: 0 };
  const binding = {
    get: async (repo: string) => ({
      info: async () => ({ remote: `https://git.test/${repo}.git`, defaultBranch: "main" }),
      log: async ({ ref, limit }: { ref?: string; limit?: number } = {}) => {
        if (repo === name) return chain(H0).slice(0, limit ?? 50);
        const from = ref === undefined ? branch() : opts.byRef() ? ref : opts.shows();
        return chain(from).slice(0, limit ?? 50);
      },
      readCommit: async (h: string) => commits[h] ?? null,
      readTree: async (h: string) => {
        counts.tree++;
        if (opts.faults.tree?.()) throw Object.assign(new Error("repository service unavailable"), { code: "UNAVAILABLE" });
        return trees[h] ? Object.entries(trees[h]).map(([n, hash]) => ({ name: n, mode: "100644", hash, type: "blob" })) : null;
      },
      readBlob: async (h: string) => (blobs[h] !== undefined ? new Blob([blobs[h]]) : null),
      [Symbol.dispose]() {},
    }),
  } as unknown as Artifacts;
  return { binding, counts };
}

async function setup(name: string) {
  const record = { name, repo: name, policy: { checks: [], protected: [] }, createdAt: new Date().toISOString() };
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.setProject(record as never, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record as never);
  await L.newItem("Wire the keys", [], "owner");
  await L.claim("t1", A);
  await L.setFork("t1", `${name}--t1`, H0, A);
  return L;
}

const api = (bindings: typeof env) => (method: string, path: string, actor: string, body?: unknown) => worker.fetch(new Request(`https://atelier.test/api${path}`, {
  method, headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": actor, "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
}), bindings);

type Detail = { item: Item; gate: { ready: boolean; blockers: string[] } };
const detail = async (call: ReturnType<typeof api>, name: string) => (await (await call("GET", `/projects/${name}/items/t1`, "owner")).json()) as Detail;
const notice = (name: string, after: string) => ({ type: "cf.artifacts.repo.pushed", source: { namespace: "atelier", repoName: `${name}--t1` }, payload: { ref: "refs/heads/main", after } });
const events = async (L: Awaited<ReturnType<typeof setup>>) => (await L.events("t1")) as unknown as LedgerEvent[];

function queue(bindings: typeof env, name: string, after: string) {
  const counts = { acks: 0, retries: 0 };
  const send = () => worker.queue({ messages: [{ body: notice(name, after), ack() { counts.acks++; }, retry() { counts.retries++; } }] } as unknown as MessageBatch<unknown>, bindings);
  return { counts, send };
}

afterEach(() => vi.restoreAllMocks());

it("a push event whose scan fails is retried with the gate blocked, and the redelivery scans the same head", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const name = "secret-queue-retry";
  const L = await setup(name);
  let failing = true;
  const { binding, counts } = fakeArtifacts(name, () => H1, { byRef: () => true, shows: () => H1, faults: { tree: () => failing } });
  const bindings = { ...testEnv, ARTIFACTS: binding } as typeof env;
  const call = api(bindings);
  const q = queue(bindings, name, H1);
  // The head is recorded with its scan pending; the scan's failure leaves it
  // so and the event is retried, not acknowledged.
  await q.send();
  expect(q.counts).toEqual({ acks: 0, retries: 1 });
  expect(await L.item("t1")).toMatchObject({ head: H1, secretScan: H1 });
  let d = await detail(call, name);
  expect(d.gate.ready).toBe(false);
  expect(d.gate.blockers).toContainEqual(expect.stringMatching(/^secret scan pending for 11111111/));
  // Redelivered with the head unchanged, the scan runs again and completes:
  // the flag names file and line, the pending mark is gone, the event is
  // acknowledged, and the gate now refuses on the flag alone.
  failing = false;
  await q.send();
  expect(q.counts).toEqual({ acks: 1, retries: 1 });
  const item = await L.item("t1");
  expect(item.secretScan).toBeUndefined();
  expect(item.secret).toMatchObject([{ file: "keys.ts", line: 1, head: H1 }]);
  d = await detail(call, name);
  expect(d.gate.blockers).toContain("secret flagged in keys.ts:1; clear it with a reason or push a revision that removes the line");
  expect(d.gate.blockers.some((b) => b.startsWith("secret scan pending"))).toBe(false);
  // Neither the record nor its events hold the value.
  expect(JSON.stringify([item, await events(L)])).not.toContain(FAKE_KEY);
  expect(JSON.stringify(await events(L))).not.toContain("sk-proj");
  // A further duplicate sighting of the scanned head runs no scan.
  const before = counts.tree;
  await q.send();
  expect(q.counts).toEqual({ acks: 2, retries: 1 });
  expect(counts.tree).toBe(before);
});

it("a reader that shows another commit than the recorded head leaves the scan pending, and the retry that reads the head records its flag", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const name = "secret-head-mismatch";
  const L = await setup(name);
  // The fork's branch stands at H1, but the read by commit id answers with
  // the newer, clean H2, as a reader that can only show its live head does
  // when the branch moved between the head read and the diff read.
  let byRef = false;
  const { binding } = fakeArtifacts(name, () => H1, { byRef: () => byRef, shows: () => H2, faults: {} });
  const bindings = { ...testEnv, ARTIFACTS: binding } as typeof env;
  const call = api(bindings);
  const res = await call("POST", `/projects/${name}/items/t1/push`, A, { head: H1 });
  expect(res.status).toBe(200);
  // The clean diff of H2 is not taken for H1's: nothing is recorded or
  // resolved for H1, whose scan stays pending, and the gate refuses.
  const pushed = (await res.json()) as Item;
  expect(pushed).toMatchObject({ head: H1, secretScan: H1 });
  expect(pushed.secret).toBeUndefined();
  expect((await events(L)).some((e) => e.kind.startsWith("secret."))).toBe(false);
  let d = await detail(call, name);
  expect(d.gate.ready).toBe(false);
  expect(d.gate.blockers).toContainEqual(expect.stringMatching(/^secret scan pending for 11111111/));
  // The owner cannot clear what has not been judged.
  const clear = await call("POST", `/projects/${name}/items/t1/clear-secret`, "owner", { reason: "a fake key" });
  expect(clear.status).toBe(409);
  expect(((await clear.json()) as { error: string }).error).toBe("secret_pending");
  // The event for the same head, with the reader now showing the commit
  // asked for, completes the scan of H1 itself: the key it holds is flagged.
  byRef = true;
  const q = queue(bindings, name, H1);
  await q.send();
  expect(q.counts).toEqual({ acks: 1, retries: 0 });
  expect(await L.item("t1")).toMatchObject({ head: H1, secret: [{ file: "keys.ts", line: 1, head: H1 }] });
  expect((await L.item("t1")).secretScan).toBeUndefined();
  d = await detail(call, name);
  expect(d.gate.blockers).toContainEqual(expect.stringMatching(/^secret flagged in keys\.ts:1/));
  expect(JSON.stringify(await events(L))).not.toContain(FAKE_KEY);
});

it("a push whose scan fails answers with the scan pending; pushing again at the same head scans it, and the answer carries the flag", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const name = "secret-push-retry";
  const L = await setup(name);
  let failing = true;
  const { binding } = fakeArtifacts(name, () => H1, { byRef: () => true, shows: () => H1, faults: { tree: () => failing } });
  const bindings = { ...testEnv, ARTIFACTS: binding } as typeof env;
  const call = api(bindings);
  const first = await call("POST", `/projects/${name}/items/t1/push`, A, { head: H1 });
  expect(first.status).toBe(200);
  expect((await first.json()) as Item).toMatchObject({ head: H1, secretScan: H1 });
  expect((await detail(call, name)).gate.blockers).toContainEqual(expect.stringMatching(/^secret scan pending/));
  // The same head pushed again is not re-recorded, but its pending scan runs,
  // and the answer is the item as the scan left it, flag included.
  failing = false;
  const second = await call("POST", `/projects/${name}/items/t1/push`, A, { head: H1 });
  expect(second.status).toBe(200);
  const answered = (await second.json()) as Item;
  expect(answered.secretScan).toBeUndefined();
  expect(answered.secret).toMatchObject([{ file: "keys.ts", line: 1, head: H1 }]);
  expect(answered).toEqual(await L.item("t1"));
  expect(JSON.stringify(answered)).not.toContain(FAKE_KEY);
});

it("a push with none of the patterns answers scanned and clean, and records no flag", async () => {
  const name = "secret-push-clean";
  const L = await setup(name);
  // The branch stands at H2, whose keys.ts holds no key pattern.
  const { binding } = fakeArtifacts(name, () => H2, { byRef: () => true, shows: () => H2, faults: {} });
  const bindings = { ...testEnv, ARTIFACTS: binding } as typeof env;
  const call = api(bindings);
  const res = await call("POST", `/projects/${name}/items/t1/push`, A, { head: H2 });
  expect(res.status).toBe(200);
  const pushed = (await res.json()) as Item;
  expect(pushed.head).toBe(H2);
  expect(pushed.secretScan).toBeUndefined();
  expect(pushed.secret).toBeUndefined();
  expect((await detail(call, name)).gate.blockers.some((b) => b.startsWith("secret"))).toBe(false);
  expect((await events(L)).some((e) => e.kind.startsWith("secret."))).toBe(false);
  // Seen again through the queue, the scanned head is acknowledged untouched.
  const q = queue(bindings, name, H2);
  await q.send();
  expect(q.counts).toEqual({ acks: 1, retries: 0 });
  expect((await L.item("t1")).secretScan).toBeUndefined();
});

it("a result for a head the fork has moved past is dropped, and the newer head's own scan stands", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const name = "secret-superseded";
  const L = await setup(name);
  // H1 is pushed and its scan fails, so it is recorded with its scan pending.
  let branch = H1, failing = true;
  const { binding } = fakeArtifacts(name, () => branch, { byRef: () => true, shows: () => branch, faults: { tree: () => failing } });
  const bindings = { ...testEnv, ARTIFACTS: binding } as typeof env;
  const call = api(bindings);
  expect((await call("POST", `/projects/${name}/items/t1/push`, A, { head: H1 })).status).toBe(200);
  expect(await L.item("t1")).toMatchObject({ head: H1, secretScan: H1 });
  // The fork moves to H2 and the push records it, with its own scan pending
  // after a failure of its own; a late result for H1 is then dropped.
  branch = H2;
  expect((await call("POST", `/projects/${name}/items/t1/push`, A, { head: H2 })).status).toBe(200);
  expect(await L.item("t1")).toMatchObject({ head: H2, secretScan: H2 });
  expect(await L.setSecret("t1", "atelier/events", H1, [{ file: "keys.ts", line: 1 }])).toMatchObject({ head: H2, secretScan: H2 });
  expect((await L.item("t1")).secret).toBeUndefined();
  expect((await detail(call, name)).gate.blockers).toContainEqual(expect.stringMatching(/^secret scan pending for 22222222/));
  // The event for H2 completes H2's scan: clean, so nothing blocks.
  failing = false;
  const q = queue(bindings, name, H2);
  await q.send();
  expect(q.counts).toEqual({ acks: 1, retries: 0 });
  const item = await L.item("t1");
  expect(item.secretScan).toBeUndefined();
  expect(item.secret).toBeUndefined();
  expect((await detail(call, name)).gate.blockers.some((b) => b.startsWith("secret"))).toBe(false);
});
