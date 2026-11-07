import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { buildNow } from "../src/now.ts";
import { page as ownerPage, renderNow } from "../src/ui.ts";
import { NOW, project } from "./fixtures/now.ts";

// The Now page in a real browser (t525): it follows the device's colour
// scheme and switches when that changes, it never scrolls sideways at 390 px,
// and an owner page that is not Now stays in Night. The browser is the one
// playwright-core finds in its cache or ATELIER_CAPTURE_CHROMIUM names
// (docs/design/README.md); without one these tests are skipped, and the
// stylesheet and markup the browser reads are checked in test/now-routes.spec.ts.
// NOW_SHOTS=DIR also saves a screenshot of each width and scheme there.

const executable = process.env.ATELIER_CAPTURE_CHROMIUM || chromium.executablePath();
const skip = executable && existsSync(executable) ? false : "no Chromium in playwright's cache and ATELIER_CAPTURE_CHROMIUM names none";
const html = renderNow(buildNow([project()], NOW), "PAVI");
const failedRequests: string[] = [];
const consoleErrors: string[] = [];

async function open(width: number, scheme: "light" | "dark", fn: (page: import("playwright-core").Page) => Promise<void>, body = html) {
  const browser = await chromium.launch({ executablePath: executable });
  try {
    const page = await (await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme })).newPage();
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    // Nothing leaves the machine: the fonts stylesheet is the only outside request, and it is refused.
    await page.route("**/*", (route) => { failedRequests.push(route.request().url()); return route.abort(); });
    await page.setContent(body);
    await fn(page);
  } finally { await browser.close(); }
}

const ground = (page: import("playwright-core").Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const rowFill = (page: import("playwright-core").Page) => page.evaluate(() => getComputedStyle(document.querySelector(".now-row")!).backgroundColor);

test("the page is dark on a dark device and light on a light one", { skip }, async () => {
  let dark = "", light = "";
  await open(1440, "dark", async (p) => { dark = await ground(p); });
  await open(1440, "light", async (p) => { light = await ground(p); });
  assert.equal(dark, "rgb(7, 9, 12)");
  assert.notEqual(light, dark);
  const lum = (c: string) => c.match(/\d+/g)!.slice(0, 3).map(Number).reduce((a, b) => a + b, 0);
  assert.ok(lum(light) > 600 && lum(dark) < 60, `${light} / ${dark}`);
});

test("the page switches scheme when the device does, with no reload", { skip }, async () => {
  await open(1440, "dark", async (p) => {
    const before = [await ground(p), await rowFill(p)];
    await p.emulateMedia({ colorScheme: "light" });
    const after = [await ground(p), await rowFill(p)];
    assert.notEqual(after[0], before[0]);
    assert.notEqual(after[1], before[1]);
    await p.emulateMedia({ colorScheme: "dark" });
    assert.deepEqual([await ground(p), await rowFill(p)], before);
  });
});

test("an owner page that is not Now stays in Night on a light device", { skip }, async () => {
  await open(1440, "light", async (p) => {
    assert.equal(await ground(p), "rgb(7, 9, 12)");
  }, ownerPage("Decisions", "<p>Decisions</p>"));
});

for (const width of [1440, 390]) {
  for (const scheme of ["dark", "light"] as const) {
    test(`at ${width} px in ${scheme}, all four groups draw and nothing scrolls sideways`, { skip }, async () => {
      await open(width, scheme, async (p) => {
        const overflow = await p.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
        assert.ok(overflow.scroll <= overflow.inner, `scrollWidth ${overflow.scroll} > ${overflow.inner}`);
        assert.deepEqual(await p.locator(".now-group h2").allInnerTexts().then((t) => t.map((s) => s.replace(/\s+\d+$/, ""))), ["Needs you", "Running", "Stuck or waiting on a session", "Landed today"]);
        assert.equal(await p.locator(".now-figure").count(), 3);
        assert.equal(await p.locator(".now-row").count(), 12);
        const shots = process.env.NOW_SHOTS;
        if (shots) { mkdirSync(shots, { recursive: true }); await p.screenshot({ path: join(shots, `now-${width}-${scheme}.png`), fullPage: true }); }
      });
    });
  }
}

test("no request left the page, and the console held no error from it", { skip }, async () => {
  await open(390, "dark", async () => {});
  assert.deepEqual(failedRequests.filter((u) => !u.startsWith("https://fonts.googleapis.com/") && !u.startsWith("https://fonts.gstatic.com/") && u !== "about:blank"), []);
  assert.deepEqual(consoleErrors.filter((m) => !/fonts\.(googleapis|gstatic)|ERR_FAILED|Failed to load resource/.test(m)), []);
});
