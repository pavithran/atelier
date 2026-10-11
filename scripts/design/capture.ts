// The design capture (t499): `npm run design:capture`.
//
// 1. Finds the Chromium build playwright-core 1.61.1 names in its cache
//    (or ATELIER_CAPTURE_CHROMIUM, a browser already on this machine). It
//    never downloads one: a missing browser ends the run before anything.
// 2. Draws every page state in docs/design/brief.md from the seeded fixture
//    (test/fixtures/design/render.design.ts, in the Workers pool, with the
//    production renderers and CSS, test-only Access sign-in and stubbed
//    Artifacts), as JSON lines in a temporary file.
// 3. Loads each page into the browser at 1440 and 390 px, serving the page
//    and /live.js from what the Worker drew; the Google Fonts stylesheet and
//    files are fetched, and any other request fails the run. It saves a full
//    page screenshot of each, and measures contrast in light and dark, the
//    focus order, target sizes and reflow at 320 px (scripts/design/audit.ts).
// 4. Writes docs/design/screens/manifest.json and docs/design/audit.json,
//    then fails if any state in the brief has no screenshot at either width.
//
// A capture that is missing, a page drawn with the wrong status, a local
// asset or script that did not load: each ends the run with a non-zero exit.

import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { contrastInPage, focusStopInPage, reflowInPage, structureInPage, targetsInPage } from "./audit.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCREENS = join(ROOT, "docs/design/screens");
const VIEWPORTS = [{ width: 1440, height: 900 }, { width: 390, height: 844 }];
const PLAYWRIGHT = JSON.parse(await readFile(join(ROOT, "node_modules/playwright-core/package.json"), "utf8")).version as string;
const FONT_HOSTS = ["https://fonts.googleapis.com/", "https://fonts.gstatic.com/"];

type Page = { kind: "page"; id: string; path: string; url: string; audience: string; status: number; state: string; csp: string | null; body: string };
type Asset = { kind: "asset"; url: string; contentType: string; body: string };

function fail(message: string): never {
  console.error(`design capture: ${message}`);
  process.exit(1);
}

// The state ids the brief lists, from its "Page states" table.
export async function briefStates(): Promise<string[]> {
  const brief = await readFile(join(ROOT, "docs/design/brief.md"), "utf8");
  const section = brief.split(/^## /m).find((s) => /^(\d+\. )?Page states/.test(s));
  if (!section) fail("docs/design/brief.md has no \"Page states\" section");
  return [...section.matchAll(/^\| `([a-z0-9-]+)` \|/gm)].map((m) => m[1]);
}

function browserPath(): string {
  const named = process.env.ATELIER_CAPTURE_CHROMIUM;
  const path = named || chromium.executablePath();
  if (!path || !existsSync(path)) {
    fail(`no Chromium at ${path || "(none named)"}. playwright-core ${PLAYWRIGHT} looks in its browser cache; this command never downloads a browser. Put the cached build there (npx playwright-core install chromium, run by the owner) or name one with ATELIER_CAPTURE_CHROMIUM.`);
  }
  return path;
}

async function draw(): Promise<{ fixture: Record<string, unknown>; pages: Page[]; assets: Asset[] }> {
  const dir = await mkdtemp(join(tmpdir(), "atelier-design-"));
  const out = join(dir, "pages.jsonl");
  const child = spawn(join(ROOT, "node_modules/.bin/vitest"), ["run", "--config", "scripts/design/vitest.config.ts", "--no-color"], { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, ATELIER_DESIGN_OUT: out } });
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  if (code !== 0) fail(`the render step (vitest) exited ${code}`);
  const text = existsSync(out) ? await readFile(out, "utf8") : "";
  await rm(dir, { recursive: true, force: true });
  const lines = text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  if (!lines.some((l) => l.kind === "done")) fail("the render step ended without drawing every page");
  const fixture = lines.find((l) => l.kind === "fixture");
  if (!fixture) fail("the render step printed no fixture summary");
  return { fixture, pages: lines.filter((l) => l.kind === "page") as Page[], assets: lines.filter((l) => l.kind === "asset") as Asset[] };
}

const git = (...args: string[]) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();

