// A file that fakes Date to a time long past and restores it in a slow
// teardown, as test/today-routes.spec.ts does (FIXED_NOW). It leaves no handle,
// so the guard must let it exit.
import { test, after, mock } from "node:test";

mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-10T12:00:00Z") });
test("passes with Date faked", () => {});
after(async () => {
  await new Promise((ok) => setTimeout(ok, 1500));
  mock.timers.reset();
});
