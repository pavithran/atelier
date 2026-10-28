// What a runner remembers of the tasks it passes by (G5), sent with every poll
// and kept with its offer, so a restarted runner reads it back from the
// server (GET /runners/me) and the owner's listing shows it. Only the known
// fields are kept, each bounded, so a runner cannot store more than a status
// line shows. The keys are the runner's own (cli/runner.mjs: refusedKey,
// failureKey, taskKey); the server only holds them.

export interface RunnerMemory {
  refused: string[];                 // claims refused or tasks skipped, by refusedKey
  gaveUp: string[];                  // tasks given up and released, by taskKey
  failures: { key: string; count: number }[];        // failed runs under a dispatch, by failureKey
  infrastructure: { key: string; count: number }[];  // infrastructure failures in a row, by failureKey
  sameExits: { key: string; count: number; signature: string; exit: Record<string, string | number | null> }[];
  skipHeads: { key: string; heads: (string | null)[] }[];  // the heads a skip began at (noteSkipHeads)
  reasons: { task: string; why: string }[];  // the last reason each task is passed by, in words
}

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
    sameExits: entries(r.sameExits, (x) => {
      const n = count(x.count);
      if (n === null || typeof x.signature !== "string" || !x.exit || typeof x.exit !== "object") return null;
      const exit: Record<string, string | number | null> = {};
      for (const [name, v] of Object.entries(x.exit as Record<string, unknown>).slice(0, 8)) {
        if (typeof v === "string") exit[name.slice(0, 32)] = v.slice(0, 1500);
        else if (typeof v === "number" || v === null) exit[name.slice(0, 32)] = v;
      }
      return { count: n, signature: x.signature.slice(0, 1500), exit };
    }),
    skipHeads: entries(r.skipHeads, (x) => Array.isArray(x.heads) ? { heads: x.heads.slice(0, 16).flatMap((h) => typeof h === "string" && h.length <= 64 ? [h] : h === null ? [null] : []) } : null),
    reasons: list(r.reasons).flatMap((e) => {
      const x = (e ?? {}) as { task?: unknown; why?: unknown };
      return typeof x.task === "string" && typeof x.why === "string" ? [{ task: x.task.slice(0, 120), why: x.why.slice(0, 300) }] : [];
    }),
  };
  return memory;
}
