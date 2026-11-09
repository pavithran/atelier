import { renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SHOWN_LINES = 40;

// The last `count` lines of text, without the newlines that end it.
export function lastLines(text, count = SHOWN_LINES) {
  return text.replace(/\s+$/, "").split("\n").slice(-count).join("\n");
}

// Saves a failed step's output as `<ship>-<step>.log` in `dir`, the whole file
// written under a temporary name and then renamed, so a log cut short is never
// named. Returns the path, or null when nothing was saved. `io` replaces the
// file calls in tests.
export function saveStepLog({ dir, ship, step, text }, io = { writeFileSync, renameSync, rmSync }) {
  if (!dir) return null;
  const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, "_");
  const path = join(dir, `${safe(ship)}-${safe(step)}.log`), temp = `${path}.${process.pid}.tmp`;
  try {
    io.writeFileSync(temp, text);
    io.renameSync(temp, path);
    return path;
  } catch {
    try { io.rmSync(temp, { force: true }); } catch { /* nothing more to clean */ }
    return null;
  }
}

// What a failed step prints: its last lines, and the file holding all of its
// output (or that none was saved). `redact` cuts the secrets from both.
// A step that printed nothing is saved with `ended` (how it ended) as its text.
export function failedStepReport({ dir, ship, step, output, ended, secrets, redact, io }) {
  const clean = redact(output ?? "", secrets).trim() ? redact(output, secrets) : `[atelier] ${ended || "failed with no output"}\n`;
  const path = saveStepLog({ dir, ship, step, text: clean }, io);
  return `${step}: last ${SHOWN_LINES} lines of its output:\n${lastLines(clean)}\n${step}: ${path ? `full output saved to ${path}` : "its full output could not be saved"}`;
}
