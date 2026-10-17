import { test } from "node:test";
import assert from "node:assert/strict";
import { forgetToldLedgers, guardLedger, serverUpdating } from "../src/ledger-stub.ts";
import { parseRuleError, UPDATING_DETAIL } from "../src/rules.ts";

// The Worker's side of a Ledger a deploy left on older code (t586). On
// 2026-10-13 from 09:35 to 10:05 EDT, after the deploys of t578 and t585,
// the atelier Ledger answered "The RPC receiver does not implement the
// method" for showcaseCounts and mode, and the showcase showed zeros.

const NEW = "b".repeat(40);
const missing = (method: string) => new Error(`The RPC receiver does not implement the method "${method}".`);

// A stub of a Ledger on older code: it serves the methods it has and fails
// the others as the runtime does, and records every call.
function staleStub(has: Record<string, (...args: unknown[]) => unknown>) {
  const calls: { method: string; args: unknown[] }[] = [];
  const stub = new Proxy({}, {
    get(_t, prop) {
      if (typeof prop !== "string") return undefined;
      if (prop === "then") return undefined;
      return (...args: unknown[]) => {
        calls.push({ method: prop, args });
        const fn = has[prop];
        return fn ? Promise.resolve(fn(...args)) : Promise.reject(missing(prop));
      };
    },
  }) as Record<string, (...args: unknown[]) => Promise<unknown>>;
  return { stub, calls };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

test("a call a stale Ledger lacks answers that the server is updating, and asks it to restart", async () => {
  forgetToldLedgers();
  const { stub, calls } = staleStub({ project: () => ({ name: "p" }), restartForUpdate: () => ({ restarting: true }) });
  const L = guardLedger(stub, "project:p", NEW);
  assert.deepEqual(await L.project(), { name: "p" });
  const err = await L.mode().then(() => null, (e: unknown) => e);
  assert.ok(serverUpdating(err));
  assert.deepEqual(parseRuleError(err), { status: 503, code: "server_updating", detail: UPDATING_DETAIL });
  await flush();
  assert.deepEqual(calls.find((c) => c.method === "restartForUpdate")?.args, [NEW, "mode"]);
});

test("a Ledger older than t586 cannot be asked to restart, and the caller still hears the server is updating", async () => {
  forgetToldLedgers();
  const { stub } = staleStub({});
  const L = guardLedger(stub, "project:old", NEW);
  const err = await L.showcaseCounts("2026-10-01T00:00:00.000Z", "UTC").then(() => null, (e: unknown) => e);
  assert.equal(parseRuleError(err)?.code, "server_updating");
  await flush();
});

test("other errors pass through untouched", async () => {
  forgetToldLedgers();
  const boom = new Error("409|closed|t1 is merged");
  const { stub } = staleStub({ claim: () => { throw boom; } });
  const L = guardLedger(stub, "project:q", null);
  assert.equal(await L.claim("t1").then(() => null, (e: unknown) => e), boom);
  assert.equal(serverUpdating(boom), false);
});

test("the first call of an isolate tells the Ledger the Worker's DEPLOYED_MAIN, once, after that call has settled (t744)", async () => {
  forgetToldLedgers();
  const { stub, calls } = staleStub({ ledgerVersion: () => ({ version: "a".repeat(40), restarting: true, why: "stale" }), items: () => [] });
  await guardLedger(stub, "project:r", NEW).items();
  await flush();
  await guardLedger(stub, "project:r", NEW).items();
  assert.deepEqual(calls.map((c) => c.method), ["items", "ledgerVersion", "items"]);
  assert.deepEqual(calls[1].args, [NEW]);
});

test("a Ledger that cannot answer the version, or must wait, is told again a minute later", async () => {
  forgetToldLedgers();
  let now = 1_000_000;
  const old = staleStub({ items: () => [] });
  await guardLedger(old.stub, "project:s", NEW, () => now).items();
  await flush();
  await guardLedger(old.stub, "project:s", NEW, () => now + 30_000).items();
  await flush();
  assert.equal(old.calls.filter((c) => c.method === "ledgerVersion").length, 1);
  now += 60_000;
  await guardLedger(old.stub, "project:s", NEW, () => now).items();
  await flush();
  assert.equal(old.calls.filter((c) => c.method === "ledgerVersion").length, 2);

  const waiting = staleStub({ ledgerVersion: () => ({ version: "a".repeat(40), restarting: false, why: "too_soon" }), items: () => [] });
  await guardLedger(waiting.stub, "project:w", NEW, () => now).items();
  await flush();
  await guardLedger(waiting.stub, "project:w", NEW, () => now + 60_000).items();
  await flush();
  assert.equal(waiting.calls.filter((c) => c.method === "ledgerVersion").length, 2);
});

test("a Worker without DEPLOYED_MAIN, as in local development, sends no version", async () => {
  forgetToldLedgers();
  const { stub, calls } = staleStub({ items: () => [] });
  await guardLedger(stub, "project:t", undefined).items();
  await guardLedger(stub, "project:t", "  ").items();
  assert.deepEqual(calls.map((c) => c.method), ["items", "items"]);
});
