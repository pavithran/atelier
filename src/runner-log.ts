import { redactedText } from "./post-merge.ts";
import { redactKeys } from "./models/pool.ts";
const logText = (text: string, secrets: string[] = []) => redactKeys(redactedText(text, secrets)).replace(/atl_[a-f0-9]+/gi, "[redacted]").slice(-7000);
export type RunnerLog = { next: number; lines: { seq: number; text: string }[]; cursors?: Record<string, number> };
export function appendRunnerLog(previous: RunnerLog | null, lines: unknown[]): RunnerLog {
  const log: RunnerLog = { next: previous?.next ?? 1, lines: [...(previous?.lines ?? [])] };
  for (const line of lines.slice(-64)) {
    if (typeof line !== "string") continue;
    const text = logText(line);
    log.lines.push({ seq: log.next++, text });
  }
  while (new TextEncoder().encode(JSON.stringify(log)).byteLength > 65536) log.lines.shift();
  return log;
}
export function runnerLogBuffer(secrets: string[] = []) {
  let recording = false;
  let active: { project: string; task: string; run: string; offset: number; lines: string[] } | null = null;
  return {
    begin(project: string, task: string) { recording = true; active = { project, task, run: crypto.randomUUID(), offset: 0, lines: [] }; },
    line(text: string) {
      if (!active || !recording) return;
      active.lines.push(logText(text, secrets));
      while (active.lines.join("\n").length > 48000 || active.lines.length > 64) { active.lines.shift(); active.offset++; }
    },
    end() { recording = false; },
    // Resend the bounded window so a lost heartbeat does not lose its tail.
    report() { return active?.lines.length ? [{ ...active, lines: [...active.lines] }] : []; },
  };
}
export function receiveRunnerLog(previous: RunnerLog, runner: string, report: { run?: unknown; offset?: unknown; lines?: unknown }): RunnerLog | null {
  if (typeof report.run !== "string" || !/^[a-f0-9-]{36}$/.test(report.run) || !Number.isSafeInteger(report.offset) || Number(report.offset) < 0 || !Array.isArray(report.lines)) return null;
  const key = `${runner}:${report.run}`, offset = Number(report.offset);
  const seen = previous.cursors?.[key] ?? 0;
  const lines = report.lines.slice(0, 64);
  const next = appendRunnerLog(previous, lines.slice(Math.max(0, seen - offset)));
  const cursors = { ...(previous.cursors ?? {}), [key]: Math.max(seen, offset + lines.length) };
  next.cursors = Object.fromEntries(Object.entries(cursors).slice(-8));
  while (new TextEncoder().encode(JSON.stringify(next)).byteLength > 65536) next.lines.shift();
  return next;
}
export async function printRunnerLog(read: () => Promise<RunnerLog>, print: (text: string) => void, follow = false,
  wait = () => new Promise<void>(resolve => setTimeout(resolve, 2000)), running = () => true) {
  let after = 0;
  do {
    const log = await read();
    for (const line of log.lines) if (line.seq > after) { print(line.text); after = line.seq; }
    if (!follow || !running()) return;
    await wait();
  } while (true);
}
