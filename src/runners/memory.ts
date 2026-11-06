// What a runner remembers of the tasks it passes by (G5), sent with every poll
// and kept with its offer, so a restarted runner reads it back from the
// server (GET /runners/me) and the owner's listing shows it. Only the known
// fields are kept, each bounded, so a runner cannot store more than a status
// line shows. No same-exit count is among them: that is the server's alone
// (the Ledger's same_exits and a review request's stop). The keys are the runner's own (cli/runner.mjs: refusedKey,
// failureKey, taskKey); the server only holds them.

export interface RunnerMemory {
  refused: string[];                 // claims refused or tasks skipped, by refusedKey
  gaveUp: string[];                  // tasks given up and released, by taskKey
  failures: { key: string; count: number }[];        // failed runs under a dispatch, by failureKey
  infrastructure: { key: string; count: number }[];  // infrastructure failures in a row, by failureKey
  skipHeads: { key: string; heads: (string | null)[] }[];  // the heads a skip began at (noteSkipHeads)
  reasons: { task: string; why: string }[];  // the last reason each task is passed by, in words
  backoff: { key: string; count: number }[];        // failed runs in a row waiting out a backoff, by backoffKey
  pauses: ProviderPause[];                           // provider limits this runner met; the server shares them
}

// A provider's usage limit: every model of the harness is paused until the
// reset, on every runner on the account (G5).
export interface ProviderPause { harness: string; reason: string; resetAt: string; since: string; fallback: boolean }

export const MEMORY_MAX = 200;
const KEY_MAX = 600;
const key = (v: unknown): string | null => typeof v === "string" && v && v.length <= KEY_MAX ? v : null;
const count = (v: unknown): number | null => typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 1_000_000 ? v : null;
const list = (v: unknown): unknown[] => Array.isArray(v) ? v.slice(-MEMORY_MAX) : [];

export function parseMemory(raw: unknown): RunnerMemory | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const entries = <T extends object>(v: unknown, entry: (x: Record<string, unknown>) => T | null): ({ key: string } & T)[] =>
    list(v).flatMap((e) => {
      const x = (e ?? {}) as Record<string, unknown>, k = key(x.key), rest = k !== null ? entry(x) : null;
      return k !== null && rest !== null ? [{ key: k, ...rest }] : [];
    });
  const counted = (x: Record<string, unknown>) => { const n = count(x.count); return n === null ? null : { count: n }; };
  const memory: RunnerMemory = {
    refused: list(r.refused).flatMap((k) => key(k) ? [k as string] : []),
    gaveUp: list(r.gaveUp).flatMap((k) => key(k) ? [k as string] : []),
    failures: entries(r.failures, counted),
    infrastructure: entries(r.infrastructure, counted),
    skipHeads: entries(r.skipHeads, (x) => Array.isArray(x.heads) ? { heads: x.heads.slice(0, 16).flatMap((h) => typeof h === "string" && h.length <= 64 ? [h] : h === null ? [null] : []) } : null),
    backoff: entries(r.backoff, counted),
    pauses: list(r.pauses).flatMap((e) => {
      const x = (e ?? {}) as Record<string, unknown>;
      return typeof x.harness === "string" && x.harness.length <= 64 && typeof x.resetAt === "string" && Number.isFinite(Date.parse(x.resetAt))
        ? [{ harness: x.harness, reason: typeof x.reason === "string" ? x.reason.slice(0, 300) : "", resetAt: new Date(x.resetAt).toISOString(), since: typeof x.since === "string" && Number.isFinite(Date.parse(x.since)) ? new Date(x.since).toISOString() : new Date(x.resetAt).toISOString(), fallback: x.fallback === true }]
        : [];
    }),
    reasons: list(r.reasons).flatMap((e) => {
      const x = (e ?? {}) as { task?: unknown; why?: unknown };
      return typeof x.task === "string" && typeof x.why === "string" ? [{ task: x.task.slice(0, 120), why: x.why.slice(0, 300) }] : [];
    }),
  };
  return memory;
}

// The task a runner's key names, "project/id": every key is a JSON list
// starting with the project and the task id (cli/runner.mjs).
export function taskOfKey(key: string): string | null {
  try {
    const [project, id] = JSON.parse(key);
    return typeof project === "string" && typeof id === "string" ? `${project}/${id}` : null;
  } catch { return null; }
}

// What one runner's memory holds of one task ("project/id"): whether any
// entry holds it — the entries atelier forget-skip clears — and the last
// reason it is passed by, in words, when the memory says one. Null when
// nothing is remembered of the task.
export function rememberedTask(memory: RunnerMemory, task: string): { why: string | null } | null {
  const keyed = (keys: readonly string[]) => keys.some((k) => taskOfKey(k) === task);
  const held = (list: readonly { key: string }[]) => list.some((e) => taskOfKey(e.key) === task);
  const reasons = memory.reasons.filter((r) => r.task === task);
  return keyed(memory.refused) || keyed(memory.gaveUp) || held(memory.failures) || held(memory.infrastructure) || held(memory.skipHeads) || held(memory.backoff) || reasons.length
    ? { why: reasons.map((r) => r.why).at(-1) ?? null }
    : null;
}

// The memory without the entries of the named tasks ("project/id"), and how
// many entries went (atelier runner forget-skip, G5).
export function dropTasks(memory: RunnerMemory, tasks: readonly string[]): { memory: RunnerMemory; removed: number } {
  let removed = 0;
  const keep = <T extends { key: string }>(list: T[]): T[] => list.filter((e) => {
    const gone = tasks.includes(taskOfKey(e.key) ?? "");
    if (gone) removed++;
    return !gone;
  });
  const keys = (list: string[]) => keep(list.map((key) => ({ key }))).map((e) => e.key);
  const cut: RunnerMemory = {
    ...memory,
    refused: keys(memory.refused), gaveUp: keys(memory.gaveUp),
    failures: keep(memory.failures), infrastructure: keep(memory.infrastructure),
    skipHeads: keep(memory.skipHeads), backoff: keep(memory.backoff),
    reasons: memory.reasons.filter((r) => !tasks.includes(r.task)),
  };
  return { removed, memory: cut };
}
