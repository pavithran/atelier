import { test } from "node:test";
import assert from "node:assert/strict";
import { clockTime, dayOf, setTimeZone, shortStamp, stamp, zoneName } from "../src/time.ts";

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
