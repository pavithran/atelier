// atelier events. Its forms, flags and help are declared in src/usage/commands/events.ts.
import { COMMAND_USAGE } from "../help.mjs";
import { OWNER, P, args, call, die, project } from "../atelier.mjs";

// A date alone (2026-10-25) as `to` means through the end of that day.
export function bound(text, flag, end) {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text);
  const ms = Date.parse(dateOnly ? `${text}T00:00:00Z` : text);
  if (Number.isNaN(ms)) die(`--${flag} needs a date such as 2026-10-25 or 2026-10-25T09:00:00Z, not "${text}"`);
  return dateOnly && end ? ms + 86_400_000 : ms;
}

// Every event of the project, oldest first, read a page at a time with `read`
// (a page is { events, next }, newest first) and kept when `keep` accepts it.
export async function collectEvents(read, keep = () => true) {
  const out = [];
  let before;
  for (;;) {
    const page = await read(before);
    for (const e of page.events) if (keep(e)) out.push(e);
    if (page.next === null || page.next === undefined || page.next === before) break;
    before = page.next;
  }
  return out.reverse();
}

export function filterOf({ from, to, kinds }) {
  return (e) => {
    const t = Date.parse(e.at);
    return (from === undefined || t >= from) && (to === undefined || t < to) && (!kinds.length || kinds.includes(e.kind));
  };
}

export default async function eventsCommand() {
  if (args._.length !== 1) die(COMMAND_USAGE.events);
  const from = args.from === undefined ? undefined : bound(args.from, "from", false);
  const to = args.to === undefined ? undefined : bound(args.to, "to", true);
  const kinds = args.multi.kind ?? [];
  const name = project();
  const events = await collectEvents(
    (before) => call("GET", `${P(name)}/events${before === undefined ? "" : `?before=${before}`}`, undefined, OWNER),
    filterOf({ from, to, kinds }),
  );
  console.log(JSON.stringify(events, null, 2));
}
