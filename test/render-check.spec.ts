import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import {
  ALLOWED_REQUESTS, MAX_HTML, MAX_RENDERS, renderGateway, scrapeProblems,
  type RenderBrowser, type RenderGrant, type RenderScrapeOptions, type Scraped, type ScrapeResponse,
} from "../src/render-check.ts";
import { routeEgress, type RunState } from "../src/sandbox/runner.ts";
import { FONTS } from "../src/ui.ts";

// The render gateway the sandbox's render check (test/render-check.test.mjs)
// calls, the rules that read the geometry it answers, and the egress route
// that reaches it. A fake browser binding answers with geometry built by
// hand, so these tests cover the contract — the options every scrape is sent
// with, the pages and viewports, the run's allowance, the refusals — and the
// rules themselves. No test here touches the network, and none uses the real
// BROWSER binding, which only a deployed Worker has.

type Box = { left: number; top: number; width: number; height: number };
const el = (box: Box, cls?: string, label?: string, viewBox?: string, par?: string): Scraped => ({
  ...box,
  ...(label === undefined ? {} : { html: `<text class="${cls ?? ""}">${label}</text>` }),
  attributes: [
    ...(cls ? [{ name: "class", value: cls }] : []),
    ...(viewBox ? [{ name: "viewBox", value: viewBox }] : []),
    ...(par ? [{ name: "preserveAspectRatio", value: par }] : []),
  ],
});
const scrape = (groups: Record<string, Scraped[]>): ScrapeResponse => ({
  success: true,
  result: Object.entries(groups).map(([selector, results]) => ({ selector, results })),
});
type Pages = { wide: ScrapeResponse; narrow: ScrapeResponse };

// A page whose figures render as drawn, in the drawing's own units.
function healthy(broken?: "overflow"): Pages {
  const name = broken === "overflow"
    ? el({ left: 30, top: 25, width: 70, height: 8 }, "hw-name", "1 Brief and file the task")
    : el({ left: 30, top: 25, width: 30, height: 8 }, "hw-name", "1 Brief");
  return {
    wide: scrape({
      ".how-fig svg": [el({ left: 0, top: 0, width: 200, height: 100 }, undefined, undefined, "0 0 200 100")],
      ".how-fig svg rect": [el({ left: 0, top: 0, width: 200, height: 40 }, "hw-lane"), el({ left: 20, top: 20, width: 60, height: 20 }, "hw-node")],
      ".how-fig svg text": [el({ left: 4, top: 4, width: 30, height: 10 }, "hw-lane-label", "Owner"), name, el({ left: 150, top: 90, width: 40, height: 8 }, "hw-note", "a push returns")],
      ".lay-fig svg": [el({ left: 0, top: 0, width: 100, height: 60 }, undefined, undefined, "0 0 100 60")],
      ".lay-fig svg rect": [el({ left: 0, top: 0, width: 100, height: 20 }, "lay-band"), el({ left: 10, top: 25, width: 50, height: 15 }, "lay-node")],
      ".lay-fig svg text": [el({ left: 4, top: 2, width: 20, height: 8 }, "lay-label", "Cloudflare"), el({ left: 20, top: 28, width: 24, height: 8 }, "lay-name", "Worker")],
      ".pf-fig svg": [el({ left: 0, top: 0, width: 100, height: 80 }, undefined, undefined, "0 0 100 80")],
      ".pf-fig svg rect": [el({ left: 0, top: 0, width: 100, height: 80 }, "pf-lane"), el({ left: 20, top: 30, width: 50, height: 16 }, "pf-node")],
      ".pf-fig svg text": [el({ left: 4, top: 6, width: 20, height: 8 }, "pf-label", "Owner"), el({ left: 30, top: 34, width: 26, height: 8 }, "pf-name", "6 Build")],
      ".public-bar": [el({ left: 0, top: 0, width: 1280, height: 54 }, "public-bar")],
    }),
    narrow: scrape({
      ".how-fig svg": [el({ left: 0, top: 0, width: 880, height: 100 }, undefined, undefined, "0 0 200 100")],
      ".lay-fig svg": [el({ left: 0, top: 0, width: 880, height: 60 }, undefined, undefined, "0 0 100 60")],
      ".pf-fig svg": [el({ left: 0, top: 0, width: 880, height: 80 }, undefined, undefined, "0 0 100 80")],
      ".public-bar": [el({ left: 0, top: 0, width: 375, height: 96 }, "public-bar")],
    }),
  };
}

