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

// The reserved host the egress gateway answers; .test is reserved by RFC
// 2606, so it can never be a public site the sandbox could otherwise reach.
export const RENDER_HOST = "render.atelier.test";

const MAX_HTML = 1_500_000;
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

// A label may kiss its box by a few units — font metrics differ a little
// between the browser that renders and the one the drawing was sized in.
const TEXT_TOL = 3;
const BOX_TOL = 3;
const OVERLAP_TOL = 3;

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

export interface RenderScrapeOptions {
  html: string;
  viewport: { width: number; height: number };
  elements: { selector: string }[];
  gotoOptions?: { waitUntil?: string | string[]; timeout?: number };
}
// The binding as this check uses it; wrangler.jsonc's `browser` binding
// provides the whole BrowserRun, of which this is the one method called.
export interface RenderBrowser {
  quickAction(action: "scrape", options: RenderScrapeOptions): Promise<Response>;
}

const SELECTORS = FIGURES.flatMap(([cls]) => [`.${cls} svg`, `.${cls} svg rect`, `.${cls} svg text`]).concat(".public-bar");

const classOf = (el: Scraped) => el.attributes?.find((a) => a.name === "class")?.value ?? "";
// A label read from the outer HTML the scrape returns, tags stripped: an SVG
// <text> has no innerText in every browser, and a label misread as empty
// would quietly turn the rules that read it into no rules at all.
function labelOfRead(el: Scraped): string {
  const raw = el.html
    ? el.html.replace(/<[^>]*>/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
    : el.text ?? "";
  return raw.replace(/\s+/g, " ").trim();
}
function viewBoxOf(el: Scraped): { w: number; h: number } | null {
  const raw = el.attributes?.find((a) => a.name === "viewBox")?.value;
  const n = (raw ?? "").trim().split(/[\s,]+/).map(Number);
  return n.length === 4 && n.every((v) => Number.isFinite(v)) ? { w: n[2], h: n[3] } : null;
}
const round = (n: number) => Math.round(n * 10) / 10;

// ── the rules ───────────────────────────────────────────────────────────────

// What a browser seeing these two scrapes would say is broken, in words that
// name the figure, the label and the amount. Geometry is read from the wide
// scrape; the narrow one answers whether the figures still scroll and the
// public bar still wraps. Empty is the page as a visitor should see it.
export function scrapeProblems(page: Page, wide: ScrapeResponse, narrow: ScrapeResponse): string[] {
  const problems: string[] = [];
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
    // Back into the drawing's own units, where the boxes were sized: one CSS
    // pixel is viewBox-width-over-rendered-width drawing units.
    const per = vb.w / svg.width;
    const box = (el: Scraped) => ({ x: (el.left - svg.left) * per, y: (el.top - svg.top) * per, w: el.width * per, h: el.height * per });
    const rects = found(wide, `.${cls} svg rect`).map((el) => ({ cls: classOf(el), ...box(el) }));
    const texts = found(wide, `.${cls} svg text`).map((el) => ({ cls: classOf(el), label: labelOfRead(el), ...box(el) }));
    for (const r of rects) if (r.w <= 0 || r.h <= 0) problems.push(`in the ${name} figure, a ${r.cls} box renders with nothing in it`);
    // A label belongs to the smallest box its middle falls in: its node when
    // it names one, else its lane, band or frame. With no box around its
    // middle it stands free — a note, a move — and must stay in the drawing.
    const labelOf = new Map<object, string>();
    for (const t of texts) {
      if (!t.label || t.w <= 0 || t.h <= 0) {
        if (t.label) problems.push(`in the ${name} figure, the label "${t.label}" (${t.cls}) renders with nothing in it`);
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
          problems.push(`in the ${name} figure, the label "${t.label}" (${t.cls}) runs ${past.map(([where, d]) => `${round(d)} units ${where} its ${host.cls} box`).join(" and ")}`);
        }
      } else if (t.x < -BOX_TOL || t.y < -BOX_TOL || t.x + t.w > vb.w + BOX_TOL || t.y + t.h > vb.h + BOX_TOL) {
        problems.push(`in the ${name} figure, the label "${t.label}" (${t.cls}) falls outside the drawing`);
      }
    }
    const nodes = rects.filter((r) => NODE_LIKE.test(r.cls));
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (ox > OVERLAP_TOL && oy > OVERLAP_TOL) {
          const la = labelOf.get(a) ?? "one", lb = labelOf.get(b) ?? "another";
          problems.push(`in the ${name} figure, the boxes of "${la}" and "${lb}" (${a.cls}) overlap by ${round(ox)}x${round(oy)} units`);
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
  return problems;
}

// ── the gateway the sandbox calls ───────────────────────────────────────────

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// Answered only from inside a check container, through the egress gateway;
// no public route reaches this. GET says the check may render; POST /check
// renders one page at two viewports and answers the problems, if any.
export async function renderGateway(env: unknown, request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" || request.method === "HEAD") {
    return reply(200, { render: "browser-run", pages: PAGES, viewports: VIEWPORTS });
  }
  if (request.method !== "POST") {
    return reply(405, { error: "method", detail: "the render gateway answers GET, to ask whether it is there, and POST /check" });
  }
  if (url.pathname !== "/check") return reply(404, { error: "not_found", detail: "the render gateway answers POST /check" });
  const browser = (env as { BROWSER?: RenderBrowser }).BROWSER;
  if (!browser) return reply(503, { error: "no_browser", detail: "this Worker has no browser binding, so no page can be rendered" });
  let body: { page?: unknown; html?: unknown };
  try {
    body = (await request.json()) as { page?: unknown; html?: unknown };
  } catch {
    return reply(400, { error: "bad_body", detail: "POST /check takes JSON: { page, html }" });
  }
  const page = body.page;
  if (page !== "/how" && page !== "/showcase") {
    return reply(400, { error: "bad_page", detail: `page must be ${PAGES.map((p) => `"${p}"`).join(" or ")}` });
  }
  if (typeof body.html !== "string" || !body.html.trim()) {
    return reply(400, { error: "bad_html", detail: "html must be the page's HTML, rendered from the pushed tree" });
  }
  if (body.html.length > MAX_HTML) {
    return reply(413, { error: "too_long", detail: `html is longer than ${MAX_HTML} characters; a public page is a tenth of that` });
  }
  const scrapes: ScrapeResponse[] = [];
  for (const viewport of VIEWPORTS) {
    let res: Response;
    try {
      // networkidle0: the pages' text is measured in the webfonts their
      // <link> names, not in a fallback, before any geometry is read.
      res = await browser.quickAction("scrape", {
        html: body.html,
        viewport,
        elements: SELECTORS.map((selector) => ({ selector })),
        gotoOptions: { waitUntil: "networkidle0", timeout: 45_000 },
      });
    } catch (err) {
      return reply(502, { error: "browser", detail: `Browser Run could not render ${page}: ${String((err as Error)?.message ?? err).slice(0, 300)}` });
    }
    if (res.status === 429) {
      return reply(429, { error: "browser_busy", detail: "Browser Run is at its limit; run the check again in a moment" });
    }
    if (!res.ok) {
      return reply(502, { error: "browser", detail: `Browser Run answered ${res.status} for ${page}: ${(await res.text()).slice(0, 300)}` });
    }
    let data: ScrapeResponse;
    try {
      data = (await res.json()) as ScrapeResponse;
    } catch {
      return reply(502, { error: "browser", detail: `Browser Run answered nothing readable for ${page}` });
    }
    if (!data?.success) {
      return reply(502, { error: "browser", detail: `Browser Run did not render ${page}: ${data?.errors?.map((e) => e.message ?? "").filter(Boolean).join("; ") || "no result"}` });
    }
    scrapes.push(data);
  }
  return reply(200, { page, problems: scrapeProblems(page, scrapes[0], scrapes[1]) });
}
