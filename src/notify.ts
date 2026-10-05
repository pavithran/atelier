import { briefFor } from "./brief.ts";
import type { Detail } from "./ui.ts";

export function notificationRequest(topic: string, origin: string, project: string, detail: Detail): Request {
  const title = `Atelier: ${detail.item.title}`.replace(/[\u0000-\u001f\u007f]/g, " ");
  // ntfy accepts RFC 2047 encoded headers. Keep Unicode titles intact.
  const encoded = btoa(Array.from(new TextEncoder().encode(title), (b) => String.fromCharCode(b)).join(""));
  return new Request(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
    method: "POST",
    headers: {
      Title: `=?UTF-8?B?${encoded}?=`,
      Click: new URL(`/p/${encodeURIComponent(project)}/${encodeURIComponent(detail.item.id)}`, new URL(origin).origin).href,
      Tags: "inbox_tray",
      Priority: "default",
      "Content-Type": "text/plain; charset=utf-8",
    },
    body: Array.from(briefFor(detail).decided.replace(/[\r\n\u2028\u2029]/g, " ")).slice(0, 500).join(""),
  });
}
