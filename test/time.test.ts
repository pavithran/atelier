import { test } from "node:test";
import assert from "node:assert/strict";
import { clockTime, dayOf, setTimeZone, shortStamp, stamp, zoneLabel, zoneName } from "../src/time.ts";

test("times are shown in the owner's zone, with daylight saving, and in UTC when the zone is unset or unknown", () => {
  const summer = "2026-10-05T14:46:00Z", winter = "2026-12-05T14:46:00Z";
  assert.equal(setTimeZone("America/New_York"), "America/New_York");
  assert.equal(stamp(summer), "2026-10-05 10:46 EDT");
  assert.equal(clockTime(winter), "09:46 EST");
  assert.equal(shortStamp(summer), "10/05 10:46");
  assert.equal(dayOf("2026-10-05T02:00:00Z"), "2026-10-04", "the day is the owner's day, not UTC's");
  assert.equal(zoneName(summer), "EDT");
  assert.equal(setTimeZone("Not/AZone"), "UTC");
  assert.equal(stamp(summer), "2026-10-05 14:46 UTC");
  assert.equal(setTimeZone(undefined), "UTC");
  assert.equal(clockTime(summer), "14:46 UTC");
});

test("a legend names the zone, right in every season; each timestamp carries its own abbreviation", () => {
  setTimeZone("America/New_York");
  assert.equal(zoneLabel(), "New York time");
  assert.equal(stamp("2026-01-15T15:46:00Z"), "2026-01-15 10:46 EST");
  assert.equal(stamp("2026-07-15T14:46:00Z"), "2026-07-15 10:46 EDT");
  // Across the November change: 05:30 UTC is 01:30 EDT, 06:30 UTC is 01:30 EST.
  assert.equal(stamp("2026-11-01T05:30:00Z"), "2026-11-01 01:30 EDT");
  assert.equal(stamp("2026-11-01T06:30:00Z"), "2026-11-01 01:30 EST");
  setTimeZone("America/Argentina/Buenos_Aires");
  assert.equal(zoneLabel(), "Buenos Aires time");
  setTimeZone(undefined);
  assert.equal(zoneLabel(), "UTC");
});
