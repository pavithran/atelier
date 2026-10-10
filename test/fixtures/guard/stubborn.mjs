// A sync child that ignores SIGTERM, with a sleeper of its own. Given
// GUARD_KILL_SIGNAL, the call asks for that signal at its timeout; the
// child's pid and the sleeper's are written to GUARD_PID_FILE.
import { test } from "node:test";
import { spawnSync } from "node:child_process";

const script = `trap "" TERM; sleep 300 > /dev/null 2>&1 & echo "$$ $!" > "$GUARD_PID_FILE"; while :; do sleep 1; done`;

test("a sync child that ignores SIGTERM", () => {
  const killSignal = process.env.GUARD_KILL_SIGNAL;
  spawnSync("/bin/sh", ["-c", script], { timeout: 200, ...(killSignal ? { killSignal } : {}) });
});
