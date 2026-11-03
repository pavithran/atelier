import { test } from "node:test";
import assert from "node:assert/strict";
import { runnerTransport } from "../cli/runner.mjs";
import { transientRead } from "../cli/transient-read.mjs";
process.env.ATELIER_LOAD = "0";
process.env.ATELIER_SERVER = "https://atelier.test";
const { serverVersion } = await import("../cli/atelier.mjs");

test("version preflight survives one timeout", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    if (++calls === 1) throw new DOMException("timed out", "TimeoutError");
    return Response.json({ capabilities: ["reviews.withdraw.v1"] });
  });
  assert.deepEqual(await serverVersion(), { capabilities: ["reviews.withdraw.v1"] });
  assert.equal(calls, 2);
});

test("review renewal survives one timeout with the same claim and identity", async () => {
  const calls = [];
  const transport = runnerTransport({ server: "https://atelier.test", credential: "reviewer-token", fetch: async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) throw new DOMException("timed out", "TimeoutError");
    return Response.json({ renewed: true });
  } });
  const result = await transport.send("review-renew", { project: "p", item: "t1" }, { actor: "codex/gpt", body: { request: 7 } });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.body, calls[1].init.body);
  assert.deepEqual(calls[0].init.headers, calls[1].init.headers);
  assert.notEqual(calls[0].init.signal, calls[1].init.signal);
});

for (const status of [401, 403, 409]) test(`renewal refusal ${status} is not retried`, async () => {
  let calls = 0;
  const transport = runnerTransport({ server: "https://atelier.test", credential: "reviewer-token", fetch: async () => {
    calls++;
    return Response.json({ error: "refused" }, { status });
  } });
  assert.equal((await transport.send("review-renew", { project: "p", item: "t1" }, { actor: "codex/gpt", body: { request: 7 } })).status, status);
  assert.equal(calls, 1);
});

test("persistent renewal timeouts stop after three attempts", async () => {
  let calls = 0;
  const transport = runnerTransport({ server: "https://atelier.test", credential: "reviewer-token", fetch: async () => {
    calls++;
    throw new DOMException("timed out", "TimeoutError");
  } });
  await assert.rejects(transport.send("review-renew", { project: "p", item: "t1" }, { actor: "codex/gpt", body: { request: 7 } }), { name: "TimeoutError" });
  assert.equal(calls, 3);
});

test("a transient response is retried and its body is released", async () => {
  let calls = 0;
  const first = new Response("unavailable", { status: 503 });
  const result = await transientRead(async () => ++calls === 1 ? first : Response.json({ ok: true }));
  assert.equal(result.status, 200);
  assert.equal(calls, 2);
  assert.equal(first.bodyUsed, true);
});

test("caller cancellation does not retry a timeout", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(transientRead(async () => {
    calls++;
    controller.abort();
    throw new DOMException("timed out", "TimeoutError");
  }, controller.signal), { name: "TimeoutError" });
  assert.equal(calls, 1);
});
