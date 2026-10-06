// Times as the owner reads them: in the time zone the TIMEZONE setting names
// (an IANA name such as America/New_York), or UTC when it is unset or not a
// zone this runtime knows. Pages are drawn on the server and read without
// script, so the zone is the owner's setting, not the browser's. Each request
// sets it from the Worker's settings before any page is drawn.

let zone = "UTC";

export function setTimeZone(name: string | undefined | null): string {
  zone = "UTC";
  if (name) {
    try { new Intl.DateTimeFormat("en-US", { timeZone: name }); zone = name; } catch { /* unknown zone: UTC */ }
  }
  return zone;
}

export const timeZone = () => zone;

const parts = (at: Date | string | number) => {
  const d = at instanceof Date ? at : new Date(at);
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short",
  }).formatToParts(d);
  const get = (t: string) => f.find((p) => p.type === t)?.value ?? "";
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour"), min: get("minute"), tz: get("timeZoneName") };
};

// "2026-10-05 10:46 EDT"
export function stamp(at: Date | string | number): string {
  const p = parts(at);
  return `${p.y}-${p.m}-${p.d} ${p.h}:${p.min} ${p.tz}`;
}

// "10:46 EDT"
export function clockTime(at: Date | string | number): string {
  const p = parts(at);
  return `${p.h}:${p.min} ${p.tz}`;
}

// "10/05 10:46", for graph labels where space is short; the page names the zone once.
export function shortStamp(at: Date | string | number): string {
  const p = parts(at);
  return `${p.m}/${p.d} ${p.h}:${p.min}`;
}

// "2026-10-05"
export function dayOf(at: Date | string | number): string {
  const p = parts(at);
  return `${p.y}-${p.m}-${p.d}`;
}

// "Sunday": the day of the week in the owner's zone.
export function weekdayOf(at: Date | string | number): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long" }).format(at instanceof Date ? at : new Date(at));
}

// "EDT": the abbreviation in force at one moment.
export function zoneName(at: Date | string | number = Date.now()): string {
  return parts(at).tz;
}

// "New York time", or "UTC": the zone itself, right in every season, for a
// legend beside times from many dates. An abbreviation such as EDT is right
// only for the dates it belongs to.
export function zoneLabel(): string {
  if (zone === "UTC") return "UTC";
  const city = zone.split("/").pop()!.replace(/_/g, " ");
  return `${city} time`;
}
