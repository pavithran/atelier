// The work as a graph: a project's main line, and a thread for every task an
// agent took, from its claim to its merge or closure, with a bead for each
// push, check, review and decision. Pure functions over the Ledger's items and
// events, so the pages that draw it and the tests that check it read the same
// model. Drawing is server-side SVG; the replay is CSS animation, because the
// pages carry no script.

import type { LedgerEvent } from "./ledger.ts";
import type { Item } from "./rules.ts";
import { splitActor } from "./floor.ts";

export type Vendor = "anthropic" | "openai" | "zai" | "studio" | "google" | "owner" | "other";

// Which family an actor belongs to, by the harness it runs in. The colour is
// the vendor's, so a reader can see a thread change hands between companies.
// Atelier records some events itself: checks its sandbox ran, pushes it saw.
// They are the platform's work, not an agent's, and are never counted as moves.
export const isAtelier = (actor: string) => actor.startsWith("atelier/");

export function vendorOf(actor: string, owner: string): Vendor {
  if (actor === owner) return "owner";
  const { harness, model } = splitActor(actor);
  const h = harness.toLowerCase(), m = model.toLowerCase();
  if (h === "claude-code" || m.startsWith("claude") || m.startsWith("opus") || m.startsWith("sonnet")) return "anthropic";
  if (h === "codex" || m.startsWith("gpt")) return "openai";
  if (h === "opencode") return "studio";
  if (h === "zcode" || m.startsWith("glm")) return "zai";
  if (h === "gemini" || h === "antigravity" || m.startsWith("gemini")) return "google";
  return "other";
}

export type BeadKind = "push" | "pass" | "fail" | "reported" | "submit" | "approve" | "reject" | "handoff" | "accept" | "dispatch";

export interface Bead { pos: number; kind: BeadKind; actor: string; at: string; label: string }
export interface Hold { who: string; pos: number }
export interface Thread {
  id: string;
  title: string;
  state: Item["state"];
  start: number;               // position of the first claim
  end: number | null;          // position of the merge or closure; null while live
  ending: "merged" | "closed" | null;
  holds: Hold[];               // who held it, from which position
  beads: Bead[];
  merge?: { pos: number; sha: string };
}
export interface Moment { pos: number; at: string; actor: string; item: string; kind: string; text: string; tone: "catch" | "you" | "merge" | "" }
export interface Tally {
  agentMoves: number;
  decisions: number;
  checks: number;
  inCloud: number;
  sentBack: number;
  agents: string[];            // every agent that acted, first appearance first
  byVendor: Partial<Record<Vendor, number>>;
  planned: number; claims: number; handoffs: number; pushes: number;
  approvals: number; accepts: number; merges: number;
}
export interface Story {
  project: string;
  title: string;               // what the pages call the project
  partial: boolean;            // the record was cut at the read limit; older tasks are not drawn
  span: number;                // the last position; positions run from 0
  times: { pos: number; at: string }[];
  threads: Thread[];
  moments: Moment[];
  tally: Tally;
}

// Bookkeeping takes a quarter step on the axis so the work gets the width.
const QUIET = new Set(["item.created", "fork.created", "item.undispatched", "item.released"]);
const DECISIONS = new Set(["item.accepted", "item.abandoned", "item.handoff", "item.dispatched"]);

export function emptyTally(): Tally {
  return { agentMoves: 0, decisions: 0, checks: 0, inCloud: 0, sentBack: 0, agents: [], byVendor: {},
    planned: 0, claims: 0, handoffs: 0, pushes: 0, approvals: 0, accepts: 0, merges: 0 };
}

export function addTally(a: Tally, b: Tally): Tally {
  const byVendor = { ...a.byVendor };
  for (const [k, n] of Object.entries(b.byVendor)) byVendor[k as Vendor] = (byVendor[k as Vendor] ?? 0) + (n ?? 0);
  const sum = (k: keyof Tally) => (a[k] as number) + (b[k] as number);
  return {
    agentMoves: sum("agentMoves"), decisions: sum("decisions"), checks: sum("checks"), inCloud: sum("inCloud"),
    sentBack: sum("sentBack"), agents: [...new Set([...a.agents, ...b.agents])], byVendor,
    planned: sum("planned"), claims: sum("claims"), handoffs: sum("handoffs"), pushes: sum("pushes"),
    approvals: sum("approvals"), accepts: sum("accepts"), merges: sum("merges"),
  };
}

const sha8 = (v: unknown) => (typeof v === "string" ? v.slice(0, 8) : "");
const str = (v: unknown) => (typeof v === "string" ? v : "");
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

