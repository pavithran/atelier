import { test } from "node:test";
import assert from "node:assert/strict";
import { gateMethods, RestartGate } from "../src/restart-gate.ts";

// The Ledger's restart after a deploy (t586) fires between requests: the
// gate counts the calls in flight and aborts once none has been for
// settleMs, or after maxWaitMs whatever is in flight.

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a restart asked for while idle fires after the settle time", async () => {
  const fired: string[] = [];
  const gate = new RestartGate((reason) => fired.push(reason), 5, 1000);
  assert.equal(gate.request("stale"), true);
  assert.equal(gate.pending, true);
  assert.equal(gate.request("again"), false, "one restart at a time");
  await wait(30);
  assert.deepEqual(fired, ["stale"]);
  assert.equal(gate.request("later"), false, "a gate fires once; the Ledger that starts next has its own");
});

test("a restart waits for every call in flight, including background work it holds", async () => {
  const fired: string[] = [];
  const gate = new RestartGate((reason) => fired.push(reason), 5, 1000);
  let finish!: () => void;
  const slow = gate.run(() => new Promise<void>((r) => { finish = r; }));
  let deliver!: () => void;
  const held = gate.hold(new Promise<void>((r) => { deliver = r; }));
  assert.equal(gate.inflight, 2);
  gate.request("stale");
  await wait(30);
  assert.deepEqual(fired, [], "nothing fires while a call is in flight");
  finish();
  await slow;
  await wait(30);
  assert.deepEqual(fired, [], "background delivery still holds it");
  deliver();
  await held;
  await wait(30);
  assert.deepEqual(fired, ["stale"]);
});

test("a call that throws, synchronously or by rejecting, leaves the gate", async () => {
  const gate = new RestartGate(() => {}, 5, 1000);
  assert.throws(() => gate.run(() => { throw new Error("boom"); }), /boom/);
  await assert.rejects(gate.run(() => Promise.reject(new Error("later"))), /later/);
  assert.equal(gate.run(() => 7), 7);
  assert.equal(gate.inflight, 0);
});

test("a Ledger never idle long enough restarts after the longest wait", async () => {
  const fired: string[] = [];
  const gate = new RestartGate((reason) => fired.push(reason), 5, 40);
  void gate.run(() => new Promise<void>(() => {}));
  gate.request("stale");
  await wait(80);
  assert.equal(fired.length, 1);
  assert.match(fired[0], /^stale; still busy after 0 s$/);
});

test("a request arriving in the settle time puts the restart off until it ends", async () => {
  const fired: string[] = [];
  const gate = new RestartGate((reason) => fired.push(reason), 20, 1000);
  gate.request("stale");
  let finish!: () => void;
  const late = gate.run(() => new Promise<void>((r) => { finish = r; }));
  await wait(40);
  assert.deepEqual(fired, []);
  finish();
  await late;
  await wait(50);
  assert.deepEqual(fired, ["stale"]);
});

test("gateMethods counts every prototype method of an instance with a gate", async () => {
  class Thing {
    n = 1;
    get twice(): number { return this.n * 2; }
    sync(x: number): number { return this.n + x; }
    async later(): Promise<number> { await wait(5); return this.n; }
  }
  const gates = new WeakMap<object, RestartGate>();
  gateMethods(Thing.prototype, (self) => gates.get(self));
  const plain = new Thing();
  assert.equal(plain.sync(1), 2, "an instance without a gate calls straight through");
  const t = new Thing();
  const gate = new RestartGate(() => {}, 5, 1000);
  gates.set(t, gate);
  assert.equal(t.sync(2), 3);
  assert.equal(t.twice, 2, "getters are left alone");
  const p = t.later();
  assert.equal(gate.inflight, 1);
  assert.equal(await p, 1);
  assert.equal(gate.inflight, 0);
});
