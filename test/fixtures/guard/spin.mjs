// A test whose poll loop never stops and never yields to the timers, as the
// runner tests' did before t419: it writes its pid, then spins on microtasks.
import { test } from "node:test";
import { writeFileSync } from "node:fs";

test("spins", { timeout: 1000 }, async () => {
  writeFileSync(process.env.GUARD_PID_FILE, String(process.pid));
  for (;;) await null;
});
