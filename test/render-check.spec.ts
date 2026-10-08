import { expect, it } from "vitest";
import { renderGateway, type RenderBrowser, type RenderScrapeOptions, type Scraped, type ScrapeResponse } from "../src/render-check.ts";
import { routeEgress } from "../src/sandbox/runner.ts";

// The gateway the sandbox's render check calls, and the egress route that
// reaches it: a fake browser binding answers with geometry built by hand, so
// these tests cover the contract — the scrapes asked for, the pages and
// viewports, the refusals — while test/render-check.test.ts covers the rules
// that read the geometry. No test here touches the network, and none uses the
// real BROWSER binding, which only a deployed Worker has.

type Box = { left: number; top: number; width: number; height: number };
const el = (box: Box, cls?: string, label?: string, viewBox?: string): Scraped => ({
  ...box,
  ...(label === undefined ? {} : { html: `<text class="${cls ?? ""}">${label}</text>` }),
  attributes: [...(cls ? [{ name: "class", value: cls }] : []), ...(viewBox ? [{ name: "viewBox", value: viewBox }] : [])],
});
const scrape = (groups: Record<string, Scraped[]>): ScrapeResponse => ({
  success: true,
  result: Object.entries(groups).map(([selector, results]) => ({ selector, results })),
});

// A page whose figures render as drawn, in the drawing's own units.
function healthy(broken?: "overflow"): { wide: ScrapeResponse; narrow: ScrapeResponse } {
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

interface Call { html: string; viewport: { width: number; height: number }; selectors: string[]; waitUntil?: string | string[] }

function browserOf(answer: (options: RenderScrapeOptions) => Promise<Response>): RenderBrowser & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async quickAction(action, options) {
      expect(action).toBe("scrape");
      calls.push({
        html: options.html,
        viewport: options.viewport,
        selectors: options.elements.map((e) => e.selector),
        waitUntil: options.gotoOptions?.waitUntil,
      });
      return await answer(options);
    },
  };
}
const scraping = (pages: () => { wide: ScrapeResponse; narrow: ScrapeResponse }) =>
  browserOf(async (options) => {
    const { wide, narrow } = pages();
    return new Response(JSON.stringify(options.viewport.width >= 1000 ? wide : narrow), { headers: { "content-type": "application/json" } });
  });

const HTML = "<!doctype html><html><head></head><body><main>the page</main></body></html>";
const post = (browser: unknown, body: unknown | string, path = "/check") =>
  renderGateway(browser, new Request(`https://render.atelier.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));

it("GET says the render check is here, and only POST /check renders", async () => {
  const probe = await renderGateway({}, new Request("https://render.atelier.test/"));
  expect(probe.status).toBe(200);
  expect(await probe.json()).toMatchObject({ render: "browser-run", pages: ["/how", "/showcase"] });
  expect((await renderGateway({}, new Request("https://render.atelier.test/check", { method: "PUT" }))).status).toBe(405);
  expect((await post({}, { page: "/how", html: HTML }, "/nope")).status).toBe(404);
});

it("renders one page at two viewports and answers no problems when nothing is broken", async () => {
  const browser = scraping(healthy);
  const res = await post({ BROWSER: browser }, { page: "/how", html: HTML });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ page: "/how", problems: [] });
  expect(browser.calls).toHaveLength(2);
  expect(browser.calls.map((c) => c.viewport.width)).toEqual([1280, 375]);
  for (const call of browser.calls) {
    expect(call.html).toBe(HTML);
    expect(call.waitUntil).toBe("networkidle0");
    for (const selector of [".how-fig svg", ".how-fig svg rect", ".how-fig svg text", ".lay-fig svg", ".pf-fig svg", ".public-bar"]) {
      expect(call.selectors, selector).toContain(selector);
    }
  }
});

it("answers the problems a browser sees, naming the figure, the label and the amount", async () => {
  const res = await post({ BROWSER: scraping(() => healthy("overflow")) }, { page: "/how", html: HTML });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    page: "/how",
    problems: ['in the loop figure, the label "1 Brief and file the task" (hw-name) runs 20 units past the right edge of its hw-node box'],
  });
});

it("refuses what it cannot render: a body that is not JSON, a page it does not know, missing or over-long HTML, no browser binding", async () => {
  const browser = scraping(healthy);
  expect((await post({ BROWSER: browser }, "{not json")).status).toBe(400);
  expect((await post({ BROWSER: browser }, { page: "/login", html: HTML })).status).toBe(400);
  expect((await post({ BROWSER: browser }, { page: "/how" })).status).toBe(400);
  expect((await post({ BROWSER: browser }, { page: "/how", html: "x".repeat(1_500_001) })).status).toBe(413);
  const bare = await post({}, { page: "/how", html: HTML });
  expect(bare.status).toBe(503);
  expect(await bare.json()).toMatchObject({ error: "no_browser" });
  expect(browser.calls).toHaveLength(0);
});

it("says so when Browser Run itself fails, and passes a busy account through as 429", async () => {
  const throwing = browserOf(async () => { throw new Error("socket closed"); });
  const res = await post({ BROWSER: throwing }, { page: "/how", html: HTML });
  expect(res.status).toBe(502);
  expect(await res.json()).toMatchObject({ error: "browser" });
  const busy = browserOf(async () => new Response("too many browsers", { status: 429 }));
  expect((await post({ BROWSER: busy }, { page: "/how", html: HTML })).status).toBe(429);
  const empty = browserOf(async () => new Response("<html>500</html>", { status: 500 }));
  expect(((await (await post({ BROWSER: empty }, { page: "/how", html: HTML })).json()) as { detail?: string }).detail).toContain("500");
  const unreadable = browserOf(async () => new Response("not json", { status: 200 }));
  expect((await post({ BROWSER: unreadable }, { page: "/how", html: HTML })).status).toBe(502);
  const unsuccessful = browserOf(async () => new Response(JSON.stringify({ success: false, errors: [{ message: "timeout waiting for networkidle0" }] }), { status: 200 }));
  const failed = await post({ BROWSER: unsuccessful }, { page: "/how", html: HTML });
  expect(failed.status).toBe(502);
  expect(await failed.json()).toMatchObject({ error: "browser", detail: expect.stringContaining("networkidle0") });
});

it("the egress gateway answers the reserved render host and refuses every other reach", async () => {
  const env = { BROWSER: scraping(healthy) } as unknown as Env;
  const render = await routeEgress(env, new Request("https://render.atelier.test/check", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ page: "/showcase", html: HTML }),
  }));
  // /showcase needs only the layers figure, which the healthy scrape draws.
  expect(render.status).toBe(200);
  expect(await render.json()).toEqual({ page: "/showcase", problems: [] });
  const npmPost = await routeEgress(env, new Request("https://registry.npmjs.org/atelier", { method: "POST" }));
  expect(npmPost.status).toBe(403);
  expect(await npmPost.text()).toContain("may not reach POST registry.npmjs.org");
  const elsewhere = await routeEgress(env, new Request("https://example.com/"));
  expect(elsewhere.status).toBe(403);
  expect(await elsewhere.text()).toContain("may not reach GET example.com");
});
