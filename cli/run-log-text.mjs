// What a run's local log holds (runFacts, cli/runner.mjs). A build whose
// harness timed out or exited nonzero adds the last lines of the harness's
// stdout and stderr and the commands the progress record saw start, which
// are what the run did; any other run keeps the text it always had.

export const HARNESS_LOG_LINES = 200;

const lastLines = (text, count) =>
  String(text ?? "").replace(/\r/g, "").split("\n").filter((l) => l.trim()).slice(-count);

const LINE_MAX = 64 * 1024;

// A ring of the last 200 non-empty lines of one stream, fed chunks as they
// arrive, apart from the byte buffer the executor keeps. A line is whole when
// its newline arrives, or at `lines()` for the one the stream ended on.
export function lineRing(count = HARNESS_LOG_LINES) {
  const ring = [];
  let open = "";
  const push = (line) => { const text = line.replace(/\r/g, ""); if (text.trim()) { ring.push(text.slice(0, LINE_MAX)); if (ring.length > count) ring.shift(); } };
  return {
    write(chunk) {
      const parts = (open + chunk).split("\n");
      open = parts.pop().slice(0, LINE_MAX);
      for (const part of parts) push(part);
    },
    lines() { const out = [...ring]; if (open.replace(/\r/g, "").trim()) out.push(open.replace(/\r/g, "")); return out.slice(-count); },
  };
}

// The harness's last output, taken where it ends: the last 200 non-empty
// lines of each stream, from the executor's rings when it kept them. Null for
// a harness that succeeded or never ran.
export function harnessTailOf(result) {
  if (!result || (!result.timedOut && result.code === 0)) return null;
  const rings = result.tails;
  return {
    stdout: rings?.stdout ?? lastLines(result.output, HARNESS_LOG_LINES),
    stderr: rings?.stderr ?? lastLines(result.stderr, HARNESS_LOG_LINES),
  };
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
