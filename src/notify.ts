// Notices (t533): what Atelier once sent to a phone is a ledger event, read in
// chat through `atelier status` and by atelier-pulse. Nothing here makes a
// request; a notice is only recorded and read back.

// The three former notifications, as the events that now stand for them.
export const INBOX_NOTICE = "inbox.notice";
export const USAGE_ALERT = "usage.alert";
export const STUCK_DIGEST_NOTICE = "stuck.digest_notice";
export const NOTICE_KINDS = [INBOX_NOTICE, USAGE_ALERT, STUCK_DIGEST_NOTICE] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

// The window `atelier status` lists.
export const NOTICE_WINDOW_MS = 24 * 3_600_000;

export interface Notice {
  at: string;
  kind: NoticeKind;
  // The project the notice belongs to; null for a usage alert, which is the owner's across projects.
  project: string | null;
  item: string | null;
  text: string;
}

// The section `atelier status` prints from GET /notices, newest first; none
// when there are no notices and every project was read. A project the server
// could not read is named, so silence is never mistaken for nothing recorded.
export function noticeLines(read: { notices?: Notice[]; unread?: string[] } | null | undefined): string[] {
  const notices = read?.notices ?? [], unread = read?.unread ?? [];
  if (!notices.length && !unread.length) return [];
  return [
    "Notices (last 24 hours, newest first)",
    ...notices.map((n) => `  ${n.at} ${n.project ?? "usage"}${n.item ? ` ${n.item}` : ""}: ${n.text}`),
    ...(unread.length ? [`  could not be read: ${unread.join(", ")}`] : []),
  ];
}

// Any run of whitespace, line breaks included, becomes one space.
const one = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();

// The one line a notice reads as.
export function noticeText(kind: NoticeKind, data: Record<string, unknown>): string {
  if (kind === INBOX_NOTICE) {
    const why = data.reason === "round-cap" ? "held after the round cap" : "waiting on you";
    return `${one(data.title)} is ${why}: ${one(data.brief)}`;
  }
  if (kind === USAGE_ALERT) return one(data.title);
  const episodes = Array.isArray(data.episodes) ? data.episodes as { item?: unknown; reason?: unknown }[] : [];
  return `${episodes.length} stuck ${episodes.length === 1 ? "episode" : "episodes"}: ${episodes.map((e) => `${one(e.item)}: ${one(e.reason)}`).join("; ")}`;
}
