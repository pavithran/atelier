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
// that ends the wait (abandoned, exit 4, naming it; blocked, exit 1), as a
// rejecting review ends `reviewed` (exit 1).
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
    if (gone) return { ok: false, text: `${id} is ${state}; it will not merge`, abandoned: state === "abandoned" };
    return null;
  }
  if (target === "submitted") {
    if (PAST_SUBMIT.has(state)) return { ok: true, text: `${id} is ${state}` };
    if (gone) return { ok: false, text: `${id} is ${state}; it will not be submitted`, abandoned: state === "abandoned" };
    return null;
  }
  if (gone) return { ok: false, text: `${id} is ${state}; it will not be reviewed`, abandoned: state === "abandoned" };
  // Each reviewer's latest standing review: a rejection a later approval
  // superseded does not count (rules.ts latestReviews).
  const here = latestReviews(d.reviews ?? [], bindingOf(d.item));
  const rejected = here.filter((r) => !r.approve);
  if (rejected.length) return { ok: false, text: `${id} was rejected by ${rejected.map((r) => r.by).join(", ")} at ${short(d.item.head)}` };
  if (here.length) return { ok: true, text: `${id} was approved by ${here.map((r) => r.by).join(", ")} at ${short(d.item.head)}` };
  if (PAST_REVIEW.has(state)) return { ok: true, text: `${id} is ${state}` };
  return null;
}

// The exit codes `atelier wait` ends with: the condition was met, it cannot
// be met (a rejection, a block, a name nobody answers to), the wait gave up
// at --timeout, a task it named was abandoned (the line names it), or the
// server could not be read.
export const EXIT = { met: 0, failed: 1, timedOut: 3, abandoned: 4, unread: 5 };

// Reads until judge answers, the deadline passes or a read keeps failing.
// `read(signal)` returns the detail and honours cancellation. `sleep` and
// `now` default to the real ones. A read the server cannot answer (code 4:
// refused connection, a restart) is tried again, up to `retries` times in a
// row, so a wait rides through a server restart and reads the record again
// once it is back; a refusal or a missing task is the outcome at once. The
// result carries the exit code (EXIT).
export function waitFor(target, read, opts = {}) {
  return pollUntil((d, first) => judge(target, d, first), (d) => `${d.item.id} is still ${d.item.state}; gave up waiting for ${target}`, target, read, opts);
}

// The same loop for a condition on the situation read (judgeCondition).
export function waitUntil(condition, read, opts = {}) {
  return pollUntil((s, first) => judgeCondition(condition, s, first), (s) => stillText(condition, s), describeCondition(condition), read, opts);
}

async function pollUntil(judgeOf, still, label, read, { intervalMs = 5000, timeoutMs = Infinity, retries = 60, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {}) {
  const deadline = now() + timeoutMs;
  // Never sleeps past the deadline.
  const nap = () => sleep(Math.max(0, Math.min(intervalMs, deadline - now())));
  let first = null, failed = 0, last = null, lastError = null;
  for (;;) {
    // Once a read has been made, the deadline is checked before the next one.
    if (last && now() >= deadline) return { ok: false, code: EXIT.timedOut, text: still(last) };
    if (lastError && now() >= deadline) return { ok: false, code: EXIT.timedOut, text: `gave up waiting for ${label}; the last read failed: ${lastError.message}` };
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
      if (controller.signal.aborted || now() >= deadline) return { ok: false, code: EXIT.timedOut, text: `gave up waiting for ${label}; the last read failed: ${error.message}` };
      // Only a server that cannot be reached (code 4) is worth another try;
      // a refusal or a missing task will not change.
      if (error.code !== undefined && error.code !== 4) return { ok: false, code: EXIT.unread, text: `could not be read: ${error.message}` };
      if (++failed > retries) return { ok: false, code: EXIT.unread, text: `could not be read: ${error.message}` };
      lastError = error;
      await nap();
      continue;
    }
    finally { clearTimeout(timer); }
    if (now() >= deadline) return { ok: false, code: EXIT.timedOut, text: `gave up waiting for ${label}; the read finished after the deadline` };
    first ??= d; last = d;
    const done = judgeOf(d, first);
    if (done) return { ...done, code: done.ok ? EXIT.met : done.abandoned ? EXIT.abandoned : EXIT.failed };
    if (now() >= deadline) return { ok: false, code: EXIT.timedOut, text: still(d) };
    await nap();
  }
}

