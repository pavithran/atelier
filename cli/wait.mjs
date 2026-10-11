import { bindingOf, latestReviews } from "../src/rules.ts";

// `atelier wait ID`: block until a task reaches a state, or fails. Pure
// judgement, plus a loop whose reads and clock the caller supplies, so every
// outcome is testable without a server or a real wait.
//
// The detail read (GET the item) is { item, reviews }. What is waited for:
//   merged      the task merged
//   submitted   the task was submitted (it may already be further on)
//   reviewed    a review is recorded at the task's current head, or the
//               task is past review
//   any-change  the task's state, head, owner or review count differs from
//               the first read
// A task that is abandoned or blocked can reach none of the first three, so
// that is a failure, as is a rejecting review for `reviewed`.
export const WAIT_FOR = ["merged", "submitted", "reviewed", "any-change"];

const PAST_SUBMIT = new Set(["submitted", "accepted", "integrated", "merged"]);
const PAST_REVIEW = new Set(["accepted", "integrated", "merged"]);

const short = (sha) => (sha ? String(sha).slice(0, 8) : "no head");

// The fields `any-change` compares.
const fingerprint = (d) => JSON.stringify([d.item.state, d.item.head, d.item.owner, d.item.runner ?? null, (d.reviews ?? []).length]);

// null while the wait goes on, else { ok, text }.
export function judge(target, d, first = d) {
  const { id, state } = d.item;
  const gone = state === "abandoned" || state === "blocked";
  if (target === "any-change") {
    if (fingerprint(d) === fingerprint(first)) return null;
    return { ok: true, text: `${id} changed: ${first.item.state} -> ${state}${d.item.head !== first.item.head ? `, head ${short(d.item.head)}` : ""}` };
  }
  if (target === "merged") {
    if (state === "merged") return { ok: true, text: `${id} merged` };
    if (gone) return { ok: false, text: `${id} is ${state}; it will not merge` };
    return null;
  }
  if (target === "submitted") {
    if (PAST_SUBMIT.has(state)) return { ok: true, text: `${id} is ${state}` };
    if (gone) return { ok: false, text: `${id} is ${state}; it will not be submitted` };
    return null;
  }
  if (gone) return { ok: false, text: `${id} is ${state}; it will not be reviewed` };
  // Each reviewer's latest standing review: a rejection a later approval
  // superseded does not count (rules.ts latestReviews).
  const here = latestReviews(d.reviews ?? [], bindingOf(d.item));
  const rejected = here.filter((r) => !r.approve);
  if (rejected.length) return { ok: false, text: `${id} was rejected by ${rejected.map((r) => r.by).join(", ")} at ${short(d.item.head)}` };
  if (here.length) return { ok: true, text: `${id} was approved by ${here.map((r) => r.by).join(", ")} at ${short(d.item.head)}` };
  if (PAST_REVIEW.has(state)) return { ok: true, text: `${id} is ${state}` };
  return null;
}

// Reads until judge answers, the deadline passes or a read keeps failing.
// `read(signal)` returns the detail and honours cancellation. `sleep` and
// `now` default to the real ones. A read that throws is tried again up to `retries` times in a row (a server
// restart is not the task's failure), then the error is the outcome. The
// result carries the exit code: 0 reached, 1 failed, 3 timed out, 4 unread.
export async function waitFor(target, read, { intervalMs = 5000, timeoutMs = Infinity, retries = 5, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {}) {
  const deadline = now() + timeoutMs;
  // Never sleeps past the deadline.
  const nap = () => sleep(Math.max(0, Math.min(intervalMs, deadline - now())));
  let first = null, failed = 0, last = null, lastError = null;
  for (;;) {
    // Once a read has been made, the deadline is checked before the next one.
    if (last && now() >= deadline) return { ok: false, code: 3, text: `${last.item.id} is still ${last.item.state}; gave up waiting for ${target}` };
    if (lastError && now() >= deadline) return { ok: false, code: 3, text: `gave up waiting for ${target}; the last read failed: ${lastError.message}` };
    let d, timer;
    const controller = new AbortController();
    try {
      const expired = new Promise((_, reject) => {
        const arm = () => {
          timer = setTimeout(() => {
            if (now() < deadline) return arm();
            controller.abort();
            reject(new Error("read exceeded the wait deadline"));
          }, Math.max(0, Math.min(2 ** 31 - 1, deadline - now())));
        };
        if (Number.isFinite(deadline)) arm();
      });
      d = await Promise.race([read(controller.signal), expired]);
      failed = 0; lastError = null;
    }
    catch (error) {
      if (controller.signal.aborted || now() >= deadline) return { ok: false, code: 3, text: `gave up waiting for ${target}; the last read failed: ${error.message}` };
      // Only a server that cannot be reached (code 4) is worth another try;
      // a refusal or a missing task will not change.
      if (error.code !== undefined && error.code !== 4) return { ok: false, code: 4, text: `the task could not be read: ${error.message}` };
      if (++failed > retries) return { ok: false, code: 4, text: `the task could not be read: ${error.message}` };
      lastError = error;
      await nap();
      continue;
    }
    finally { clearTimeout(timer); }
    if (now() >= deadline) return { ok: false, code: 3, text: `gave up waiting for ${target}; the read finished after the deadline` };
    first ??= d; last = d;
    const done = judge(target, d, first);
    if (done) return { ...done, code: done.ok ? 0 : 1 };
    if (now() >= deadline) return { ok: false, code: 3, text: `${d.item.id} is still ${d.item.state}; gave up waiting for ${target}` };
    await nap();
  }
}