// For a public page: what an agent or the owner wrote (review notes, reports,
// check commands, closing notes) is left out, and the owner is named rather
// than addressed. Titles, models, kinds and times stay.
export interface StoryOptions { redact?: boolean; ownerLabel?: string }

export function buildStory(project: string, items: Item[], events: LedgerEvent[], owner: string, partial = false, title = project, opts: StoryOptions = {}): Story {
  const R = !!opts.redact;
  const you = opts.ownerLabel ?? "You";
  const evs = [...events].sort((a, b) => a.seq - b.seq);
  const posOf = new Map<number, number>();
  let p = 0;
  evs.forEach((ev, i) => { if (i) p += QUIET.has(ev.kind) ? 0.25 : 1; posOf.set(ev.seq, p); });
  const span = Math.max(p, 1);
  const titles = new Map(items.map((i) => [i.id, i]));
  const threads = new Map<string, Thread>();
  const moments: Moment[] = [];
  const t = emptyTally();
  const seen = new Set<string>();

  for (const ev of evs) {
    const pos = posOf.get(ev.seq)!;
    const d = ev.data ?? {};
    const id = ev.itemId ?? "";
    const item = titles.get(id);
    const holder = threads.get(id)?.holds.at(-1)?.who;
    // An event Atelier recorded is told, and coloured, as part of the holder's thread.
    const actor = isAtelier(ev.actor) && holder ? holder : ev.actor;
    const name = (a: string) => (a === owner ? you : isAtelier(a) ? "Atelier" : splitActor(a).model || a);
    const say = (text: string, tone: Moment["tone"] = "") => moments.push({ pos, at: ev.at, actor: ev.actor, item: id, kind: ev.kind, text, tone });

    if (ev.actor === owner) { if (DECISIONS.has(ev.kind)) t.decisions++; }
    else if (!QUIET.has(ev.kind) && !isAtelier(ev.actor)) {
      t.agentMoves++;
      const v = vendorOf(ev.actor, owner);
      t.byVendor[v] = (t.byVendor[v] ?? 0) + 1;
      if (!seen.has(ev.actor)) { seen.add(ev.actor); t.agents.push(ev.actor); }
    }

    let th = threads.get(id);
    const bead = (kind: BeadKind, label: string) => th?.beads.push({ pos, kind, actor, at: ev.at, label });
    switch (ev.kind) {
      case "item.created": t.planned++; break;
      case "item.claimed":
        t.claims++;
        if (!th) {
          th = { id, title: item?.title ?? id, state: item?.state ?? "claimed", start: pos, end: null, ending: null, holds: [], beads: [] };
          threads.set(id, th);
        }
        if (th.holds.at(-1)?.who !== ev.actor) th.holds.push({ who: ev.actor, pos });
        if (th.end !== null) { th.end = null; th.ending = null; }
        say(`${name(ev.actor)} took ${id}`);
        break;
      case "item.handoff": {
        t.handoffs++;
        const to = str(d.to);
        if (th && to && th.holds.at(-1)?.who !== to) th.holds.push({ who: to, pos });
        bead("handoff", `Handed from ${name(str(d.from))} to ${name(to)}`);
        say(`${id} handed from ${name(str(d.from))} to ${name(to)}`);
        break;
      }
      case "push.observed": t.pushes++; bead("push", `${name(actor)} pushed ${sha8(d.head)}`); break;
      case "evidence.observed": {
        t.checks++;
        if (d.where === "sandbox") t.inCloud++;
        const where = d.where === "sandbox" ? "in a Cloudflare container" : "on the agent's machine";
        if (d.passed === false) { bead("fail", R ? `Failed ${where}` : `Failed ${where}: ${str(d.claim)}`); say(`A check on ${id} failed ${where}`, "catch"); }
        else bead("pass", R ? `Passed ${where}` : `Passed ${where}: ${str(d.claim)}`);
        break;
      }
      case "evidence.reported": bead("reported", R ? `${name(ev.actor)} reported on its work` : `${name(ev.actor)} reported: ${clip(str(d.claim), 160)}`); break;
      case "item.submitted": bead("submit", `${name(ev.actor)} submitted ${sha8(d.head)}`); say(`${name(ev.actor)} submitted ${id} for review`); break;
      case "review.approved": t.approvals++; bead("approve", `${name(ev.actor)} approved`); break;
      case "review.rejected":
        t.sentBack++;
        bead("reject", R ? `${name(ev.actor)} sent it back` : `${name(ev.actor)} sent it back: ${clip(str(d.note), 220)}`);
        say(R ? `${name(ev.actor)} sent ${id} back` : `${name(ev.actor)} sent ${id} back: ${clip(str(d.note), 180)}`, "catch");
        break;
      case "item.accepted": t.accepts++; bead("accept", `${name(ev.actor)} accepted ${sha8(d.head)}`); say(`${name(ev.actor)} accepted ${id}`, ev.actor === owner ? "you" : ""); break;
      case "item.dispatched": say(`${name(ev.actor)} sent ${id} to ${str(d.to) === "any" ? "any runner" : `a ${str(d.to)} runner`}`, ev.actor === owner ? "you" : ""); break;
      case "item.merged":
        // Only a merge whose thread is drawn is counted, so the numbers match the picture.
        if (th) { t.merges++; th.end = pos; th.ending = "merged"; th.merge = { pos, sha: str(d.mergeCommit) }; }
        say(`${id} merged into main${d.mergeCommit ? ` as ${sha8(d.mergeCommit)}` : ""}`, "merge");
        break;
      case "item.abandoned":
        if (th) { th.end = pos; th.ending = "closed"; }
        say(`${name(ev.actor)} closed ${id}${d.note && !R ? `: ${clip(str(d.note), 140)}` : ""}`, ev.actor === owner ? "you" : "");
        break;
    }
  }
  for (const th of threads.values()) th.state = titles.get(th.id)?.state ?? th.state;

  const times = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const target = f * span;
    let best = evs[0];
    for (const ev of evs) if (posOf.get(ev.seq)! <= target) best = ev;
    return { pos: best ? posOf.get(best.seq)! : 0, at: best?.at ?? "" };
  });
  return { project, title, partial, span, times, threads: [...threads.values()].sort((a, b) => a.start - b.start), moments, tally: t };
}

