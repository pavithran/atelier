// Captures real atelier.zone pages, read-only, into .cache/screens/. Public
// pages are fetched signed out; the atelier project's pages need the owner's
// sign-in, which is posted to /login inside the browser context only. Only
// pages of the atelier project (and the public /showcase and /how) are
// captured, so no other project's name can appear.
import { chromium } from "playwright";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { SERVER, ownerToken } from "./atelier-api.mjs";

const OUT = new URL("../.cache/screens/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

export const SHOTS = [
  { name: "showcase", path: "/showcase", public: true },
  { name: "how", path: "/how", public: true },
  { name: "flow", path: "/p/atelier/flow" },
  { name: "plans", path: "/p/atelier/plans" },
  { name: "t278", path: "/p/atelier/t278" },
  { name: "t252", path: "/p/atelier/t252" },
  // Only the AI Gateway section of the Models page: per-model gateway
  // figures, which name models, not projects.
  { name: "gateway", path: "/models", section: "AI Gateway" },
];

// Words that must never be on a captured owner page: the names of the
// owner's other projects, read from the CLI's config at run time.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
const others = Object.keys(JSON.parse(readFileSync(homedir() + "/.config/atelier/config.json", "utf8")).projects ?? {})
  .filter((n) => n !== "atelier" && n.length > 4);

const browser = await chromium.launch();
const meta = existsSync(OUT + "meta.json") ? JSON.parse(readFileSync(OUT + "meta.json", "utf8")) : {};
const only = process.argv.slice(2);
for (const pub of [true, false]) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 4 / 3, colorScheme: "dark", timezoneId: "UTC" });
  if (!pub) {
    const r = await ctx.request.post(SERVER + "/login", { form: { token: ownerToken() }, headers: { origin: SERVER }, maxRedirects: 0 });
    if (r.status() >= 400) throw new Error("sign-in failed: " + r.status());
  }
  const page = await ctx.newPage();
  for (const shot of SHOTS.filter((s) => !!s.public === pub && (!only.length || only.includes(s.name)))) {
    await page.goto(SERVER + shot.path, { waitUntil: "networkidle" });
    for (const label of shot.open ?? []) {
      const s = page.locator("summary", { hasText: label }).first();
      if (await s.count()) await s.click();
    }
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(500);
    if (!pub) {
      const text = (await page.evaluate(() => document.body.innerText)).toLowerCase();
      const hit = others.filter((n) => text.includes(n.toLowerCase().replace(/-/g, " ")) || text.includes(n.toLowerCase()));
      if (hit.length) console.warn(`${shot.name}: names ${hit.length} other project(s); crop or drop it`);
    }
    if (shot.section) {
      const box = await page.evaluate((title) => {
        const h2 = [...document.querySelectorAll("h2")].find((x) => x.textContent.includes(title));
        let r = h2.getBoundingClientRect(), top = r.top + scrollY, bottom = r.bottom + scrollY, left = r.left, right = r.right;
        for (let n = h2.nextElementSibling; n && n.tagName !== "H2"; n = n.nextElementSibling) { const q = n.getBoundingClientRect(); bottom = Math.max(bottom, q.bottom + scrollY); right = Math.max(right, q.right); }
        return { x: Math.max(0, left - 40), y: Math.max(0, top - 40), width: Math.min(innerWidth, right + 40) - Math.max(0, left - 40), height: bottom - top + 80 };
      }, shot.section);
      await page.screenshot({ path: OUT + shot.name + ".png", fullPage: true, clip: box });
      console.log("captured", shot.name);
      continue;
    }
    await page.screenshot({ path: OUT + shot.name + ".png", fullPage: true });
    // Where each heading and drawing sits, in the image's pixels, so a scene
    // can pan to it by name.
    meta[shot.name] = await page.evaluate((scale) => {
      const marks = {};
      for (const el of document.querySelectorAll("h1, h2, h3, svg, .thread, summary")) {
        const r = el.getBoundingClientRect();
        const key = el.tagName === "svg" ? "svg@" + Math.round(r.top + scrollY) : (el.textContent || "").trim().slice(0, 40);
        if (!(key in marks)) marks[key] = { y: Math.round((r.top + scrollY) * scale), h: Math.round(r.height * scale), x: Math.round(r.left * scale), w: Math.round(r.width * scale) };
      }
      return { height: Math.round(document.documentElement.scrollHeight * scale), marks };
    }, 4 / 3);
    console.log("captured", shot.name);
  }
  await ctx.close();
}
writeFileSync(OUT + "meta.json", JSON.stringify(meta, null, 1));
await browser.close();