async function main() {
  const executable = browserPath();
  const wanted = await briefStates();
  if (!wanted.length) fail("docs/design/brief.md lists no page states");
  const { fixture, pages, assets } = await draw();
  const drawn = new Set(pages.map((p) => p.id));
  const notDrawn = wanted.filter((id) => !drawn.has(id));
  const notListed = [...drawn].filter((id) => !wanted.includes(id));
  if (notDrawn.length || notListed.length) fail(`the brief and the fixture disagree: not drawn ${notDrawn.join(", ") || "none"}; not in the brief ${notListed.join(", ") || "none"}`);

  const source = { commit: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain", "--", "src", "test/fixtures/design", "scripts/design").length > 0 };
  const browser = await chromium.launch({ executablePath: executable, headless: true });
  const version = browser.version();
  await mkdir(SCREENS, { recursive: true });
  const served = new Map<string, { contentType: string; body: string; csp?: string | null }>();
  for (const a of assets) served.set(a.url, { contentType: a.contentType, body: a.body });
  const manifest: Record<string, unknown>[] = [];
  const audits: Record<string, unknown> = {};
  const problems: string[] = [];

  for (const p of pages) {
    served.set(p.url, { contentType: "text/html; charset=utf-8", body: p.body, csp: p.csp });
    const audit: Record<string, unknown> = { path: p.path, status: p.status, audience: p.audience };
    for (const vp of VIEWPORTS) {
      const context = await browser.newContext({ viewport: vp, colorScheme: "light", reducedMotion: "reduce", timezoneId: "UTC", locale: "en-GB" });
      const page = await context.newPage();
      await page.clock.setFixedTime(new Date(String(fixture.now)));
      const local: string[] = [], external: string[] = [], failed: string[] = [];
      await page.route("**/*", async (route) => {
        const url = route.request().url();
        const hit = served.get(url) ?? served.get(url.replace(/#.*$/, ""));
        if (hit) {
          local.push(url);
          return route.fulfill({ status: url === p.url ? p.status : 200, contentType: hit.contentType, body: hit.body, headers: hit.csp ? { "content-security-policy": hit.csp } : {} });
        }
        if (FONT_HOSTS.some((h) => url.startsWith(h))) { external.push(url); return route.continue(); }
        failed.push(`unexpected request ${url}`);
        return route.abort();
      });
      page.on("requestfailed", (r) => { if (!FONT_HOSTS.some((h) => r.url().startsWith(h))) failed.push(`failed ${r.url()}: ${r.failure()?.errorText}`); });
      // Chromium logs the page's own non-200 status (a 404 or 503 state the brief asks for) as a
      // console error; that one is expected. Any other resource answering 400 or more fails the run.
      page.on("response", (r) => { if (r.status() >= 400 && r.url() !== p.url) failed.push(`${r.status()} ${r.url()}`); });
      page.on("console", (m) => {
        if (m.type() !== "error") return;
        if (p.status >= 400 && m.location().url === p.url && m.text().includes(`status of ${p.status}`)) return;
        failed.push(`console: ${m.text()}`);
      });
      page.on("pageerror", (e) => failed.push(`script error: ${e.message}`));
      await page.goto(p.url, { waitUntil: "load" });
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      // Every local script and stylesheet the page names must have loaded.
      const named = await page.evaluate(() => [...document.querySelectorAll("script[src]")].map((s) => (s as HTMLScriptElement).src));
      for (const src of named) if (!local.includes(src)) failed.push(`script not loaded: ${src}`);
      const fonts = await page.evaluate(() => [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family));
      const filename = `${p.id}-${vp.width}.png`;
      await page.screenshot({ path: join(SCREENS, filename), fullPage: true });
      const structure = await page.evaluate(structureInPage);
      const targets = await page.evaluate(targetsInPage);
      manifest.push({
        id: p.id, state: p.state, path: p.path, url: p.url, audience: p.audience, status: p.status,
        viewport: vp, colorScheme: "light", height: structure.height, filename,
        source: source.commit, sourceDirty: source.dirty,
        fixture: { file: "test/fixtures/design/seed.ts", now: fixture.now, tasks: fixture.tasks },
        browser: { name: "chromium", version, playwrightCore: PLAYWRIGHT },
        assets: { local: [...new Set(local)], fonts: [...new Set(fonts)], external: external.length },
      });
      const at: Record<string, unknown> = { structure, targets };
      if (vp.width === 1440) {
        at.contrast = [];
        for (const scheme of ["light", "dark"] as const) {
          await page.emulateMedia({ colorScheme: scheme });
          (at.contrast as unknown[]).push(await page.evaluate(contrastInPage));
        }
        await page.emulateMedia({ colorScheme: "light" });
        const stops: unknown[] = [];
        await page.evaluate(() => window.scrollTo(0, 0));
        for (let i = 0; i < 200; i++) {
          await page.keyboard.press("Tab");
          const stop = await page.evaluate(focusStopInPage);
          if (!stop || (stops.length && JSON.stringify(stop) === JSON.stringify(stops[0]))) break;
          stops.push(stop);
        }
        at.focus = { stops: stops.length, first: stops[0] ?? null, noIndicator: (stops as { indicator: string | null }[]).filter((s) => !s.indicator), offScreen: (stops as { onScreen: boolean }[]).filter((s) => !s.onScreen) };
        await page.setViewportSize({ width: 320, height: 640 });
        await page.waitForTimeout(50);
        at.reflow320 = await page.evaluate(reflowInPage);
      }
      audit[String(vp.width)] = at;
      if (failed.length) problems.push(...failed.map((f) => `${p.id} @${vp.width}: ${f}`));
      await context.close();
    }
    audits[p.id] = audit;
    console.log(`  captured ${p.id}`);
  }
  await browser.close();

  // Missing means not captured by this run: a file left from an earlier one does not count.
  const missing = wanted.flatMap((id) => VIEWPORTS.map((vp) => `${id}-${vp.width}.png`))
    .filter((name) => !manifest.some((m) => m.filename === name) || !existsSync(join(SCREENS, name)));
  const header = { generatedBy: "scripts/design/capture.ts", source: source.commit, sourceDirty: source.dirty, browser: { name: "chromium", version, playwrightCore: PLAYWRIGHT }, fixture: { file: "test/fixtures/design/seed.ts", now: fixture.now, tasks: fixture.tasks, projects: fixture.projects } };
  await writeFile(join(SCREENS, "manifest.json"), `${JSON.stringify({ ...header, screens: manifest }, null, 2)}\n`);
  await writeFile(join(ROOT, "docs/design/audit.json"), `${JSON.stringify({ ...header, pages: audits }, null, 2)}\n`);
  if (missing.length) fail(`missing captures: ${missing.join(", ")}`);
  if (problems.length) fail(`${problems.length} load problem(s):\n${problems.map((x) => `  ${x}`).join("\n")}`);
  console.log(`design capture: ${manifest.length} screenshots of ${pages.length} page states, Chromium ${version}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
