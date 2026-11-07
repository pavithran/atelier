import { briefFor } from "./brief.ts";
import type { Detail } from "./ui.ts";

// One ntfy message. The title is RFC 2047 encoded so a Unicode title stays
// intact and no control character in it can become a header; every other
// header is plain ASCII, and the body is one line of at most 500 characters.
function ntfyRequest(topic: string, title: string, click: string, tags: string, body: string): Request {
  const clean = `Atelier: ${title}`.replace(/[\u0000-\u001f\u007f]/g, " ");
  const encoded = btoa(Array.from(new TextEncoder().encode(clean), (b) => String.fromCharCode(b)).join(""));
  return new Request(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
    method: "POST",
    headers: {
      Title: `=?UTF-8?B?${encoded}?=`,
      Click: click,
      Tags: tags,
      Priority: "default",
      "Content-Type": "text/plain; charset=utf-8",
    },
    body: Array.from(body.replace(/[\r\n\u2028\u2029]/g, " ")).slice(0, 500).join(""),
  });
}

// A decision waiting on the owner: the task's title and its one-line brief, opening the task page.
export function notificationRequest(topic: string, origin: string, project: string, detail: Detail): Request {
  const click = new URL(`/p/${encodeURIComponent(project)}/${encodeURIComponent(detail.item.id)}`, new URL(origin).origin).href;
  return ntfyRequest(topic, detail.item.title, click, "inbox_tray", briefFor(detail).decided);
}

// A usage alert: a tool's window, day's spend or balance past the owner's
// threshold (src/usage/report.ts), opening the Usage page.
export function usageAlertRequest(topic: string, origin: string, title: string, body: string): Request {
  return ntfyRequest(topic, title, new URL("/usage", new URL(origin).origin).href, "warning", body);
}

// Stuck episodes still open an hour after they were first seen (src/stuck/notices.ts),
// as messages opening the Status page. A message body holds at most BODY_LIMIT
// characters, so a long batch is split into several messages, each carrying
// whole episodes; the caller records an episode only once the message that
// carries it was accepted. One episode whose own line is longer than the limit
// is cut to fit, its item still first.
const BODY_LIMIT = 500, SEPARATOR = "; ";
const chars = (s: string) => Array.from(s.replace(/[\r\n\u2028\u2029]/g, " "));

export function stuckBatchRequests<T extends { item: string; reason: string }>(topic: string, origin: string, project: string, episodes: readonly T[]): { request: Request; episodes: T[] }[] {
  const click = new URL(`/p/${encodeURIComponent(project)}`, new URL(origin).origin).href;
  const groups: { lines: string[]; episodes: T[]; size: number }[] = [];
  for (const e of episodes) {
    const line = chars(`${e.item}: ${e.reason}`).slice(0, BODY_LIMIT).join("");
    const length = chars(line).length;
    let group = groups[groups.length - 1];
    if (!group || group.size + SEPARATOR.length + length > BODY_LIMIT) groups.push(group = { lines: [], episodes: [], size: -SEPARATOR.length });
    group.lines.push(line);
    group.episodes.push(e);
    group.size += SEPARATOR.length + length;
  }
  return groups.map((g) => {
    const n = g.episodes.length;
    return { request: ntfyRequest(topic, `${project}: ${n} stuck ${n === 1 ? "episode" : "episodes"}`, click, "warning", g.lines.join(SEPARATOR)), episodes: g.episodes };
  });
}

// An automatic revert (src/post-merge.ts): the landing of a task turned main's
// suite or the release gate red and Atelier undid it, opening the task page.
export function revertNotificationRequest(topic: string, origin: string, project: string, revert: { itemId: string; kind: "suite" | "gate"; mergeCommit: string; revertCommit: string }): Request {
  const click = new URL(`/p/${encodeURIComponent(project)}/${encodeURIComponent(revert.itemId)}`, new URL(origin).origin).href;
  const what = revert.kind === "gate" ? "the release gate" : "the post-merge suite";
  return ntfyRequest(topic, `${project}: ${revert.itemId} reverted`, click, "rewind",
    `${revert.itemId} turned ${what} red after it landed (${revert.mergeCommit.slice(0, 12)}). Reverted in ${revert.revertCommit.slice(0, 12)}; a fix task carries the failure.`);
}

// An automatic revert that could not land (src/post-merge.ts): nothing more is
// reverted until a session looks at it, so this one is not left to be missed.
export function revertFailedNotificationRequest(topic: string, origin: string, project: string, failed: { itemId: string; mergeCommit: string; reason: string }): Request {
  const click = new URL(`/p/${encodeURIComponent(project)}/${encodeURIComponent(failed.itemId)}`, new URL(origin).origin).href;
  return ntfyRequest(topic, `${project}: revert of ${failed.itemId} failed`, click, "rotating_light", `${failed.reason} (merge ${failed.mergeCommit.slice(0, 12)})`);
}

// Sends one ntfy message; a refusal or a failed request throws.
export async function sendNotification(request: Request): Promise<void> {
  const response = await fetch(request, { redirect: "error", signal: AbortSignal.timeout(10_000) });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`the notification was refused: ${response.status}`);
}

// One notice sent at most once, for a message that must reach the owner
// without arriving twice. `marks` is the state that outlives the process
// (save writes it). "sending" is saved before the request, so a crash after
// the send and before its outcome is saved leaves it set; a later call finds
// that and sends nothing, calls `unknown` to record that the message may or
// may not have arrived, and keeps the mark "unknown". A request that throws or
// is refused clears the mark, so the caller's retry sends again. With no
// request (no topic configured) nothing is sent and nothing is marked: the
// notice stays pending and goes out once a topic exists.
export interface NoticeMarks { notice?: "sending" | "unknown"; notified?: true }
export async function sendNoticeOnce(marks: NoticeMarks, io: { request: Request | null; save: () => Promise<void>; unknown: () => Promise<void>; deliver?: (request: Request) => Promise<void> }): Promise<"sent" | "done" | "pending" | "unknown"> {
  if (marks.notified) return "done";
  if (marks.notice === "unknown") return "unknown";
  if (marks.notice === "sending") {
    await io.unknown();
    marks.notice = "unknown";
    await io.save();
    return "unknown";
  }
  if (!io.request) return "pending";
  marks.notice = "sending";
  await io.save();
  try { await (io.deliver ?? sendNotification)(io.request); }
  catch (error) { delete marks.notice; await io.save(); throw error; }
  delete marks.notice;
  marks.notified = true;
  await io.save();
  return "sent";
}
