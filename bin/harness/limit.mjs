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
// What counts as a limit: a harness that exited (a timeout or a kill leaves no
// status, and is no limit) whose output says one in the words a provider
// uses — and says it as a message, not as quoted text. A limit phrase must
// open its line (after a short prefix such as "Error:" or a log level, and no
// quotation mark or markdown), so an answer that quotes "usage limit reached"
// is no limit. A zero exit is a limit only when the harness's whole answer is
// that one short message (some harnesses print the limit and exit 0); any
// other zero exit is an answer. A line that is an authentication error or a
// timeout is none of them.
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
  const future = (ms) => (Number.isFinite(ms) && ms > nowMs ? ms : null);

  const epoch = /\|\s*(\d{9,13})\b/.exec(text) ?? /resets?_?at["']?\s*[:=]\s*["']?(\d{9,13})\b/i.exec(text);
  if (epoch) return future(Number(epoch[1]) < 1e11 ? Number(epoch[1]) * 1000 : Number(epoch[1]));

  const iso = /(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)(?![\dA-Za-z])/.exec(text);
  if (iso) {
    const [, y, mo, d, h, mi, s, off] = iso;
    const wall = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s ?? 0));
    if (+h > 23 || +mi > 59 || +(s ?? 0) > 59 || new Date(wall).getUTCDate() !== +d) return null;
    const sign = off === "Z" ? 0 : off.startsWith("-") ? -1 : 1;
    const digits = off.replace(/[^\d]/g, "");
    return future(wall - sign * ((+digits.slice(0, 2)) * 60 + +(digits.slice(2, 4) || 0)) * 60_000);
  }

  const relative = new RegExp(String.raw`\b(?:in|after|within)\s+(${DURATION})`, "i").exec(text)
    ?? new RegExp(String.raw`retry[\s_-]*(?:after|delay|in)\W{0,4}(${DURATION})`, "i").exec(text);
  if (relative) return future(nowMs + durationMs(relative[1]));
  const seconds = /(?:resets?_in_seconds|retry[\s_-]*after(?:_seconds)?|retry-after)["']?\s*[:=]?\s*["']?(\d+(?:\.\d+)?)\b/i.exec(text);
  if (seconds) return future(nowMs + Number(seconds[1]) * 1000);

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

// How each provider says it. All are matched at the start of a message.
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
// What may come before a limit phrase on its line: a log level, a label such
// as "stream error:", a bracketed time, the harness's name, a status code.
const PREFIX = /^(?:(?:\[[^\]]{0,40}\]|[A-Za-z][\w .-]{0,24}:|\d{4}-\d\d-\d\d[T\d:.Z+-]*|(?:ERROR|WARN(?:ING)?|FATAL|Error|Claude(?: AI)?|Codex|opencode|agy)(?![\w])|\d{3})\s*)*$/;

// The strings a JSON line carries, and the reset hints in its numbers.
function jsonLines(text) {
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  const strings = [], hints = [];
  const walk = (v, depth) => {
    if (depth > 4 || v === null) return;
    if (typeof v === "string") strings.push(v);
    else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1));
    else if (typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (typeof x === "number" && /^resets?_?at$/i.test(k)) hints.push(`resets_at: ${x}`);
        else if (typeof x === "number" && /^resets?_in_seconds$/i.test(k)) hints.push(`resets_in_seconds: ${x}`);
        else walk(x, depth + 1);
      }
    }
  };
  walk(value, 0);
  return { strings, hints };
}

// The messages a stream holds, as { text, source, rest } with `rest` the text
// of the lines after it for a reset on the next line.
function messages(text, source) {
  // Lines in a code fence quote something; they are no message of the harness's.
  let fenced = false;
  const lines = String(text ?? "").replace(/\r/g, "").split("\n").map((l) => l.trim()).filter((l) => {
    if (l.startsWith("```")) { fenced = !fenced; return false; }
    return l && !fenced;
  }).slice(-40);
  return lines.flatMap((line, i) => {
    const rest = lines.slice(i + 1, i + 3).join(" ");
    const json = line.startsWith("{") || line.startsWith("[") ? jsonLines(line) : null;
    if (json) return json.strings.map((text) => ({ text, source, rest: [...json.hints, rest].join(" "), json: true }));
    return [{ text: line, source, rest }];
  });
}

// Whether `message` opens with a limit phrase: { reason } or null.
function limitIn(message) {
  if (message.text.length > 600) return null;
  for (const pattern of LIMIT) {
    const m = pattern.exec(message.text);
    if (!m) continue;
    const prefix = message.text.slice(0, m.index);
    if (!message.json && !PREFIX.test(prefix)) continue;
    return { reason: message.text.replace(/\s+/g, " ").slice(0, 300) };
  }
  return null;
}

// The provider limit a harness run ended in, or null: { reason, resetAt, resetText }
// with resetAt an ISO instant or null. `run` is { status, stdout, stderr, error }
// as spawnSync gives it; `answer` is the text a zero exit's stdout holds (for
// agy, the response inside its JSON).
export function detectLimit(run, { now = Date.now(), timeZone, harness } = {}) {
  if (run.error || run.status === null || run.status === undefined || run.signal) return null;
  const stderr = messages(run.stderr, "stderr");
  let answer = String(run.stdout ?? "");
  if (harness === "antigravity") { try { const r = JSON.parse(answer.trim()).response; if (typeof r === "string") answer = r; } catch { /* raw text */ } }
  let stdout;
  if (run.status === 0) {
    // The whole answer is one short message, or it is an answer.
    const whole = answer.trim();
    if (!whole || whole.length > 400 || whole.split("\n").filter((l) => l.trim()).length > 3) return null;
    stdout = messages(whole, "stdout");
  } else stdout = messages(answer, "stdout").slice(-10);
  const all = run.status === 0 ? stdout : [...stderr, ...stdout];
  const found = all.map((message) => ({ message, limit: limitIn(message) })).find((x) => x.limit);
  if (!found) return null;
  // An authentication error or a timeout that names no provider limit of its own.
  if (all.some((m) => (AUTH.test(m.text) || TIMEOUT.test(m.text)) && !LIMIT.slice(0, 5).some((p) => p.test(m.text)))) return null;
  if (TIMEOUT.test(found.message.text) || AUTH.test(found.message.text)) return null;
  const source = `${found.message.text} ${found.message.rest}`;
  const at = parseReset(source, { now, timeZone });
  return { reason: found.limit.reason, resetAt: at === null ? null : new Date(at).toISOString(), resetText: source.replace(/\s+/g, " ").trim().slice(0, 300) };
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
    const run = spawn(exe, argv, { ...options, stdio: ["pipe", "pipe", "pipe"] });
    const limit = detectLimit(run, { now: io.now?.() ?? Date.now(), timeZone: io.timeZone, harness });
    // A marker line a harness printed itself is not the adapter's.
    const stderr = String(run.stderr ?? "").split("\n").filter((l) => !l.startsWith(LIMIT_MARKER)).join("\n");
    if (inheritsStdout && run.stdout) out(String(run.stdout));
    if (stderr) err(stderr.endsWith("\n") ? stderr : `${stderr}\n`);
    if (!limit) return run;
    err(`${LIMIT_MARKER} ${JSON.stringify({ harness, ...limit })}\n`);
    return { ...run, status: PROVIDER_LIMIT_EXIT, stdout: "" };
  };
}

// What bin/harness/atelier-*.mjs run: the adapter, with limits reported.
export function runWithLimits(harness, argv, io = {}) {
  return runAdapter(harness, argv, { ...io, spawn: limitSpawn(harness, io) });
}
