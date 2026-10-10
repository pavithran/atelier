// The local record of when named tokens expire — the deploy and ops
// Cloudflare tokens, for one — and the warning `atelier status` gives before
// they lapse. A token is named, never valued: the record holds only a name
// mapped to its expiry day, so no token string is ever written to it. Days
// are compared as whole UTC days, so the window is about days, not hours.
//
// `atelier ops token-expiry NAME --on YYYY-MM-DD` writes the record;
// `atelier status` reads it and warns from TOKEN_EXPIRY_WARN_DAYS before the
// day, and after it, naming the token and the date.

// The warning window: a token whose expiry is this many days away or fewer
// warns, a past expiry included.
export const TOKEN_EXPIRY_WARN_DAYS = 14;

// NAME -> "YYYY-MM-DD". Never a value.
type TokenExpiries = Record<string, string>;

// The day "YYYY-MM-DD" as the start of that UTC day, or null when the text
// is not a real day. The round-trip check refuses a day JavaScript would
// roll over, such as February 31.
export function parseExpiryDay(text: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return null;
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  const at = new Date(Date.UTC(year, month - 1, day));
  if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) return null;
  return at;
}

// Whole days from `now` to the expiry day, negative once the day is past.
export function daysUntil(expiry: Date, now: Date): number {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.floor((expiry.getTime() - today) / 86400000);
}

// Whether the expiry day falls in the warning window: at most `days` days
// away, a past day included. A day that is not a real date never warns: it
// cannot be compared to now.
export function warns(expiry: string, now = new Date(), days = TOKEN_EXPIRY_WARN_DAYS): boolean {
  const day = parseExpiryDay(expiry);
  return day !== null && daysUntil(day, now) <= days;
}

// The tokens that warn, soonest first, each with its name, its day and the
// whole days left (negative once past). A token whose day is not a real date
// is skipped.
export function tokenExpiryWarnings(expiries: TokenExpiries, now = new Date(), days = TOKEN_EXPIRY_WARN_DAYS) {
  const out: { name: string; date: string; daysLeft: number }[] = [];
  for (const [name, expiry] of Object.entries(expiries ?? {})) {
    const day = parseExpiryDay(expiry);
    if (!day) continue;
    const daysLeft = daysUntil(day, now);
    if (daysLeft <= days) out.push({ name, date: expiry, daysLeft });
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft || a.name.localeCompare(b.name));
}

// The lines `atelier status` prints for the tokens that warn, each naming the
// token and its date. Empty when nothing warns.
export function formatTokenExpiryWarnings(expiries: TokenExpiries, now = new Date(), days = TOKEN_EXPIRY_WARN_DAYS): string[] {
  const list = tokenExpiryWarnings(expiries, now, days);
  if (!list.length) return [];
  const lines = ["Token expiries:"];
  for (const w of list) {
    const when = w.daysLeft < 0
      ? `expired ${-w.daysLeft} ${-w.daysLeft === 1 ? "day" : "days"} ago`
      : w.daysLeft === 0 ? "expires today"
        : w.daysLeft === 1 ? "expires tomorrow"
          : `expires in ${w.daysLeft} days`;
    lines.push(`  ${w.name} ${when}, on ${w.date}`);
  }
  return lines;
}