// The HTML a sandbox would have sent for these scrapes: every element the
// scrape found, with its class and label, so the answer may name them.
const sentFor = (pages: Pages) =>
  `<!doctype html><html><body class="public-bar">${pages.wide.result!.flatMap((g) => g.results)
    .map((s) => s.html ?? `<rect class="${s.attributes?.find((a) => a.name === "class")?.value ?? ""}"/>`).join("")}</body></html>`;
const HTML = sentFor(healthy("overflow"));

function browserOf(answer: (options: RenderScrapeOptions) => Promise<Response>): RenderBrowser & { calls: RenderScrapeOptions[] } {
  const calls: RenderScrapeOptions[] = [];
  return {
    calls,
    async quickAction(action, options) {
      expect(action).toBe("scrape");
      calls.push(options);
      return await answer(options);
    },
  };
}
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const scraping = (pages: () => Pages) =>
  browserOf(async (options) => {
    const { wide, narrow } = pages();
    return json(options.viewport.width >= 1000 ? wide : narrow);
  });

// An allowance as a check run holds one, counted here.
function grant(limit = MAX_RENDERS): RenderGrant & { used: number } {
  const g = { used: 0, async take(n: number) { if (g.used + n > limit) return false; g.used += n; return true; } };
  return g;
}

const checkRequest = (body: unknown | string, path = "/check") =>
  new Request(`https://render.atelier.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const post = (browser: RenderBrowser | undefined, body: unknown | string, path = "/check", g: RenderGrant | null = grant()) =>
  renderGateway(browser, checkRequest(body, path), g);

it("GET says the render check is here, and only POST /check renders", async () => {
  const probe = await renderGateway(undefined, new Request("https://render.atelier.test/"), grant());
  expect(probe.status).toBe(200);
  expect(await probe.json()).toMatchObject({ render: "browser-run", pages: ["/how", "/showcase"], renders: MAX_RENDERS });
  expect((await renderGateway(undefined, new Request("https://render.atelier.test/check", { method: "PUT" }), grant())).status).toBe(405);
  expect((await post(undefined, { page: "/how", html: HTML }, "/nope")).status).toBe(404);
});

it("renders one page at two viewports with JavaScript off and every request but the fonts blocked", async () => {
  const browser = scraping(healthy);
  const res = await post(browser, { page: "/how", html: HTML });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ page: "/how", problems: [] });
  expect(browser.calls.map((c) => c.viewport.width)).toEqual([1280, 375]);
  for (const call of browser.calls) {
    expect(call.html).toBe(HTML);
    expect(call.setJavaScriptEnabled).toBe(false);
    expect(call.allowRequestPattern).toEqual(ALLOWED_REQUESTS);
    expect(call).not.toHaveProperty("rejectRequestPattern");
    expect(call).not.toHaveProperty("addScriptTag");
    expect(call.cacheTTL).toBe(0);
    expect(call.gotoOptions.waitUntil).toBe("networkidle0");
    for (const selector of [".how-fig svg", ".how-fig svg rect", ".how-fig svg text", ".lay-fig svg", ".pf-fig svg", ".public-bar"]) {
      expect(call.elements.map((e) => e.selector), selector).toContain(selector);
    }
  }
});

it("the request filter lets through the pages' font stylesheet and Google font files, and nothing else", () => {
  const allowed = (url: string) => ALLOWED_REQUESTS.some((p) => new RegExp(p).test(url));
  expect(allowed(FONTS)).toBe(true);
  expect(allowed("https://fonts.gstatic.com/s/ibmplexsans/v19/zYXgKVElMYYaJe8bpLHnCwDKhdHeFaxOedc.woff2")).toBe(true);
  expect(allowed("https://fonts.gstatic.com/s/bricolagegrotesque/v8/3y9U6as8bTXq_nANBjzKo3IeZx8z6up5BeSl5jBNz_19PpbpMXuECpwUxJBOm_OJWiaaD30.woff2")).toBe(true);
  for (const url of [
    `${FONTS}&x=secret`,
    FONTS.replace("display=swap", "display=block"),
    "https://fonts.googleapis.com/css2?family=Anything",
    "https://evil.example/fonts.gstatic.com/s/a/v1/b.woff2",
    "https://fonts.gstatic.com.evil.example/s/a/v1/b.woff2",
    "https://fonts.gstatic.com/s/a/v1/b.woff2?leak=1",
    "https://fonts.gstatic.com/s/a/v1/../../x.woff2",
    "http://fonts.gstatic.com/s/a/v1/b.woff2",
    "https://example.com/",
    "https://registry.npmjs.org/atelier",
  ]) expect(allowed(url), url).toBe(false);
});

// A browser that behaves as Chromium does under the options it is given: a
// URL the page names is fetched when no allow pattern is set or one matches
// it, and a script runs unless JavaScript is off. What it fetched, or what a
// script made, shows up as the text of an overflowing label.
const SECRET = "SECRET-FROM-OUTSIDE";
const filtering = browserOf(async (options) => {
  const urls = [...options.html.matchAll(/(?:src|href)="([^"]+)"|url\(([^)]+)\)/g)].map((m) => m[1] ?? m[2]);
  const fetches = urls.filter((u) => !options.allowRequestPattern || options.allowRequestPattern.some((p) => new RegExp(p).test(u)));
  const scripted = /<script/i.test(options.html) && options.setJavaScriptEnabled !== false;
  const pages = healthy();
  if (fetches.some((u) => u.startsWith("https://evil.example")) || scripted) {
    pages.wide.result!.find((g) => g.selector === ".how-fig svg text")!.results
      .push(el({ left: 30, top: 25, width: 90, height: 8 }, "hw-name", SECRET));
  }
  return json(options.viewport.width >= 1000 ? pages.wide : pages.narrow);
});

it("a page asking for an outside URL gets nothing of it back", async () => {
  const html = `${sentFor(healthy())}<img src="https://evil.example/data"><style>@import url(https://evil.example/css);</style>`
    + `<script>fetch("https://evil.example/x").then(r => r.text()).then(t => document.querySelector("text").textContent = t)</script>`;
  const res = await post(filtering, { page: "/how", html });
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).not.toContain(SECRET);
  expect(JSON.parse(text)).toEqual({ page: "/how", problems: [] });
});

