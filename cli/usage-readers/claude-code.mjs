// Claude's plan windows, from the file --claude-capture writes (claude-capture.mjs).
// The app is the only place the figures show, so the file is as old as its last
// capture: one over 26 hours old is not trusted. The window's time is the
// file's modification time.

import { readFileSync, statSync } from "node:fs";
import { parseClaudeFields } from "./claude-capture.mjs";

const MAX_AGE_MS = 26 * 3_600_000;
const unknown = (why) => ({ windows: [], notes: [`claude-code: usage unknown, ${why}`] });

// ctx: { paths: { claudeUsage }, now }. Returns { windows, notes }.
export async function readClaudeCode(ctx) {
  const path = ctx.paths.claudeUsage;
  let stat;
  try { stat = statSync(path); } catch (error) {
    if (error.code === "ENOENT") return unknown("no capture file");
    throw error;
  }
  const age = ctx.now - stat.mtimeMs;
  if (age > MAX_AGE_MS || age < -60_000) return unknown("the capture is over 26 hours old");
  if (stat.size > 4096) return unknown("the capture file is not four fields");
  let parsed;
  try { parsed = parseClaudeFields(readFileSync(path, "utf8")); } catch { return unknown("the capture file could not be read as four fields"); }
  const at = new Date(stat.mtimeMs).toISOString();
  const windows = [];
  if (parsed.five) windows.push({ name: "5-hour", usedPercent: parsed.five.percent, resetsAt: parsed.five.resetsAt, at });
  windows.push({ name: "weekly", usedPercent: parsed.week.percent, resetsAt: parsed.week.resetsAt, at });
  return { windows, notes: [] };
}
