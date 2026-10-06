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
