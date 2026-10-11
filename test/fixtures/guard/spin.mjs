// A test whose poll loop never stops and never yields to the timers, as the
// runner tests' did before t419: it starts a sleeper, writes its own pid and
// the sleeper's to GUARD_PID_FILE, then spins on microtasks.
import { test } from "node:test";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

test("spins", { timeout: 1000 }, async () => {
  const child = spawn("sleep", ["300"], { stdio: "ignore" });
  writeFileSync(process.env.GUARD_PID_FILE, `${process.pid} ${child.pid}`);
  for (;;) await null;
});
