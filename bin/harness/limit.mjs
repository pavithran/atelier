// A provider's usage limit, as the shipped adapters (atelier-*.mjs) report it
// to the runner (t487). A limit is the provider saying "no more until T", not
// the model failing the job, so the adapter ends with exit status 75 and, as
// the last line of its standard error,
//
//   ATELIER_PROVIDER_LIMIT {"harness":"codex","reason":"...","resetAt":"2026-10-14T15:00:00.000Z"|null,"resetText":"..."|null}
//
// and the runner (cli/runner.mjs, providerLimitOf) pauses that harness until
// resetAt instead of counting a failure. Only these adapters emit it: a runner
// config's own command is judged by its exit status alone.
//
// Only harness-specific structured failure channels on nonzero exits count.
// Successful output is always an answer, even if it looks like an error.
// No plain text diagnostics or nested answer strings supply limit evidence.
//
// The reset instant, read from the message (parseReset), is one of:
//   - an epoch after a bar or under resets_at ("usage limit reached|1760000000");
//   - a date and time with an explicit offset ("2026-10-14T15:00:00Z", "+02:00");
//   - a relative duration ("in 2 hours 13 minutes", "after 3h12m5s",
//     "retry after 120", resets_in_seconds: 90);
//   - a dated time with no zone ("Oct 14, 2026 3:05 PM", "2026-10-14 15:05"),
//     read in the zone the message names in parentheses ("(America/New_York)")
//     or else the runner's own (TZ, else the system's);
//   - a time alone ("resets 3pm", "at 15:30"), the next such time after now,
//     in the same zone.
// A message with none of these, one this cannot read (Feb 31, 25:00), and a
// dated reset already past all leave resetAt null, and the runner pauses the
// harness for FALLBACK_MINUTES (60) from the moment it sees the limit.

import { spawnSync } from "node:child_process";

import { runAdapter } from "../../cli/harness/adapter.mjs";

export const PROVIDER_LIMIT_EXIT = 75;
export const LIMIT_MARKER = "ATELIER_PROVIDER_LIMIT";
export const FALLBACK_MINUTES = 60;

// ── the reset instant ───────────────────────────────────────────────────────

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const UNIT_MS = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };
const UNITS = String.raw`(?:days?|hours?|hrs?|minutes?|mins?|seconds?|secs?|d|h|m|s)(?![a-z])`;
const DURATION_TOKEN = String.raw`\d+(?:\.\d+)?\s*${UNITS}`;
const DURATION = String.raw`${DURATION_TOKEN}(?:(?:\s*,?\s*(?:and\s+)?)${DURATION_TOKEN})*`;

// Milliseconds east of UTC that `zone` is at `ms`; throws on an unknown zone.
function offsetAt(ms, zone) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(ms));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - Math.floor(ms / 1000) * 1000;
}

// The instant of a wall-clock time in `zone`, or null for a time that does not
// exist (a 31st of February, hour 25) or a zone that is unknown.
export function zonedInstant(year, month, day, hour, minute, second, zone) {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(wall);
  if (hour > 23 || minute > 59 || second > 59 || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  try {
    const first = wall - offsetAt(wall, zone);
    return wall - offsetAt(first, zone);
  } catch { return null; }
}

// The calendar date it is at `ms` in `zone`.
function dateIn(ms, zone) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

const runnerZone = () => process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

function durationMs(text) {
  let total = 0;
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*(days?|hours?|hrs?|minutes?|mins?|seconds?|secs?|d|h|m|s)(?![a-z])/gi)) total += Number(m[1]) * UNIT_MS[m[2][0].toLowerCase()];
  return total;
}

