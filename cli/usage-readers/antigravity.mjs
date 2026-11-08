// Antigravity's limit, from the agy CLI's cli.log. The log holds no usage
// figure; a RESOURCE_EXHAUSTED line says how long until the limit lifts
// ("Resets in 4h26m8s"). A recent one is a window at 100% with that reset; no
// recent one leaves the usage unknown, not zero.

import { readFileSync, statSync } from "node:fs";

const MAX_AGE_MS = 26 * 3_600_000;
const TAIL_BYTES = 2 * 1024 * 1024;
const EXHAUSTED = /RESOURCE_EXHAUSTED.*?Resets in (?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/;
const STAMP = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/;
const unknown = (why) => ({ windows: [], notes: [`antigravity: usage unknown, ${why}`] });

// ctx: { paths: { antigravityLog }, now }. Returns { windows, notes }.
export async function readAntigravity(ctx) {
  const path = ctx.paths.antigravityLog;
  let stat;
  try { stat = statSync(path); } catch (error) {
    if (error.code === "ENOENT") return unknown("no cli.log");
    throw error;
  }
  const text = readFileSync(path, "utf8");
  const lines = (text.length > TAIL_BYTES ? text.slice(-TAIL_BYTES) : text).split("\n");
  for (let n = lines.length - 1; n >= 0; n--) {
    const found = EXHAUSTED.exec(lines[n]);
    if (!found || !(found[1] || found[2] || found[3])) continue;
    const stamp = STAMP.exec(lines[n]);
    const at = stamp ? Date.parse(stamp[0]) : stat.mtimeMs;
    if (!Number.isFinite(at)) continue;
    if (ctx.now - at > MAX_AGE_MS) return unknown("its last limit message is over 26 hours old");
    const seconds = Number(found[1] ?? 0) * 3600 + Number(found[2] ?? 0) * 60 + Number(found[3] ?? 0);
    return { windows: [{ name: "limit", usedPercent: 100, resetsAt: new Date(at + seconds * 1000).toISOString(), at: new Date(at).toISOString() }], notes: [] };
  }
  return unknown("cli.log has no limit message");
}
