// What a run's local log holds (runFacts, cli/runner.mjs). A build whose
// harness timed out or exited nonzero adds the last lines of the harness's
// stdout and stderr and the commands the progress record saw start, which
// are what the run did; any other run keeps the text it always had.

export const HARNESS_LOG_LINES = 200;

export const LINE_MAX = 64 * 1024;
const HALF = LINE_MAX / 2;

// A line of at most LINE_MAX characters is kept whole. A longer one keeps its
// first HALF and last HALF characters around a marker giving the count left out,
// so an error at its start and the text at its end both survive.
const lastLines = (text, count) =>
  String(text ?? "").replace(/\r/g, "").split("\n").filter((l) => l.trim()).slice(-count).map(kept);

const joined = (head, tail, cut) => (cut ? `${head} [cut ${cut} characters] ${tail}` : head + tail);
const kept = (text) =>
  text.length <= LINE_MAX ? text : joined(text.slice(0, HALF), text.slice(-HALF), text.length - LINE_MAX);

// A ring of the last 200 non-empty lines of one stream, fed chunks as they
// arrive, apart from the byte buffer the executor keeps. The unfinished line
// is held as its first HALF characters (`head`), the last HALF seen after
// them (`tail`) and the count dropped between (`cut`), never whole.
export function lineRing(count = HARNESS_LOG_LINES) {
  const ring = [];
  let head = "";
  let tail = "";
  let cut = 0;
  const add = (text) => {
    const room = HALF - head.length;
    if (room > 0) { head += text.slice(0, room); text = text.slice(room); }
    tail += text;
    if (tail.length > HALF) { cut += tail.length - HALF; tail = tail.slice(-HALF); }
  };
  const finish = () => {
    const text = joined(head, tail, cut);
    head = ""; tail = ""; cut = 0;
    return text;
  };
  const push = (line) => { if (line.trim()) { ring.push(line); if (ring.length > count) ring.shift(); } };
  return {
    write(chunk) {
      const parts = String(chunk).replace(/\r/g, "").split("\n");
      const last = parts.pop();
      for (const part of parts) { add(part); push(finish()); }
      add(last);
    },
    lines() {
      const out = [...ring];
      if ((head + tail).trim()) out.push(joined(head, tail, cut));
      return out.slice(-count);
    },
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