// ── drawing ────────────────────────────────────────────────────────────────

export interface DrawOptions {
  compact?: boolean;           // the Decisions page's version: no hashes, no clock
  replaySeconds?: number;      // how long the draw-in takes; 0 draws it at rest
  href?: (thread: Thread) => string;
  ownerLabel?: string;         // how the owner is named in cards; "you" on the owner's own pages
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const r1 = (n: number) => Math.round(n * 10) / 10;

// Hover cards. A card is drawn last, above every thread, and shown by CSS
// when its mark is hovered or focused: :has() ties the two together, since
// SVG has no z-index and the pages carry no script. Each drawing gets its own
// id prefix so two graphs on a page never share a card.
let drawings = 0;
const CHAR_W = 6.7;           // IBM Plex Mono at 11px, per character, near enough for a card's width
// Words into at most `lines` lines of `width` characters; the last line ends in
// an ellipsis when text is left over.
export function wrap(s: string, width: number, lines: number): string[] {
  const out: string[] = [];
  let line = "", rest = false;
  for (const w of s.split(/\s+/).filter(Boolean)) {
    if (!line) line = w;
    else if (line.length + 1 + w.length <= width) line += " " + w;
    else if (out.length + 1 < lines) { out.push(line); line = w; }
    else { rest = true; break; }
  }
  if (line) out.push(line);
  if (rest) {
    // Drop whole words until the ellipsis fits; a single long word is cut instead.
    let last = out[out.length - 1];
    while (last.length + 1 > width && last.includes(" ")) last = last.slice(0, last.lastIndexOf(" "));
    out[out.length - 1] = last.length + 1 > width ? clip(last, width) : last + "…";
  }
  return out.map((l) => clip(l, width));
}

interface Card { key: string; x: number; y: number; head: string; body: string; color: string }

function drawCard(k: Card, W: number, H: number): string {
  const lines = wrap(k.body, 46, 3);
  const w = Math.max(k.head.length, ...lines.map((l) => l.length)) * CHAR_W + 24;
  const h = 26 + lines.length * 16;
  const left = k.x + 14 + w > W - 4 ? k.x - 14 - w : k.x + 14;
  const top = Math.min(Math.max(k.y - h / 2, 4), H - h - 4);
  return `<g class="g-card" data-card="${k.key}" style="--c:${k.color}" transform="translate(${r1(left)} ${r1(top)})" aria-hidden="true">`
    + `<rect width="${r1(w)}" height="${h}" rx="7"/>`
    + `<text class="g-card-head" x="12" y="18">${esc(k.head)}</text>`
    + lines.map((l, i) => `<text class="g-card-body" x="12" y="${36 + i * 16}">${esc(l)}</text>`).join("")
    + `</g>`;
}

export function drawStory(s: Story, owner: string, o: DrawOptions = {}): string {
  const id = `g${(++drawings).toString(36)}`;
  const cards: Card[] = [];
  const W = o.compact ? 760 : 1200, X0 = o.compact ? 46 : 64, MAIN = o.compact ? 26 : 50;
  const R = o.compact ? 18 : 26, X1 = W - R - 34;   // room for the last merge to curve home
  const LANE = o.compact ? 20 : 30, TOP = MAIN + (o.compact ? 34 : 46);
  const H = TOP + Math.max(s.threads.length - 1, 0) * LANE + (o.compact ? 22 : 30);
  const x = (pos: number) => r1(X0 + (pos / s.span) * (X1 - X0));
  const T = o.replaySeconds ?? 9;
  const at = (pos: number) => `${r1((pos / s.span) * T)}s`;
  const len = (a: number, b: number) => `${r1(Math.max(((b - a) / s.span) * T, 0.15))}s`;
  const c = (actor: string) => `var(--m-${vendorOf(actor, owner)})`;
  const out: string[] = [];

  if (!o.compact) {
    for (const tm of s.times) {
      const X = x(tm.pos);
      out.push(`<line class="g-grid" x1="${X}" x2="${X}" y1="14" y2="${H - 6}"/>`);
      const anchor = X > X1 - 40 ? "end" : X < X0 + 40 ? "start" : "middle";
      if (tm.at) out.push(`<text class="g-clock" x="${X}" y="10" text-anchor="${anchor}">${esc(tm.at.slice(5, 10).replace("-", "/"))} ${esc(tm.at.slice(11, 16))}</text>`);
    }
  }
  out.push(`<text class="g-name main-name" x="${X0 - 12}" y="${MAIN + 4}" text-anchor="end">main</text>`);
  out.push(`<path class="g-main draw" pathLength="1" d="M${X0} ${MAIN}H${X1 + 10}" style="--d:0s;--l:${T}s"/>`);

  let lastLabel = -Infinity;
  s.threads.forEach((th, k) => {
    const y = TOP + k * LANE;
    const xs = x(th.start);
    const end = th.end ?? s.span;
    const xe = th.end === null ? X1 + 6 : x(end);
    const closed = th.ending === "closed";
    const live = th.end === null;
    const segs = th.holds.map((h, i) => ({ who: h.who, from: i ? h.pos : th.start, to: th.holds[i + 1]?.pos ?? end }));
    const g: string[] = [];
    g.push(`<path class="g-thread draw" pathLength="1" style="--c:${c(segs[0].who)};--d:${at(th.start)};--l:0.35s" d="M${r1(xs - R)} ${MAIN}C${xs} ${MAIN} ${r1(xs - R)} ${y} ${xs} ${y}"/>`);
    for (const sg of segs) {
      const a = Math.max(x(sg.from), xs), b = sg.to === end ? xe : x(sg.to);
      if (b > a) g.push(`<path class="g-thread g-lane draw" pathLength="1" style="--c:${c(sg.who)};--d:${at(sg.from)};--l:${len(sg.from, sg.to)}" d="M${a} ${y}H${b}"/>`);
    }
    const lastWho = segs.at(-1)!.who;
    if (th.ending === "merged") {
      g.push(`<path class="g-thread draw" pathLength="1" style="--c:${c(lastWho)};--d:${at(end)};--l:0.35s" d="M${xe} ${y}C${r1(xe + R)} ${y} ${xe} ${MAIN} ${r1(xe + R)} ${MAIN}"/>`);
    } else if (closed) {
      g.push(`<path class="g-cap pop" style="--d:${at(end)}" d="M${xe} ${y - 6}V${y + 6}"/>`);
    } else {
      g.push(`<circle class="g-head pop" style="--c:${c(lastWho)};--d:${at(end)}" cx="${xe}" cy="${y}" r="4.5"/>`);
    }
    th.beads.forEach((b, i) => {
      const key = `${id}-${k}-${i}`;
      g.push(bead(b, x(b.pos), y, at(b.pos), c(b.actor), key));
      cards.push({ key, x: x(b.pos), y, color: c(b.actor), head: `${b.at.slice(5, 10).replace("-", "/")} ${b.at.slice(11, 16)} · ${th.id} · ${BEAD_NAMES[b.kind]}`, body: b.label });
    });
    const holders = th.holds.map((h) => (h.who === owner ? (o.ownerLabel ?? "you") : splitActor(h.who).model || h.who)).join(" → ");
    const tkey = `${id}-${k}`;
    cards.push({ key: tkey, x: X0 - 4, y, color: c(th.holds[0].who), head: `${th.id} · ${STATE_NAMES[th.state] ?? th.state} · ${holders}`, body: th.title });
    const label = `<text class="g-name" x="${X0 - 12}" y="${y + 4}" text-anchor="end" style="fill:${c(th.holds[0].who)}">${esc(th.id)}</text>`;
    const title = `<title>${esc(`${th.id} · ${th.title} · ${holders}`)}</title>`;
    // A wide, invisible band along the lane makes the whole thread easy to point at.
    const band = `<rect class="g-band" data-key="${tkey}" x="${r1(xs - 4)}" y="${y - LANE / 2}" width="${r1(xe - xs + 8)}" height="${LANE}"/>`;
    out.push(`<g class="g-task${closed ? " closed" : ""}${live ? " live" : ""}" data-task="${tkey}">${title}${band}${o.href ? `<a href="${esc(o.href(th))}" data-key="${tkey}">${label}</a>` : label}${g.join("")}</g>`);
    if (th.merge) {
      const mx = r1(xe + R);
      out.push(`<g class="pop" style="--d:${at(end)}"><circle class="g-merge" cx="${mx}" cy="${MAIN}" r="${o.compact ? 4 : 5.5}"><title>${esc(`${th.id} merged as ${th.merge.sha.slice(0, 12)}`)}</title></circle>${
        !o.compact && th.merge.sha && mx - lastLabel > 62 ? `<text class="g-sha" x="${mx}" y="${MAIN - 11}" text-anchor="middle">${esc(th.merge.sha.slice(0, 7))}</text>` : ""}</g>`);
      if (!o.compact && th.merge.sha && mx - lastLabel > 62) lastLabel = mx;
    }
  });

  // One rule per card: show it while its mark or task label is hovered or focused.
  const rules = cards.map((k) => `.graph:has([data-key="${k.key}"]:hover,[data-key="${k.key}"]:focus-visible) [data-card="${k.key}"]`).join(",");
  out.push(`<style>${rules ? `${rules}{opacity:1}` : ""}</style><g class="g-cards">${cards.map((k) => drawCard(k, W, H)).join("")}</g>`);
  return `<svg class="graph${o.compact ? " compact" : ""}" id="${id}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${s.title}: ${s.threads.length} tasks taken by agents, ${s.tally.merges} merged into main`)}">${out.join("")}</svg>`;
}

