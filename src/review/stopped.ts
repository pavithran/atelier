// A review request stopped at a head (t238, and the size refusals of t230).
// Releasing a request withdraws it and opens a successor under a new number,
// so anything a runner remembers by request number or in its own memory is
// lost at the release, at a restart, and to every other runner. The server
// keeps the stop on the request instead: "review stopped at head H, for
// reason R, after N tries", carried from each request to its successor at the
// same head and read by the runners, the stuck report and the landing from the
// live request. A new request asked by the developer, or a new head, starts
// clean, which is how the developer's decision lifts it.

export const STOP_LIMIT = 2;

export interface ReviewStop {
  head: string;
  reason: string;
  count: number;
  last: string;
  at: string;
}

// Releases that count towards a stop: a harness that timed out, and one that
// ended without a verdict. A provider's usage limit is the harness's, an
// interrupt is the runner's own, and a merge commit or baseline that could not
// be read has its own count in the runner; none of them stops the review. A
// release that gives no reason is not a runner's, which always gives one.
export const STOP_TIMEOUT = "timeout";
export const STOP_NO_VERDICT = "no-verdict";

export function stopReasonOf(note: string): string | null {
  if (!note.trim() || /usage limit until/i.test(note) || /^interrupted\b/i.test(note) || /merge commit/i.test(note)) return null;
  return /timed out/i.test(note) ? STOP_TIMEOUT : STOP_NO_VERDICT;
}

export function parseStop(raw: unknown): ReviewStop | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const s = JSON.parse(raw) as Partial<ReviewStop>;
    return typeof s.head === "string" && typeof s.reason === "string" && Number.isInteger(s.count) ? { head: s.head, reason: s.reason, count: s.count!, last: String(s.last ?? ""), at: String(s.at ?? "") } : null;
  } catch { return null; }
}

// The stop a successor at `head` carries after a release for `reason`: the
// count goes on where the earlier stop was at the same head, whichever reason
// it was for, and starts at one otherwise; the reason kept is the last one. A
// null reason changes nothing.
export function stopAfter(prev: ReviewStop | null, head: string, reason: string | null, note: string, at: string): ReviewStop | null {
  const kept = prev && prev.head === head ? prev : null;
  if (!reason) return kept;
  const count = kept ? kept.count + 1 : 1;
  return { head, reason, count, last: note.replace(/\s+/g, " ").trim().slice(0, 300), at };
}

export const stopped = (stop: ReviewStop | null | undefined): stop is ReviewStop => !!stop && stop.count >= STOP_LIMIT;

// What the stuck report and the landing say, with the decision it needs.
// A merged task's request is its post-merge review (t331), which stays owed
// until a verdict stands, so the text says it is owed and names the task.
// atelier status names it through the fast-mode line (statusModeLine).
export function stopText(item: string, stop: ReviewStop, postMerge = false): string {
  const why = stop.reason === STOP_TIMEOUT ? "the harness timed out" : stop.reason === STOP_NO_VERDICT ? "it ended without a verdict" : stop.reason;
  if (postMerge) return `the post-merge review of ${item} at ${stop.head.slice(0, 8)} is owed: it stopped after ${stop.count} releases (${why}; last: ${stop.last || "no reason"}); ask another reviewer with atelier review-request ${item} --reviewer H/M, or record the developer's own verdict (atelier review ${item} --approve or --reject, as the developer)`;
  return `the review of ${item} at ${stop.head.slice(0, 8)} stopped after ${stop.count} releases (${why}; last: ${stop.last || "no reason"}); it needs the developer to decide: narrow the criteria, move the findings to a task, or override with the developer's word (atelier review ${item} --approve or --reject, as the developer)`;
}
