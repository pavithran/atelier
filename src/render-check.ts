// The public pages as a browser renders them, not as text. Cloudflare's
// Browser Run (Browser Rendering until the 2026 rename) loads a page's HTML
// in a headless Chromium and answers, for every box and label of the pages'
// three inline-SVG figures, the geometry the browser laid out; the rules
// below then read that geometry the way a visitor's eye would: a label
// wider than the box it names, boxes that overlap, a figure that shrinks
// instead of scrolling, a bar that no longer wraps. The pages' own tests
// read their HTML as strings; only a browser can fail on a broken diagram.
//
// A browser lives where the BROWSER binding is, in the Worker, and a check
// runs where the code it checks is, in the sandbox container — whose
// Internet is off and holds no credential. So the container renders the
// pages from the pushed tree, POSTs the HTML to the reserved host below,
// and the egress gateway (src/sandbox/runner.ts) answers it here: one
// quickAction scrape per viewport, nothing passed through, nothing kept.
//
// The HTML comes from code in a project's check container, so the browser
// must not become a way out of the sandbox. The page runs with JavaScript
// off and may load nothing but the pages' one Google Fonts stylesheet and
// the font files it names (RENDER_OPTIONS); the answer holds problems built
// from fixed sentences, numbers, and only those labels and class names that
// appear in the HTML the sandbox sent (scrapeProblems), never text the
// browser obtained elsewhere; a request must come from a running check's own
// egress, its body is capped, and each check run may render MAX_RENDERS
// times (renderGateway).

import { FONTS } from "./ui.ts";

// The reserved host the egress gateway answers; .test is reserved by RFC
// 2606, so it can never be a public site the sandbox could otherwise reach.
export const RENDER_HOST = "render.atelier.test";

// /how renders to about 180,000 characters and the showcase to about 95,000;
// twice the larger leaves room to grow without letting a run send megabytes.
export const MAX_HTML = 400_000;
// The JSON body around it: the HTML escaped, plus the page name.
const MAX_BODY = 2 * MAX_HTML;
const PAGES = ["/how", "/showcase"] as const;
export type Page = (typeof PAGES)[number];

// The figures each page must draw, by the class of their <figure>: /how has
// all three (src/how.ts), the showcase the layers one (src/ui.ts). Anything
// else on the page — the cards' own small graphs — is not a diagram.
const FIGURES: [cls: string, name: string][] = [["how-fig", "loop"], ["lay-fig", "layers"], ["pf-fig", "plan-flow"]];
const EXPECTED: Record<Page, string[]> = { "/how": FIGURES.map((f) => f[0]), "/showcase": ["lay-fig"] };

// Boxes that carry a label and belong to nothing but themselves: lanes and
// bands hold nodes, so only nodes may not overlap each other.
const NODE_LIKE = /^(?:hw-node|hw-rec|lay-node|pf-node)(?:\s|$)/;
// All three figures keep this minimum width inside a frame that scrolls
// sideways (how.css, layout.css), so their text never shrinks below its
// designed size on a narrow screen.
const MIN_FIGURE_WIDTH = 880;
const VIEWPORTS = [{ width: 1280, height: 900 }, { width: 375, height: 700 }];
// One check run renders both pages at both viewports: four scrapes. Twice
// that lets the check be re-run once inside the same run; anything beyond is
// refused, so no run can use the browser as an open-ended service.
export const MAX_RENDERS = 2 * PAGES.length * VIEWPORTS.length;

// A label may kiss its box by a few units — font metrics differ a little
// between the browser that renders and the one the drawing was sized in.
const TEXT_TOL = 3;
const BOX_TOL = 3;
const OVERLAP_TOL = 3;
// Enough to say what is broken; a page with more is broken everywhere.
const MAX_PROBLEMS = 40;

// ── what the browser may load ───────────────────────────────────────────────

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

// Every request the page makes is refused except two: the exact stylesheet
// URL src/ui.ts links (FONTS), and font files on fonts.gstatic.com in the
// path shape that stylesheet names. Fonts are kept because the rules measure
// labels in the faces the boxes were sized for; a fallback face is wider or
// narrower and would make the overflow rule wrong. The stylesheet pattern is
// the whole URL, anchored, so the sandbox cannot vary even its query; the
// font files are fixed to one Google host. Everything else — images, frames,
// a meta refresh, CSS url() to any other host — is blocked by the browser.
export const ALLOWED_REQUESTS = [
  `^${escapeRegExp(FONTS)}$`,
  "^https://fonts\\.gstatic\\.com/s/[a-z0-9]+/v[0-9]+/[A-Za-z0-9_-]+\\.woff2$",
];