const BEAD_NAMES: Record<BeadKind, string> = {
  push: "pushed", pass: "check passed", fail: "check failed", reported: "reported", submit: "submitted",
  approve: "approved", reject: "sent back", handoff: "handed off", accept: "accepted", dispatch: "dispatched",
};
const STATE_NAMES: Record<string, string> = {
  open: "open", claimed: "in progress", submitted: "in review", accepted: "accepted", merged: "merged", abandoned: "closed",
};

function bead(b: Bead, X: number, y: number, d: string, color: string, key: string): string {
  // Each mark is focusable, so a keyboard reaches the same card a pointer does;
  // its accessible name is the card's text.
  const name = esc(`${b.at.slice(0, 16).replace("T", " ")} UTC, ${BEAD_NAMES[b.kind]}: ${b.label}`);
  const open = (cls: string, style = "") => `<g class="g-bead pop ${cls}" style="--d:${d}${style}" transform="translate(${X} ${y})" data-key="${key}" tabindex="0" role="img" aria-label="${name}"><circle class="hit" r="10"/>`;
  switch (b.kind) {
    case "push": return `${open("push")}<path d="M0 -6V6"/></g>`;
    case "pass": return `${open("pass")}<circle r="3.6"/></g>`;
    case "fail": return `${open("fail")}<path d="M-4 -4L4 4M4 -4L-4 4"/></g>`;
    case "reported": return `${open("reported")}<circle r="3.6"/></g>`;
    case "submit": return `${open("submit")}<path d="M0 -5L5 0L0 5L-5 0Z"/></g>`;
    case "approve": return `${open("approve", `;--c:${color}`)}<path d="M-5 3.5L0 -5.5L5 3.5Z"/></g>`;
    case "reject": return `${open("reject", `;--c:${color}`)}<circle class="ring" r="8"/><path d="M-4.5 -3L0 5.5L4.5 -3Z"/></g>`;
    case "handoff": return `${open("handoff")}<path d="M-6 -4L0 0L-6 4M0 -4L6 0L0 4"/></g>`;
    case "accept": return `${open("accept")}<circle r="5.5"/></g>`;
    default: return "";
  }
}

// Every vendor that appears in a story, for its legend, in a fixed order.
export const VENDOR_NAMES: [Vendor, string][] = [
  ["anthropic", "Claude"], ["openai", "GPT via Codex"], ["zai", "GLM via ZCode"],
  ["studio", "Local, on your Studio"], ["google", "Gemini"], ["other", "Other agents"], ["owner", "You"],
];
