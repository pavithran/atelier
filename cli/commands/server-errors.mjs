// atelier server-errors. Its forms, flags and help are declared in src/usage/commands/server-errors.ts.
import { spawn } from "node:child_process";
import { args, die } from "../atelier.mjs";

// The complete JSON values in text, in order. `wrangler tail --format json`
// prints each event as a pretty-printed object over several lines, with other
// lines (a banner, a notice) between them, so a line is not a unit: this
// follows braces outside strings and parses each top-level object whole. A
// piece that does not parse is skipped.
export function tailEvents(text) {
  return scanTail(text).events;
}

// The events in text and the unfinished object after them, to be completed by
// the next chunk of output.
function scanTail(text) {
  const events = [];
  let depth = 0, start = -1, inString = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"' && depth > 0) inString = true;
    else if (c === "{") {
      if (depth++ === 0) start = i;
    } else if (c === "}" && depth > 0 && --depth === 0) {
      try { events.push(JSON.parse(text.slice(start, i + 1))); } catch {}
    }
  }
  return { events, rest: depth > 0 ? text.slice(start) : "" };
}

// Error text can quote a URL or a credential; the query of a URL and the
// value after Bearer or Basic are dropped, and the text is put on one line.
function clean(text) {
  return String(text)
    .replace(/(\S*\/[^\s?#]*)[?#]\S*/g, "$1")
    .replace(/[?&#][^\s=]*=\S*/g, "")
    .replace(/\b(Bearer|Basic)\s+\S+/gi, "$1 [removed]")
    .replace(/\s+/g, " ").trim();
}

function part(v) {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && typeof v.message === "string") return v.message;
  return "[object]";
}

// Why a finished wrangler process means the tail failed, or null. Any nonzero
// close code fails it; only the stop this command asked for (SIGINT, so no
// code or 130) does not.
export function tailFailure(code, stopped) {
  if (code === 0 || (stopped && (code === null || code === 130))) return null;
  return code === -1
    ? "could not run npx wrangler; run this from a checkout of this repository with npm ci done"
    : `wrangler tail failed (exit ${code}); no error count is available`;
}

// One line for an event that logged at error level or threw, else null:
// time, method, path and the error text. Only these fields are read, so no
// header, query string or body can reach the line.
export function errorLine(event) {
  const texts = [];
  for (const e of event?.exceptions ?? []) texts.push(`${e?.name ?? "Error"}: ${e?.message ?? ""}`);
  for (const l of event?.logs ?? []) {
    if (l?.level === "error") texts.push((Array.isArray(l.message) ? l.message : [l.message]).map(part).join(" "));
  }
  if (!texts.length) return null;
  const request = event.event?.request ?? {};
  let path = "-";
  try { path = new URL(request.url).pathname; } catch {}
  const ms = event.eventTimestamp ?? event.exceptions?.[0]?.timestamp ?? event.logs?.[0]?.timestamp;
  const time = Number.isFinite(ms) ? new Date(ms).toISOString() : "-";
  return `${time} ${request.method ?? "-"} ${path} ${texts.map(clean).join(" | ")}`;
}

// Tails the Worker for --minutes (2 by default) and prints errorLine for
// each event as it completes. Run from a checkout of this repository, which
// holds the Wrangler configuration.
export default async function serverErrorsCommand() {
  const minutes = args.minutes === undefined ? 2 : Number(args.minutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) die("--minutes needs a whole number from 1 to 60: atelier server-errors --minutes 5");
  const child = spawn("npx", ["wrangler", "tail", "--format", "json"], { stdio: ["ignore", "pipe", "inherit"] });
  let pending = "", seen = 0;
  const flush = () => {
    const scanned = scanTail(pending);
    pending = scanned.rest;
    for (const e of scanned.events) { const line = errorLine(e); if (line) { seen++; console.log(line); } }
  };
  child.stdout.on("data", (d) => { pending += d; flush(); });
  let stopped = false;
  const stop = () => { stopped = true; child.kill("SIGINT"); };
  const timer = setTimeout(stop, minutes * 60_000);
  process.once("SIGINT", stop);
  const code = await new Promise((done) => { child.on("error", () => done(-1)); child.on("close", done); });
  clearTimeout(timer);
  flush();
  const failure = tailFailure(code, stopped);
  if (failure) die(failure);
  console.log(`${seen} error event${seen === 1 ? "" : "s"} in ${minutes} minute${minutes === 1 ? "" : "s"} of tail.`);
}