// ── conditions on the situation read (G3) ─────────────────────────────────
//
// A condition, as `atelier wait` builds it from its flags:
//   { kind: "tasks", mode: "all" | "any", ids, target }
//       target: merged, submitted, accepted, or a stage (STAGES): every task
//       (all) or one of them (any) has reached it; a stage is reached once
//       the task's recorded stage is that one or a later one.
//   { kind: "answered", mode: "all" | "any", ids }
//       every task (all) or one of them (any) has no review request open or
//       claimed, as the situation read lists them.
//   { kind: "silent", runner, minutes }
//       the runner's last poll is at least that old, or it never polled.
// It is judged on GET /projects/P/situation?tasks=IDS (src/situation.ts),
// which lists the named tasks whatever their state. A task that is
// abandoned, while the condition is not met, ends the wait with EXIT.abandoned
// naming it; a blocked one with EXIT.failed naming the block.
export const STAGE_ORDER = ["filed", "agreed", "queued", "building", "built", "checked", "reviewed", "landable", "landed", "shipped"];
export const STATE_TARGETS = ["merged", "submitted", "accepted"];
const PAST = { submitted: new Set(["submitted", "accepted", "integrated", "merged"]), accepted: new Set(["accepted", "integrated", "merged"]), merged: new Set(["merged"]) };

function reached(task, target) {
  if (PAST[target]) return PAST[target].has(task.state);
  if (task.state === "merged") return STAGE_ORDER.indexOf(target) <= STAGE_ORDER.indexOf("landed") || task.stage === target;
  const at = STAGE_ORDER.indexOf(task.stage ?? ""), want = STAGE_ORDER.indexOf(target);
  return at >= 0 && want >= 0 && at >= want;
}

export function describeCondition(c) {
  if (c.kind === "tasks") return `${c.ids.length > 1 ? `${c.mode} of ${c.ids.join(", ")}` : c.ids[0]} ${c.target}`;
  if (c.kind === "answered") return `the review requests of ${c.mode === "any" && c.ids.length > 1 ? "one of " : ""}${c.ids.join(", ")} to be answered`;
  return `${c.runner} silent for ${c.minutes} minutes`;
}

function stillText(c, s) {
  if (c.kind === "tasks" || c.kind === "answered") {
    const tasks = c.ids.map((id) => s.tasks.find((t) => t.id === id)).filter(Boolean);
    return `${tasks.map((t) => `${t.id} is ${t.state}${t.stage ? ` (${t.stage})` : ""}`).join(", ")}; gave up waiting for ${describeCondition(c)}`;
  }
  const r = s.runners.find((x) => x.runner === c.runner);
  return `${c.runner} last polled ${r?.silentMs !== null && r?.silentMs !== undefined ? `${Math.floor(r.silentMs / 60_000)} minutes ago` : "at an unknown time"}; gave up waiting for ${describeCondition(c)}`;
}

// null while the wait goes on, else { ok, text, abandoned? }.
export function judgeCondition(c, s, first = s) {
  if (c.kind === "silent") {
    const r = s.runners.find((x) => x.runner === c.runner);
    if (!r) return { ok: false, text: `no runner named ${c.runner} serves ${s.project}, by an offer or a token; atelier situation lists the runners` };
    if (r.never) return { ok: true, text: `${c.runner} has never polled` };
    if (r.silentMs !== null && r.silentMs >= c.minutes * 60_000) return { ok: true, text: `${c.runner} has been silent ${Math.floor(r.silentMs / 60_000)} minutes (last poll ${r.lastPoll})` };
    return null;
  }
  const tasks = c.ids.map((id) => ({ id, task: s.tasks.find((t) => t.id === id) }));
  const missing = tasks.filter((t) => !t.task).map((t) => t.id);
  if (missing.length) return { ok: false, text: `no task ${missing.join(", ")} in ${s.project}; atelier ls --all lists them` };
  if (c.kind === "answered") {
    const open = (id) => s.reviewRequests.filter((r) => r.task === id);
    const waiting = c.ids.filter((id) => open(id).length);
    const answered = c.ids.filter((id) => !open(id).length);
    if (c.mode === "any" ? answered.length > 0 : !waiting.length) {
      const ids = c.mode === "any" ? answered : c.ids;
      const asked = ids.filter((id) => first.reviewRequests.some((r) => r.task === id));
      return { ok: true, text: asked.length ? `the review requests of ${asked.join(", ")} are answered` : `${ids.join(", ")} ${ids.length === 1 ? "has" : "have"} no open review request` };
    }
    const dead = tasks.find((t) => t.task.state === "abandoned");
    if (dead) return { ok: false, abandoned: true, text: `${dead.id} is abandoned; its review request will not be answered` };
    return null;
  }
  const done = tasks.filter((t) => reached(t.task, c.target));
  if (c.mode === "any" ? done.length > 0 : done.length === tasks.length) {
    return { ok: true, text: c.mode === "any" && tasks.length > 1 ? `${done.map((t) => t.id).join(", ")} ${c.target === "merged" ? "merged" : `reached ${c.target}`}` : `${tasks.map((t) => t.id).join(", ")} ${c.target === "merged" ? "merged" : `reached ${c.target}`}` };
  }
  const dead = tasks.find((t) => t.task.state === "abandoned");
  if (dead) return { ok: false, abandoned: true, text: `${dead.id} is abandoned; it will not reach ${c.target}` };
  const blocked = tasks.find((t) => t.task.state === "blocked");
  if (blocked) return { ok: false, text: `${blocked.id} is blocked; it will not reach ${c.target} until it is unblocked (atelier situation says whose words lift it)` };
  return null;
}
