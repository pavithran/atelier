import { test } from "node:test";
import assert from "node:assert/strict";
import { coreCount, envLoad, formatLoad, loadLimitOf, waitForLoad } from "../cli/load.mjs";

// t403: the load average a home runner and a landing's checks hold back
// under. These cover the reading, the limit and the wait, with an injected
// sequence of readings so no real load is consulted.

test("formatLoad rounds to one decimal and shows a non-number as a question mark", () => {
  assert.equal(formatLoad(81.37), "81.4");
  assert.equal(formatLoad(2), "2");
  assert.equal(formatLoad(0), "0");
  assert.equal(formatLoad(Number.NaN), "?");
  assert.equal(formatLoad(undefined), "?");
});

test("loadLimitOf takes a configured number and falls back to the core count", () => {
  assert.equal(loadLimitOf(4, 8), 4);
  assert.equal(loadLimitOf(undefined, 8), 8);
  assert.equal(loadLimitOf(0, 8), 0, "an explicit zero is kept, not treated as missing");
});

test("coreCount is at least one", () => {
  assert.ok(coreCount() >= 1);
});

test("envLoad consumes a comma-separated sequence and repeats its last reading", () => {
  const read = envLoad({ ATELIER_LOAD: "90,81.5,2" });
  assert.equal(read(), 90);
  assert.equal(read(), 81.5);
  assert.equal(read(), 2);
  assert.equal(read(), 2, "the last reading repeats once the sequence is spent");
  const one = envLoad({ ATELIER_LOAD: "7" });
  assert.equal(one(), 7);
  assert.equal(one(), 7);
});

test("envLoad ignores junk entries and reads the real load without ATELIER_LOAD", () => {
  const read = envLoad({ ATELIER_LOAD: "junk, ,4,x" });
  assert.equal(read(), 4);
  assert.equal(read(), 4);
  const real = envLoad({});
  assert.equal(typeof read, "function");
  assert.ok(Number.isFinite(real()), "the real load average is a finite number");
});

test("waitForLoad returns the first reading under the limit and reports each hold once", async () => {
  const readings = [90, 81.5, 81.5, 2];
  const reports = [];
  const waits = [];
  const readLoad = () => readings.shift() ?? 1;
  const started = await waitForLoad(10, {
    readLoad,
    wait: async (ms) => { waits.push(ms); },
    report: (current) => reports.push(current),
  });
  assert.equal(started, 2);
  assert.deepEqual(reports, [90], "the wait is reported once when it first holds, not once per poll");
  assert.deepEqual(waits, [5000, 5000, 5000]);
});

test("waitForLoad returns at once when the load is already under the limit", async () => {
  const reports = [];
  const started = await waitForLoad(10, { readLoad: () => 3, wait: async () => { throw new Error("must not wait"); }, report: (c) => reports.push(c) });
  assert.equal(started, 3);
  assert.deepEqual(reports, []);
});
