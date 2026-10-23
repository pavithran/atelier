// The runner's bookkeeping for a harness that ends (t363), in one place: every
// site that decides what a failed harness left behind asks here, so the
// reason, the starting head, the claim and the marker cannot drift apart.

const short = (head) => String(head).slice(0, 8);

// The reason a harness that did not succeed is failed with. A harness that
// moved the head says so and carries the head, which keeps the claim; a
// harness killed by a signal has no exit code (null) and is a failure too.
export function failureReason({ code, timedOut, before, head }) {
  const why = timedOut ? "harness timed out" : `harness exited ${code}`;
  if (head && head !== before) return { reason: `${why} after the head moved to ${short(head)}`, head };
  return { reason: why };
}

// The recovery obligation is one per-task fact: a harness run failed in this
// workspace and no harness run has since succeeded. Any failure marker for the
// task, readable or not, whoever wrote it, at whatever head, means the harness
// must run again before the runner finishes or submits anything. The marker's
// head and start are information; nothing is matched against them.
//
// After this many failed reruns the runner stops rerunning, keeps the claim
// and says the task needs the developer, so a broken environment or a marker
// that cannot be cleared does not loop forever.
export const MAX_HARNESS_RERUNS = 3;

// The last 20 non-empty lines of stderr (a trailing newline is no line). No
// line is cut; only the whole is bounded, to the last 64 KB.
export const STDERR_TAIL_LIMIT = 65536;
export const stderrTail = (stderr) => {
  const text = String(stderr).replace(/\r/g, "").split("\n").filter((l) => l.trim()).slice(-20).join("\n");
  return text.length > STDERR_TAIL_LIMIT ? text.slice(-STDERR_TAIL_LIMIT) : text;
};

// How a harness run ended, as a structured fact set where the run ends: the
// outcome reported to the server reads this, never the human-readable reason.
export const harnessExitOf = (result) =>
  result.timedOut ? { kind: "timed-out" } : result.code == null ? { kind: "signalled" } : { kind: "exited", code: result.code, ...(result.stderr ? { stderr: stderrTail(result.stderr) } : {}) };

// The structured exit of a run that failed, or null for one that passed or
// never ran: the one place every harness site (build, fast build, resolver,
// review, criteria review, prereview) gets the fact runOutcome reads.
export const failedExitOf = (result) =>
  result && (result.timedOut || result.code !== 0) ? harnessExitOf(result) : null;

// What a harness (or the absence of one) left, as a pure function of:
//   ran         a harness ran
//   marker      the failure marker for the task: null, a marker, or
//               { invalid: true } for one that cannot be read; any of them is
//               an obligation, and only its `from`, when it has one, is used
//   head, before    the workspace head after and before the harness
//   itemHead, itemBase   the task's recorded head and its base
//   code, timedOut  the exit; code null is a signal
//   kind        "task" or "part"
//   resumed     the run finished a dead run's commit without a harness
//   pushedComplete  the head is the task's pushed head, ahead of its base
//   mergesBlock     a merge conflicted or was skipped
// It returns
//   from       what the run moved from: the starting point the reason names
//   markerFrom the start the marker records (information)
//   reason, headMoved   the failure's reason, and whether it names a moved head
//   keepClaim  the claim stays because commits exist that nothing vouched for
//   release    a part whose harness failed after commits goes back to its plan
export function harnessOutcome(i) {
  const { head, before } = i;
  const failed = !!i.ran && (!!i.timedOut || i.code !== 0);
  // A marker with no start of its own names the task's base, else its recorded
  // head, as the start.
  const startOf = i.marker ? (i.marker.from || i.itemBase || i.itemHead || null) : null;
  const markerFrom = startOf && startOf !== head ? startOf : null;
  const sameHead = !i.resumed && head === before;
  const rerunsClean = sameHead && !failed && i.ran && i.marker && !i.pushedComplete && !i.mergesBlock;
  const from = i.resumed ? i.itemHead
    : (sameHead && failed && markerFrom) || (rerunsClean && markerFrom)
      || (sameHead && i.pushedComplete ? i.itemBase : before);
  const markerStart = markerFrom ?? from;
  if (!failed) return { from, markerFrom: markerStart, reason: null, headMoved: false, keepClaim: !!i.resumed, release: false };
  const { reason } = failureReason({ code: i.code, timedOut: i.timedOut, before: from, head });
  const headMoved = !!head && head !== from;
  const release = i.kind === "part" && headMoved;
  return { from, markerFrom: markerStart, reason, headMoved, keepClaim: !release && (headMoved || !!i.marker), release };
}
