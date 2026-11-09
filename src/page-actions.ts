// The owner's page actions (t594): the guard every one runs first, and the
// Land form that Today's cards and the task page's verdict block draw.
//
// ownerPageAct: a page action needs a session on a server with Cloudflare
// Access. The owner bearer token alone is refused, so the token an agent could
// hold cannot press a button; an Access assertion without a session is sent to
// /login by the entry before it gets here. The CSRF defence stays what it was:
// the Origin check every owner form makes, and the session cookie's
// SameSite=Strict. What a page draws is derived from this guard's answer
// (pageActsFor), never from a field the caller sent.
import { RuleError } from "./rules.ts";
import { EASTERN } from "./now.ts";

export function pageActsFor(c: { signedIn?: boolean; access?: boolean }): boolean {
  return c.signedIn === true && c.access === true;
}

export function ownerPageAct(c: { signedIn?: boolean; access?: boolean }): void {
  if (pageActsFor(c)) return;
  throw new RuleError("owner_session_required", "a page action needs the developer's own session on a server behind Cloudflare Access; the developer token alone cannot press a button", 403, "open the page signed in through Cloudflare Access, then press the button there");
}

const e = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// "HH:MM", Eastern.
export function easternClock(at: string): string {
  const ps = new Intl.DateTimeFormat("en-US", { timeZone: EASTERN, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(at));
  return `${ps.find((p) => p.type === "hour")?.value ?? "00"}:${ps.find((p) => p.type === "minute")?.value ?? "00"}`;
}

export const landAction = (project: string, id: string) => `/ui/${encodeURIComponent(project)}/${encodeURIComponent(id)}/land`;

// The owner calls a Land form is drawn for: the revision is ready to land, or
// ready to accept.
export const LAND_CALLS: ReadonlySet<string> = new Set(["land", "accept"]);

export interface LandView {
  project: string;
  id: string;
  head: string;
  criteria: string;
  // Where a success returns: Today's front page, or the task's own page.
  back: "today" | "task";
  // The guard's answer for this request; without it only the facts are drawn.
  act: { newId: () => string; nonce?: string } | null;
  // A landing waiting at this head, since when.
  queuedAt: string | null;
  // A landing that failed at this head: the step it failed at.
  failedStep: string | null;
  // The head a dropped or waiting job was queued at, when the task has moved on.
  movedFrom: string | null;
  // The refusal of the last attempt, drawn beside the form (already escaped).
  error?: string;
}

const short = (h: string) => h.slice(0, 8);

// Sets a pressed Land button aside so a double click makes one request. It
// runs under the page's nonce, the one script its policy admits.
export function landOnceScript(nonce: string | undefined): string {
  if (!nonce) return "";
  return `<script nonce="${e(nonce)}">document.addEventListener("submit",function(ev){var f=ev.target;if(f&&f.getAttribute&&f.getAttribute("data-once")!==null){var b=f.querySelector("button");if(b)b.disabled=true;}});</script>`;
}

export function landBlock(v: LandView): string {
  const form = (label: string) => v.act
    ? `<form class="land-form" method="post" action="${e(landAction(v.project, v.id))}" data-once><input type="hidden" name="head" value="${e(v.head)}"><input type="hidden" name="criteria" value="${e(v.criteria)}"><input type="hidden" name="request" value="${e(v.act.newId())}"><input type="hidden" name="back" value="${v.back}"><button class="primary">${e(label)}</button>${v.error ?? ""}</form>${landOnceScript(v.act.nonce)}`
    : "";
  if (v.queuedAt) return `<p class="land-state land-queued">${v.back === "today" ? "Queued to land" : `Landing queued since ${e(easternClock(v.queuedAt))}`}</p>`;
  const notes = [
    v.movedFrom ? `<p class="land-state land-moved">The head moved from ${e(short(v.movedFrom))} to ${e(short(v.head))} after the landing was queued, so that landing was dropped. Land the new head.</p>` : "",
    v.failedStep ? `<p class="land-state land-failed">The landing failed at its ${e(v.failedStep)} step at this head. Landing again queues it once more.</p>` : "",
  ].join("");
  return `${notes}${form(v.failedStep ? "Land again" : "Land")}`;
}