// A time of day in `text`: "3pm", "3:05 PM", "15:30", or null.
function timeOfDay(text) {
  const twelve = /\b(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*([ap])\.?m\b\.?/i.exec(text);
  if (twelve) {
    const hour = Number(twelve[1]);
    if (hour < 1 || hour > 12) return { invalid: true };
    return { hour: (hour % 12) + (twelve[4].toLowerCase() === "p" ? 12 : 0), minute: Number(twelve[2] ?? 0), second: Number(twelve[3] ?? 0), at: twelve.index };
  }
  const twentyFour = /\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/.exec(text);
  return twentyFour ? { hour: Number(twentyFour[1]), minute: Number(twentyFour[2]), second: Number(twentyFour[3] ?? 0), at: twentyFour.index } : null;
}

// The zone a message names: "(America/New_York)", "(UTC)" or a bare UTC/GMT.
function namedZone(text) {
  return /\(([A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+|UTC|GMT)\)/.exec(text)?.[1] ?? /\b\d(?:\s*[ap]m|\d)?\s+(UTC|GMT)\b/i.exec(text)?.[1]?.toUpperCase() ?? null;
}

// The instant `text` says a limit resets, in ms since the epoch, or null when
// it says none that can be read or one already past (see the header). `now` is
// a Date or ms (the clock tests fake); `timeZone` is the runner's.
export function parseReset(text, { now = Date.now(), timeZone } = {}) {
  const nowMs = +now;
  const zone = namedZone(text) ?? timeZone ?? runnerZone();
  // A zone Intl does not know (a bad TZ, a message's "(Foo/Bar)") reads no
  // zoned time; the reset is then the fallback's.
  const knownZone = (() => { try { offsetAt(nowMs, zone); return true; } catch { return false; } })();
  const future = (ms) => (Number.isFinite(ms) && ms > nowMs ? ms : null);

  const epoch = /\|\s*(\d{9,13})\b/.exec(text) ?? /resets?_?at["']?\s*[:=]\s*["']?(\d{9,13})\b/i.exec(text);
  if (epoch) return future(Number(epoch[1]) < 1e11 ? Number(epoch[1]) * 1000 : Number(epoch[1]));

  const iso = /(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)(?![\dA-Za-z])/.exec(text);
  if (iso) {
    const [, y, mo, d, h, mi, s, off] = iso;
    const wall = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s ?? 0));
    if (+h > 23 || +mi > 59 || +(s ?? 0) > 59 || new Date(wall).getUTCMonth() !== +mo - 1 || new Date(wall).getUTCDate() !== +d) return null;
    const sign = off === "Z" ? 0 : off.startsWith("-") ? -1 : 1;
    const digits = off.replace(/[^\d]/g, "");
    if (+digits.slice(0, 2) > 23 || +(digits.slice(2, 4) || 0) > 59) return null;
    return future(wall - sign * ((+digits.slice(0, 2)) * 60 + +(digits.slice(2, 4) || 0)) * 60_000);
  }

  const relative = new RegExp(String.raw`\b(?:in|after|within)\s+(${DURATION})`, "i").exec(text)
    ?? new RegExp(String.raw`retry[\s_-]*(?:after|delay|in)\W{0,4}(${DURATION})`, "i").exec(text);
  if (relative) return future(nowMs + durationMs(relative[1]));
  const seconds = /(?:resets?_in_seconds|retry[\s_-]*after(?:_seconds)?|retry-after)["']?\s*[:=]?\s*["']?(\d+(?:\.\d+)?)\b/i.exec(text);
  if (seconds) return future(nowMs + Number(seconds[1]) * 1000);

  if (!knownZone) return null;
  const day = /(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(text);
  if (day) {
    const [, y, mo, d, h, mi, s] = day;
    const at = zonedInstant(+y, +mo, +d, +h, +mi, +(s ?? 0), zone);
    return at === null ? null : future(at);
  }
  const dated = new RegExp(String.raw`\b(${MONTHS.join("|")})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4})\b)?`, "i").exec(text);
  const clock = timeOfDay(dated ? text.slice(dated.index + dated[0].length) : text);
  if (dated) {
    if (!clock || clock.invalid) return null;
    const year = dated[3] ? Number(dated[3]) : dateIn(nowMs, zone).year;
    const at = zonedInstant(year, MONTHS.indexOf(dated[1].toLowerCase()) + 1, Number(dated[2]), clock.hour, clock.minute, clock.second, zone);
    return at === null ? null : future(at);
  }
  if (!clock || clock.invalid) return null;
  // A time alone: today's, or tomorrow's once it has passed.
  let { year, month, day: dd } = dateIn(nowMs, zone);
  let at = zonedInstant(year, month, dd, clock.hour, clock.minute, clock.second, zone);
  if (at === null) return null;
  if (at <= nowMs) {
    const next = new Date(Date.UTC(year, month - 1, dd + 1));
    at = zonedInstant(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), clock.hour, clock.minute, clock.second, zone);
  }
  return at;
}

// ── the limit ───────────────────────────────────────────────────────────────

// How each provider says it inside its structured failure message.
const LIMIT = [
  /usage limit (?:reached|exceeded|hit)/i,
  /(?:\d+-hour|weekly|daily|monthly|session|opus|sonnet)\s+limit (?:reached|exceeded|hit)/i,
  /(?:you(?:'|’)ve|you have) (?:hit|reached|exceeded) (?:your|the) (?:\w+ )?(?:usage |rate |request )?limit/i,
  /usage_limit_reached/i,
  /(?:rate[ _-]?limit(?:ed)?|request limit|too many requests)\b/i,
  /(?:\b429\b|status(?: code)?:? 429|http 429)/i,
  /resource[_ ]exhausted/i,
  /(?:you(?:'|’)ve|you have) exhausted your (?:capacity|quota)/i,
  /(?:you(?:'|’)ve |you have |you )?(?:exceeded|exhausted) your (?:current )?(?:quota|usage|credits?)/i,
  /(?:quota|credits?) (?:exceeded|exhausted|has been exhausted)/i,
  /insufficient_quota|rate_limit_exceeded/i,
  /out of (?:extra )?usage/i,
];
const AUTH = /\b(?:401|403)\b|unauthori[sz]ed|forbidden|invalid[_ ](?:x-)?api[_ -]?key|incorrect api key|authentication[_ ](?:failed|error|required)|not (?:logged|signed) in|please (?:run )?\/?log ?in|(?:token|credentials?|session) (?:has )?expired|invalid (?:token|credentials?)/i;
const TIMEOUT = /timed? ?out|ETIMEDOUT|deadline exceeded|request aborted/i;
// Decode the transport before inspecting error fields. In particular, a JSON
// example in an assistant message is never parsed again as a provider event.
function errorMessage(value, harness) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  let error;
  if (harness === "claude-code") {
    if (value.type !== "result" || value.is_error !== true) return null;
    return [value.result, ...(Array.isArray(value.errors) ? value.errors : [])]
      .filter((x) => typeof x === "string").join(" ");
  }
  if (harness === "codex") {
    if (value.type !== "error") return null;
    error = value;
  } else if (harness === "opencode") {
    if (value.type !== "error" || value.error?.name !== "APIError") return null;
    error = value.error;
  } else if (harness === "antigravity") {
    if (value.response !== undefined || !value.error || typeof value.error !== "object") return null;
    error = value.error;
    if (error.code !== 429 && error.status !== "RESOURCE_EXHAUSTED") return null;
  } else return null;
  const detail = error.data && typeof error.data === "object" ? error.data : error;
  return [error.type, error.code, error.status, error.message, detail === error ? "" : detail.message,
    detail.statusCode, detail.resets_at == null ? "" : `resets_at: ${detail.resets_at}`,
    detail.resets_in_seconds == null ? "" : `resets_in_seconds: ${detail.resets_in_seconds}`,
    detail.retryDelay == null ? "" : `retry after ${detail.retryDelay}`,
  ].filter((x) => typeof x === "string" || typeof x === "number").join(" ");
}

function records(text, harness) {
  // Claude and agy return one JSON document. Never scan their answer lines.
  if (harness === "claude-code" || harness === "antigravity") {
    try { return [JSON.parse(text)]; } catch { return []; }
  }
  return String(text ?? "").split("\n").flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

export function detectLimit(run, { now = Date.now(), timeZone, harness } = {}) {
  if (run.error || !Number.isInteger(run.status) || run.status <= 0 || run.signal) return null;
  for (const stream of ["stderr", "stdout"]) {
    for (const value of records(run[stream], harness)) {
      const message = errorMessage(value, harness);
      if (!message || AUTH.test(message) || TIMEOUT.test(message)) continue;
      if (!LIMIT.some((pattern) => pattern.test(message))) continue;
      const at = parseReset(message, { now, timeZone });
      return { reason: message.replace(/\s+/g, " ").slice(0, 300),
        resetAt: at === null ? null : new Date(at).toISOString(),
        resetText: message.replace(/\s+/g, " ").slice(0, 300) };
    }
  }
  return null;
}

// Request a transport that separates provider failures from model answers.
function structuredArgs(harness, argv) {
  const args = [...argv];
  if (harness === "claude-code") args[args.indexOf("--output-format") + 1] = "json";
  if (harness === "codex") args.splice(args.length - 1, 0, "--json");
  if (harness === "opencode") args.push("--format", "json");
  return args;
}

function answerOutput(harness, stdout) {
  if (harness === "claude-code") {
    const result = records(stdout, harness).find((v) => v?.type === "result" && v.is_error === false);
    return typeof result?.result === "string" ? result.result : "";
  }
  if (harness === "opencode") return records(stdout, harness)
    .filter((v) => v?.type === "text" && typeof v.part?.text === "string")
    .map((v) => v.part.text).join("\n");
  return stdout;
}

// ── the adapter's spawn ─────────────────────────────────────────────────────

// A spawn for runAdapter that runs the harness (the call that gives it a
// prompt on standard input; codex's `mcp list` calls pass through), puts what
// it printed where it would have gone, and, when the run ended in a provider
// limit, ends with PROVIDER_LIMIT_EXIT and the marker line on standard error.
// Output reaches the runner when the harness ends, not as it is written.
export function limitSpawn(harness, io = {}) {
  const spawn = io.spawn ?? spawnSync;
  const out = io.stdout ?? ((text) => process.stdout.write(text));
  const err = io.stderr ?? ((text) => process.stderr.write(text));
  return (exe, argv, options) => {
    if (options?.input === undefined) return spawn(exe, argv, options);
    const inheritsStdout = options.stdio?.[1] === "inherit";
    const run = spawn(exe, structuredArgs(harness, argv), { ...options, stdio: ["pipe", "pipe", "pipe"] });
    const limit = detectLimit(run, { now: io.now?.() ?? Date.now(), timeZone: io.timeZone, harness });
    // A marker line a harness printed itself is not the adapter's.
    const stderr = String(run.stderr ?? "").split("\n").filter((l) => !l.startsWith(LIMIT_MARKER)).join("\n");
    const stdout = run.status === 0 ? answerOutput(harness, run.stdout) : run.stdout;
    if (inheritsStdout && stdout) out(String(stdout));
    if (stderr) err(stderr.endsWith("\n") ? stderr : `${stderr}\n`);
    if (!limit) return run.status === 0 ? { ...run, stdout } : run;
    err(`${LIMIT_MARKER} ${JSON.stringify({ harness, ...limit })}\n`);
    return { ...run, status: PROVIDER_LIMIT_EXIT, stdout: "" };
  };
}

// What bin/harness/atelier-*.mjs run: the adapter, with limits reported.
export function runWithLimits(harness, argv, io = {}) {
  return runAdapter(harness, argv, { ...io, spawn: limitSpawn(harness, io) });
}