// The options every scrape is sent with, apart from the HTML, viewport and
// selectors. JavaScript is off, so the page can neither build a URL the
// filter has not seen in the HTML nor move fetched text into the DOM;
// cacheTTL 0 keeps one run's page from being answered to another.
export const RENDER_OPTIONS = {
  setJavaScriptEnabled: false,
  allowRequestPattern: ALLOWED_REQUESTS,
  cacheTTL: 0,
  // networkidle0: the pages' text is measured in the webfonts their <link>
  // names, not in a fallback, before any geometry is read.
  gotoOptions: { waitUntil: "networkidle0" as const, timeout: 45_000 },
};

// ── what a scrape answers ───────────────────────────────────────────────────

// One element Browser Run's /scrape quick action returned: its laid-out box
// in CSS pixels, its text, and its attributes. The subset the rules read;
// the full shape is in worker-configuration.d.ts.
export interface Scraped {
  text?: string;
  html?: string;
  width: number;
  height: number;
  top: number;
  left: number;
  attributes?: { name: string; value: string }[];
}
export interface ScrapeResponse {
  success: boolean;
  result?: { selector: string; results: Scraped[] }[];
  errors?: { message?: string }[];
}

export type RenderScrapeOptions = typeof RENDER_OPTIONS & {
  html: string;
  viewport: { width: number; height: number };
  elements: { selector: string }[];
};
// The binding as this check uses it; wrangler.jsonc's `browser` binding
// provides the whole BrowserRun, of which this is the one method called.
export interface RenderBrowser {
  quickAction(action: "scrape", options: RenderScrapeOptions): Promise<Response>;
}
// The check run's render allowance: take(n) answers whether n more renders
// fit in what the run may still use, and counts them if so.
export interface RenderGrant {
  take(n: number): Promise<boolean>;
}

const SELECTORS = FIGURES.flatMap(([cls]) => [`.${cls} svg`, `.${cls} svg rect`, `.${cls} svg text`]).concat(".public-bar");

const attr = (el: Scraped, name: string) => el.attributes?.find((a) => a.name === name)?.value;
const classOf = (el: Scraped) => attr(el, "class") ?? "";
const NAMED: Record<string, string> = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&", nbsp: " " };
const decode = (s: string) =>
  s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (all, dec, hex, name) =>
    dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(parseInt(hex, 16)) : NAMED[name.toLowerCase()] ?? all);