it("names only the labels the submitted HTML holds, whatever else the browser shows", async () => {
  // A browser that, filters or not, puts text the sandbox never sent into a
  // label: the answer still reports the broken label, without its words.
  const leaky = browserOf(async (options) => {
    const pages = healthy();
    pages.wide.result!.find((g) => g.selector === ".how-fig svg text")!.results
      .push(el({ left: 30, top: 25, width: 90, height: 8 }, "hw-name", SECRET));
    return json(options.viewport.width >= 1000 ? pages.wide : pages.narrow);
  });
  const res = await post(leaky, { page: "/how", html: sentFor(healthy()) });
  const text = await res.text();
  expect(text).not.toContain(SECRET);
  expect(JSON.parse(text)).toEqual({ page: "/how", problems: ["in the loop figure, a label (hw-name) runs 40 units past the right edge of its hw-node box"] });
});

it("answers the problems a browser sees, naming the figure, the label and the amount", async () => {
  const res = await post(scraping(() => healthy("overflow")), { page: "/how", html: HTML });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    page: "/how",
    problems: ['in the loop figure, the label "1 Brief and file the task" (hw-name) runs 20 units past the right edge of its hw-node box'],
  });
});

it("finds node boxes that overlap, and leaves lanes that hold nodes alone", () => {
  const pages = healthy();
  pages.wide.result!.find((g) => g.selector === ".how-fig svg rect")!.results.push(el({ left: 60, top: 22, width: 60, height: 16 }, "hw-node"));
  pages.wide.result!.find((g) => g.selector === ".how-fig svg text")!.results.push(el({ left: 85, top: 26, width: 30, height: 8 }, "hw-name", "2 Claim"));
  expect(scrapeProblems("/how", pages.wide, pages.narrow, sentFor(pages))).toEqual([
    'in the loop figure, the boxes of "1 Brief" and "2 Claim" (hw-node) overlap by 20x16 units',
  ]);
});

