// What a run's local log holds (runFacts, cli/runner.mjs). A build whose
// harness timed out or exited nonzero adds the last lines of the harness's
// stdout and stderr and the commands the progress record saw start, which
// are what the run did; any other run keeps the text it always had.

export const HARNESS_LOG_LINES = 200;

const lastLines = (text, count) =>
  String(text ?? "").replace(/\r/g, "").split("\n").filter((l) => l.trim()).slice(-count);

// The harness's last output, taken where it ends: the last 200 non-empty
// lines of each stream. Null for a harness that succeeded or never ran.
export function harnessTailOf(result) {
  if (!result || (!result.timedOut && result.code === 0)) return null;
  return { stdout: lastLines(result.output, HARNESS_LOG_LINES), stderr: lastLines(result.stderr, HARNESS_LOG_LINES) };
}

// The commands the progress record saw start, oldest first, one per line:
// when the runner saw it start, the tool and the program (never arguments).
export const commandLines = (trail) =>
  (Array.isArray(trail) ? trail : []).map((c) => [c.at, c.name, c.summary].filter(Boolean).join(" "));

// The lines of a run's log text, from its state.
export function logTextOf(state) {
  const tail = state.harnessTail;
  const parts = [state.reason ?? "", state.detail ?? "", tail ? "" : state.harnessExit?.stderr ?? "", state.output ?? ""];
  if (tail) {
    parts.push(`stdout (last ${HARNESS_LOG_LINES} lines):`, ...(tail.stdout.length ? tail.stdout : ["(none)"]));
    parts.push(`stderr (last ${HARNESS_LOG_LINES} lines):`, ...(tail.stderr.length ? tail.stderr : ["(none)"]));
    const commands = commandLines(state.commandTrail);
    parts.push(`commands the progress record saw start (${commands.length}):`, ...(commands.length ? commands : ["(none)"]));
  }
  return parts.filter(Boolean).join("\n");
}
