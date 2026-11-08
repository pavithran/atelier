// The four-field text the orchestrating session captures from the Claude app:
// FIVE WEEK FIVE_RESET WEEK_RESET, percents used and when each resets. A dash
// stands for the 5-hour window the app does not show, in both of its fields.
// The reader (claude-code.mjs) and the capture write use this one parser, so a
// file the capture accepts is a file the reader accepts.

import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const PERCENT = /^\d{1,3}(\.\d+)?$/;

function percent(field, what) {
  if (field === "-") return null;
  if (!PERCENT.test(field) || Number(field) > 100) throw new Error(`${what} must be a number from 0 to 100, or - for none; got "${field}"`);
  return Number(field);
}

function reset(field, what) {
  if (field === "-") return null;
  const ms = /^\d{9,11}$/.test(field) ? Number(field) * 1000 : Date.parse(field);
  if (!Number.isFinite(ms) || ms <= 0) throw new Error(`${what} must be a time such as 2026-11-12T09:00:00Z, or - for none; got "${field}"`);
  return new Date(ms).toISOString();
}

// Text to { five, week }, each { percent, resetsAt } or null for the 5-hour
// window. Throws an error naming the fault.
export function parseClaudeFields(text) {
  const fields = String(text).trim().split(/\s+/);
  if (fields.length !== 4) throw new Error(`expected four fields, FIVE WEEK FIVE_RESET WEEK_RESET; got ${fields.length}`);
  const [five, week, fiveReset, weekReset] = fields;
  const weekly = percent(week, "WEEK");
  if (weekly === null) throw new Error("WEEK needs a number: the weekly window is always shown");
  const weekAt = reset(weekReset, "WEEK_RESET");
  if (weekAt === null) throw new Error("WEEK_RESET needs a time");
  const fivePercent = percent(five, "FIVE");
  const fiveAt = reset(fiveReset, "FIVE_RESET");
  if ((fivePercent === null) !== (fiveAt === null)) throw new Error("FIVE and FIVE_RESET are both - or both given");
  return { five: fivePercent === null ? null : { percent: fivePercent, resetsAt: fiveAt }, week: { percent: weekly, resetsAt: weekAt } };
}

// Writes the file by temp file and rename, so a reader never sees half of it
// and a refused capture leaves the old file as it was. `rename` is given by a
// test only.
export function writeClaudeCapture(text, path, rename = renameSync) {
  let parsed;
  try { parsed = parseClaudeFields(text); } catch (error) { throw new Error(`--claude-capture refused: ${error.message}`); }
  const line = `${parsed.five ? parsed.five.percent : "-"} ${parsed.week.percent} ${parsed.five ? parsed.five.resetsAt : "-"} ${parsed.week.resetsAt}\n`;
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.claude-usage.${process.pid}.tmp`);
  writeFileSync(temp, line, { mode: 0o600 });
  try { rename(temp, path); } catch (error) {
    try { unlinkSync(temp); } catch { /* already gone */ }
    throw error;
  }
}