it("finds a figure that shrinks on a narrow screen, and a public bar that no longer wraps", () => {
  const pages = healthy();
  pages.narrow.result!.find((g) => g.selector === ".lay-fig svg")!.results[0].width = 343;
  pages.narrow.result!.find((g) => g.selector === ".public-bar")!.results[0].height = 54;
  expect(scrapeProblems("/showcase", pages.wide, pages.narrow, sentFor(pages))).toEqual([
    "the layers figure is 343px wide on a 375px screen, under the 880px its scroll frame holds, so it would shrink instead of scroll",
    "the public bar is as tall on a 375px screen as on a 1280px one, so it no longer wraps",
  ]);
});

it("maps the drawing by its viewBox as SVG does: one scale and centred unless preserveAspectRatio is none", () => {
  // A 200x100 drawing in a 400x100 box: at the default "xMidYMid meet" it
  // keeps scale 1 and sits from x=100 to x=300, so a note at x=310 is
  // outside it; stretched with "none", the same note is at drawing x=155.
  const at = (par?: string) => {
    const pages = healthy();
    const fig = pages.wide.result!;
    fig.find((g) => g.selector === ".how-fig svg")!.results = [el({ left: 0, top: 0, width: 400, height: 100 }, undefined, undefined, "0 0 200 100", par)];
    fig.find((g) => g.selector === ".how-fig svg rect")!.results = [];
    fig.find((g) => g.selector === ".how-fig svg text")!.results = [el({ left: 310, top: 40, width: 40, height: 8 }, "hw-note", "a push returns")];
    return scrapeProblems("/how", pages.wide, pages.narrow, sentFor(pages));
  };
  expect(at()).toEqual(['in the loop figure, the label "a push returns" (hw-note) falls outside the drawing']);
  expect(at("xMidYMid meet")).toEqual(at());
  expect(at("none")).toEqual([]);
});

it("refuses what it cannot render: a body that is not JSON, a page it does not know, missing or over-long HTML, no browser binding", async () => {
  const browser = scraping(healthy);
  expect((await post(browser, "{not json")).status).toBe(400);
  expect((await post(browser, { page: "/login", html: HTML })).status).toBe(400);
  expect((await post(browser, { page: "/how" })).status).toBe(400);
  const long = await post(browser, { page: "/how", html: "x".repeat(MAX_HTML + 1) });
  expect(long.status).toBe(413);
  // A body past twice the HTML cap is refused before it is read in full.
  const huge = await post(browser, `{"page":"/how","html":"${"x".repeat(2 * MAX_HTML + 1)}"}`);
  expect(huge.status).toBe(413);
  const bare = await post(undefined, { page: "/how", html: HTML });
  expect(bare.status).toBe(503);
  expect(await bare.json()).toMatchObject({ error: "no_browser" });
  expect(browser.calls).toHaveLength(0);
  expect(MAX_HTML).toBeLessThanOrEqual(400_000);
});