const asLabel = (markup: string) => decode(markup.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
// A label read from the outer HTML the scrape returns, tags stripped: an SVG
// <text> has no innerText in every browser, and a label misread as empty
// would quietly turn the rules that read it into no rules at all.
const labelOfRead = (el: Scraped) => asLabel(el.html ?? (el.text ?? "").replace(/[<&]/g, (c) => (c === "<" ? "&lt;" : "&amp;")));
// The labels the submitted HTML itself writes, read the same way. Only these
// may be named in an answer: the sandbox already had them, so naming one
// tells it nothing it did not send.
function labelsSent(html: string): Set<string> {
  const labels = new Set<string>();
  for (const m of html.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/gi)) labels.add(asLabel(m[1]));
  return labels;
}
function viewBoxOf(el: Scraped): { w: number; h: number } | null {
  const n = (attr(el, "viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  return n.length === 4 && n.every((v) => Number.isFinite(v)) && n[2] > 0 && n[3] > 0 ? { w: n[2], h: n[3] } : null;
}
const round = (n: number) => Math.round(n * 10) / 10;

// From the svg's rendered box back into the drawing's own units, as SVG
// maps a viewBox onto its viewport: with preserveAspectRatio "none" each
// axis scales by itself; otherwise (the default is "xMidYMid meet") one
// scale serves both, the smaller of the two for meet and the larger for
// slice, and the drawing is placed in the spare room by the align value.
// Coordinates are measured from the viewBox's own corner, so a drawing's
// edges are 0 and its viewBox width or height.
function drawingUnits(svg: Scraped, vb: { w: number; h: number }) {
  const [align = "xMidYMid", mode = "meet"] = (attr(svg, "preserveAspectRatio") ?? "").trim().split(/\s+/).filter(Boolean);
  if (align === "none") {
    const sx = svg.width / vb.w, sy = svg.height / vb.h;
    return (el: Scraped) => ({ x: (el.left - svg.left) / sx, y: (el.top - svg.top) / sy, w: el.width / sx, h: el.height / sy });
  }
  const s = (mode === "slice" ? Math.max : Math.min)(svg.width / vb.w, svg.height / vb.h);
  const fx = /^xMin/.test(align) ? 0 : /^xMax/.test(align) ? 1 : 0.5;
  const fy = /YMin$/.test(align) ? 0 : /YMax$/.test(align) ? 1 : 0.5;
  const ox = (svg.width - vb.w * s) * fx, oy = (svg.height - vb.h * s) * fy;
  return (el: Scraped) => ({ x: (el.left - svg.left - ox) / s, y: (el.top - svg.top - oy) / s, w: el.width / s, h: el.height / s });
}

// ── the rules ───────────────────────────────────────────────────────────────

// What a browser seeing these two scrapes would say is broken, in words that
// name the figure, the label and the amount. Geometry is read from the wide
// scrape; the narrow one answers whether the figures still scroll and the
// public bar still wraps. Empty is the page as a visitor should see it.
//
// `sent` is the HTML the sandbox submitted. A label or class name goes into
// an answer only when that HTML holds it, so whatever else the browser came
// to hold can never be read back through a problem; any other label is
// called "a label" and any other class "an element".
export function scrapeProblems(page: Page, wide: ScrapeResponse, narrow: ScrapeResponse, sent: string): string[] {
  const problems: string[] = [];
  const known = labelsSent(sent);
  const theLabel = (label: string) => (known.has(label) ? `the label "${label}"` : "a label");
  const named = (cls: string) => (/^[A-Za-z0-9_ -]{1,80}$/.test(cls) && sent.includes(cls) ? cls : "an element");
  const found = (s: ScrapeResponse, selector: string) => s.result?.find((g) => g.selector === selector)?.results ?? [];
  for (const cls of EXPECTED[page]) {
    const name = FIGURES.find((f) => f[0] === cls)![1];
    const svgs = found(wide, `.${cls} svg`);
    if (svgs.length !== 1) {
      problems.push(`the ${name} figure is ${svgs.length === 0 ? `missing from ${page}` : `drawn ${svgs.length} times in ${page}`}`);
      continue;
    }
    const svg = svgs[0];
    const vb = viewBoxOf(svg);
    if (!vb) { problems.push(`the ${name} figure carries no viewBox, so its drawing has no scale`); continue; }
    if (svg.width < 2 || svg.height < 2) { problems.push(`the ${name} figure renders ${round(svg.width)}x${round(svg.height)}px, so its stylesheet did not apply`); continue; }
    const box = drawingUnits(svg, vb);
    const rects = found(wide, `.${cls} svg rect`).map((el) => ({ cls: named(classOf(el)), ...box(el) }));
    const texts = found(wide, `.${cls} svg text`).map((el) => ({ cls: named(classOf(el)), label: labelOfRead(el), ...box(el) }));
    for (const r of rects) if (r.w <= 0 || r.h <= 0) problems.push(`in the ${name} figure, a ${r.cls} box renders with nothing in it`);
    // A label belongs to the smallest box its middle falls in: its node when
    // it names one, else its lane, band or frame. With no box around its
    // middle it stands free — a note, a move — and must stay in the drawing.
    const labelOf = new Map<object, string>();
    for (const t of texts) {
      if (!t.label || t.w <= 0 || t.h <= 0) {
        if (t.label) problems.push(`in the ${name} figure, ${theLabel(t.label)} (${t.cls}) renders with nothing in it`);
        continue;
      }
      const cx = t.x + t.w / 2, cy = t.y + t.h / 2;
      const host = rects
        .filter((r) => r.w > 0 && cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h)
        .sort((a, b) => a.w * a.h - b.w * b.h)[0];
      if (host) {
        if (!labelOf.has(host)) labelOf.set(host, t.label);
        const past: [string, number][] = ([
          ["past the left edge of", host.x - t.x], ["past the right edge of", t.x + t.w - (host.x + host.w)],
          ["above", host.y - t.y], ["below", t.y + t.h - (host.y + host.h)],
        ] as [string, number][]).filter((d) => d[1] > TEXT_TOL);
        if (past.length) {
          problems.push(`in the ${name} figure, ${theLabel(t.label)} (${t.cls}) runs ${past.map(([where, d]) => `${round(d)} units ${where} its ${host.cls} box`).join(" and ")}`);
        }
      } else if (t.x < -BOX_TOL || t.y < -BOX_TOL || t.x + t.w > vb.w + BOX_TOL || t.y + t.h > vb.h + BOX_TOL) {
        problems.push(`in the ${name} figure, ${theLabel(t.label)} (${t.cls}) falls outside the drawing`);
      }
    }
    const nodes = rects.filter((r) => NODE_LIKE.test(r.cls));
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (ox > OVERLAP_TOL && oy > OVERLAP_TOL) {
          const said = (r: object, other: string) => (known.has(labelOf.get(r) ?? "") ? `"${labelOf.get(r)}"` : other);
          const la = said(a, "one"), lb = said(b, "another");
          problems.push(`in the ${name} figure, the boxes of ${la} and ${lb} (${a.cls}) overlap by ${round(ox)}x${round(oy)} units`);
        }
      }
    }
    const narrowSvg = found(narrow, `.${cls} svg`)[0];
    if (narrowSvg && narrowSvg.width < MIN_FIGURE_WIDTH - 1) {
      problems.push(`the ${name} figure is ${round(narrowSvg.width)}px wide on a 375px screen, under the ${MIN_FIGURE_WIDTH}px its scroll frame holds, so it would shrink instead of scroll`);
    }
  }
  const wideBar = found(wide, ".public-bar")[0], narrowBar = found(narrow, ".public-bar")[0];
  if (wideBar && narrowBar && narrowBar.height <= wideBar.height + 0.5) {
    problems.push("the public bar is as tall on a 375px screen as on a 1280px one, so it no longer wraps");
  }
  return problems.length > MAX_PROBLEMS
    ? [...problems.slice(0, MAX_PROBLEMS), `and ${problems.length - MAX_PROBLEMS} more problems`]
    : problems;
}

