import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TOKEN_EXPIRY_WARN_DAYS,
  daysUntil,
  formatTokenExpiryWarnings,
  parseExpiryDay,
  tokenExpiryWarnings,
  warns,
} from "../src/token-expiry.ts";

// The warning window is what matters here: a token warns from 14 days before
// its recorded expiry, and after it, naming the token and the date.
const NOON = new Date("2026-10-09T12:00:00.000Z");

test("parseExpiryDay reads a real day and refuses a rolled-over or malformed one", () => {
  assert.equal(parseExpiryDay("2026-12-01")?.toISOString(), "2026-12-01T00:00:00.000Z");
  assert.equal(parseExpiryDay("2026-02-31"), null, "February 31 rolls over and is not a day");
  assert.equal(parseExpiryDay("2026-13-01"), null);
  assert.equal(parseExpiryDay("2026-1-01"), null);
  assert.equal(parseExpiryDay("not-a-day"), null);
});

test("daysUntil counts whole days from now to the expiry day, negative once past", () => {
  const expiry = parseExpiryDay("2026-12-01")!;
  assert.equal(daysUntil(expiry, NOON), 53);
  assert.equal(daysUntil(parseExpiryDay("2026-10-09")!, NOON), 0, "today is zero days away");
  assert.equal(daysUntil(parseExpiryDay("2026-10-08")!, NOON), -1, "yesterday is one day past");
});

test("the window opens exactly 14 days before the expiry, and a past day always warns", () => {
  assert.equal(TOKEN_EXPIRY_WARN_DAYS, 14);
  assert.equal(warns("2026-10-23", NOON), true, "14 days before warns");
  assert.equal(warns("2026-10-22", NOON), true, "13 days before warns");
  assert.equal(warns("2026-10-24", NOON), false, "15 days before is outside the window");
  assert.equal(warns("2026-10-09", NOON), true, "the day itself warns");
  assert.equal(warns("2026-09-01", NOON), true, "a past day warns");
  assert.equal(warns("not-a-day", NOON), false, "a day that is not a date never warns");
});

test("tokenExpiryWarnings returns the warning tokens soonest first, skipping far and invalid days", () => {
  const list = tokenExpiryWarnings({
    deploy: "2026-10-23", // 14 days: warns
    ops: "2026-10-10",    // 1 day: warns
    stale: "2026-09-20",  // past: warns
    far: "2026-11-30",    // 52 days: silent
    broken: "not-a-day",  // skipped
  }, NOON);
  assert.deepEqual(list.map((w) => w.name), ["stale", "ops", "deploy"]);
  assert.equal(list[0].daysLeft, -19);
  assert.equal(list[1].daysLeft, 1);
  assert.equal(list[2].daysLeft, 14);
});

test("formatTokenExpiryWarnings names each token and its date, and says nothing when none warns", () => {
  assert.deepEqual(formatTokenExpiryWarnings({
    deploy: "2026-10-23",
    ops: "2026-10-10",
    stale: "2026-09-20",
    far: "2026-11-30",
  }, NOON), [
    "Token expiries:",
    "  stale expired 19 days ago, on 2026-09-20",
    "  ops expires tomorrow, on 2026-10-10",
    "  deploy expires in 14 days, on 2026-10-23",
  ]);
  assert.deepEqual(formatTokenExpiryWarnings({ deploy: "2026-11-30" }, NOON), [], "nothing within the window");
  assert.deepEqual(formatTokenExpiryWarnings({}, NOON), []);
  // The singular forms, for a day and a single day ago.
  assert.deepEqual(formatTokenExpiryWarnings({ a: "2026-10-09", b: "2026-10-08" }, NOON), [
    "Token expiries:",
    "  b expired 1 day ago, on 2026-10-08",
    "  a expires today, on 2026-10-09",
  ]);
});