it("refuses anyone but a running check, and more renders than a run is allowed", async () => {
  const browser = scraping(healthy);
  const refused = await post(browser, { page: "/how", html: HTML }, "/check", null);
  expect(refused.status).toBe(403);
  expect((await renderGateway(browser, new Request("https://render.atelier.test/"), null)).status).toBe(403);
  const g = grant();
  const pagesPerRun = MAX_RENDERS / 2;
  for (let i = 0; i < pagesPerRun; i++) expect((await post(browser, { page: "/how", html: HTML }, "/check", g)).status).toBe(200);
  const over = await post(browser, { page: "/how", html: HTML }, "/check", g);
  expect(over.status).toBe(429);
  expect(await over.json()).toMatchObject({ error: "render_limit" });
  expect(browser.calls).toHaveLength(MAX_RENDERS);
  expect(MAX_RENDERS).toBeLessThanOrEqual(8);
});

it("says so when Browser Run itself fails, without passing on any text it answered", async () => {
  const throwing = browserOf(async () => { throw new Error(`socket closed after reading ${SECRET}`); });
  const res = await post(throwing, { page: "/how", html: HTML });
  expect(res.status).toBe(502);
  expect(await res.text()).not.toContain(SECRET);
  const busy = browserOf(async () => new Response("too many browsers", { status: 429 }));
  expect((await post(busy, { page: "/how", html: HTML })).status).toBe(429);
  const failing = browserOf(async () => new Response(`<html>500 ${SECRET}</html>`, { status: 500 }));
  const failed = await post(failing, { page: "/how", html: HTML });
  const body = (await failed.json()) as { detail?: string };
  expect(body.detail).toContain("500");
  expect(body.detail).not.toContain(SECRET);
  const unreadable = browserOf(async () => new Response("not json", { status: 200 }));
  expect((await post(unreadable, { page: "/how", html: HTML })).status).toBe(502);
  const unsuccessful = browserOf(async () => json({ success: false, errors: [{ message: `net::ERR at https://evil.example/${SECRET}` }] }));
  const notRendered = await post(unsuccessful, { page: "/how", html: HTML });
  expect(notRendered.status).toBe(502);
  expect(await notRendered.text()).not.toContain(SECRET);
});

async function runAs(runId: string, status: RunState["status"]) {
  const state: RunState = {
    status, queuedAt: new Date().toISOString(),
    request: { runId, project: "p", itemId: "t1", baselineRepo: "base", fork: "base--fork", head: "1".repeat(40), checks: ["npm test"], requestedBy: "owner" },
  };
  await runInDurableObject(env.RUNNER.get(env.RUNNER.idFromName(runId)), async (_instance: unknown, s: DurableObjectState) => {
    await s.storage.put("state", state);
  });
}

it("the egress gateway answers the render host only for a running check, within its run's renders, and refuses every other reach", async () => {
  const browser = scraping(healthy);
  const withBrowser = { ...env, BROWSER: browser } as unknown as Env;
  const render = (runId?: string) => routeEgress(withBrowser, checkRequest({ page: "/showcase", html: HTML }), runId);
  await runAs("render-running", "running");
  // /showcase needs only the layers figure, which the healthy scrape draws.
  const ok = await render("render-running");
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ page: "/showcase", problems: [] });
  for (let i = 1; i < MAX_RENDERS / 2; i++) expect((await render("render-running")).status).toBe(200);
  expect((await render("render-running")).status).toBe(429);
  expect(browser.calls).toHaveLength(MAX_RENDERS);
  // No run named, a run that is over, or one that never existed: refused.
  expect((await render()).status).toBe(403);
  await runAs("render-done", "done");
  expect((await render("render-done")).status).toBe(429);
  expect((await render("render-never")).status).toBe(429);
  expect(browser.calls).toHaveLength(MAX_RENDERS);
  const npmPost = await routeEgress(withBrowser, new Request("https://registry.npmjs.org/atelier", { method: "POST" }), "render-running");
  expect(npmPost.status).toBe(403);
  expect(await npmPost.text()).toContain("may not reach POST registry.npmjs.org");
  const elsewhere = await routeEgress(withBrowser, new Request("https://example.com/"), "render-running");
  expect(elsewhere.status).toBe(403);
  expect(await elsewhere.text()).toContain("may not reach GET example.com");
});