// ── the gateway the sandbox calls ───────────────────────────────────────────

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// The body, read no further than `limit` bytes; null when it is longer.
async function readCapped(request: Request, limit: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > limit) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return new TextDecoder().decode(all);
}

// Answered only from inside a running check's container, through the egress
// gateway, which passes the run's allowance as `grant`; anything else
// (`grant` null) is refused, and no public route reaches this. GET says the
// check may render; POST /check renders one page at two viewports, if the
// run's allowance still holds two renders, and answers the problems.
//
// The answers carry no free text from the browser: a failed render says
// only its status, so neither an error page nor a message Browser Run built
// from what the page loaded can reach the sandbox.
export async function renderGateway(browser: RenderBrowser | undefined, request: Request, grant: RenderGrant | null): Promise<Response> {
  if (!grant) return reply(403, { error: "not_a_check", detail: "the render gateway answers only a running check's own sandbox" });
  const url = new URL(request.url);
  if (request.method === "GET" || request.method === "HEAD") {
    return reply(200, { render: "browser-run", pages: PAGES, viewports: VIEWPORTS, renders: MAX_RENDERS });
  }
  if (request.method !== "POST") {
    return reply(405, { error: "method", detail: "the render gateway answers GET, to ask whether it is there, and POST /check" });
  }
  if (url.pathname !== "/check") return reply(404, { error: "not_found", detail: "the render gateway answers POST /check" });
  const text = await readCapped(request, MAX_BODY);
  if (text === null) return reply(413, { error: "too_long", detail: `the body is longer than ${MAX_BODY} bytes` });
  let body: { page?: unknown; html?: unknown };
  try {
    body = JSON.parse(text) as { page?: unknown; html?: unknown };
  } catch {
    return reply(400, { error: "bad_body", detail: "POST /check takes JSON: { page, html }" });
  }
  const page = body?.page;
  if (page !== "/how" && page !== "/showcase") {
    return reply(400, { error: "bad_page", detail: `page must be ${PAGES.map((p) => `"${p}"`).join(" or ")}` });
  }
  if (typeof body.html !== "string" || !body.html.trim()) {
    return reply(400, { error: "bad_html", detail: "html must be the page's HTML, rendered from the pushed tree" });
  }
  if (body.html.length > MAX_HTML) {
    return reply(413, { error: "too_long", detail: `html is longer than ${MAX_HTML} characters; a public page is under half that` });
  }
  const html = body.html;
  if (!browser) return reply(503, { error: "no_browser", detail: "this Worker has no browser binding, so no page can be rendered" });
  if (!(await grant.take(VIEWPORTS.length))) {
    return reply(429, { error: "render_limit", detail: `this check run has used its ${MAX_RENDERS} renders` });
  }
  const scrapes: ScrapeResponse[] = [];
  for (const viewport of VIEWPORTS) {
    let res: Response;
    try {
      res = await browser.quickAction("scrape", { ...RENDER_OPTIONS, html, viewport, elements: SELECTORS.map((selector) => ({ selector })) });
    } catch {
      return reply(502, { error: "browser", detail: `Browser Run could not render ${page}` });
    }
    if (res.status === 429) {
      await res.body?.cancel();
      return reply(429, { error: "browser_busy", detail: "Browser Run is at its limit; run the check again in a moment" });
    }
    if (!res.ok) {
      await res.body?.cancel();
      return reply(502, { error: "browser", detail: `Browser Run answered ${res.status} for ${page}` });
    }
    let data: ScrapeResponse;
    try {
      data = (await res.json()) as ScrapeResponse;
    } catch {
      return reply(502, { error: "browser", detail: `Browser Run answered nothing readable for ${page}` });
    }
    if (!data?.success) return reply(502, { error: "browser", detail: `Browser Run did not render ${page}` });
    scrapes.push(data);
  }
  return reply(200, { page, problems: scrapeProblems(page, scrapes[0], scrapes[1], html) });
}
