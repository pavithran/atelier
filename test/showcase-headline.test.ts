import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

// The showcase headline's colours as a browser computes them (t673, PAVI
// chose mockup C with "the" left white): Git's sentence in --text-muted,
// "Atelier brings the" in --text-bright, and only "receipts." in --signal.
// test/showcase.spec.ts reads the markup and the rules as strings, so a later
// rule that overrides them would still pass there; this test renders the page
// in Chromium and reads getComputedStyle, so it fails on any override.
//
// It needs the Chromium build that playwright-core (a dev dependency) caches;
// where none is cached, as in a check container whose Internet is off, it
// says so and skips, claiming nothing.

const theme = readFileSync(resolve("src/theme.css"), "utf8");
const token = (name: string) => {
  const night = theme.slice(theme.indexOf(":root {"), theme.indexOf("@media"));
  const hex = night.match(new RegExp(`${name}:\\s*#([0-9a-fA-F]{6})\\b`))![1];
  return `rgb(${[0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
};

test("the showcase headline renders Git's sentence muted, Atelier's bright and only \"receipts.\" in gold (t673)", async (t) => {
  const { chromium } = await import("playwright-core");
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    t.skip(`no Chromium cached for playwright-core on this machine: ${String(err).split("\n")[0]}`);
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "headline-"));
  try {
    const entry = join(dir, "entry.ts");
    writeFileSync(entry, `export { renderShowcase } from ${JSON.stringify(resolve("src/ui.ts"))};`);
    await build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", loader: { ".css": "text" }, outfile: join(dir, "ui.mjs"), logLevel: "silent" });
    const { renderShowcase } = await import(pathToFileURL(join(dir, "ui.mjs")).href);
    const html: string = renderShowcase([], undefined, "pavi", "PAVI");
    const page = await browser.newPage({ colorScheme: "dark" });
    // Offline: the page's fonts would only change the shapes, never a colour.
    await page.route("**/*", (r) => r.abort());
    await page.setContent(html);
    const seen = await page.evaluate(() => {
      const h1 = document.querySelector(".show-hero h1")!;
      const ink = (el: Element) => getComputedStyle(el).color;
      // The innermost element holding each word, so the colour read is the
      // one the word is drawn in.
      const word = (w: string) => [...h1.querySelectorAll("span")].filter((s) => s.textContent!.includes(w)).at(-1)!;
      const text = (el: Element) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent!.trim()).join(" ").trim();
      return {
        git: [word("Git keeps"), word("the code.")].map(ink),
        atelier: [ink(word("Atelier brings")), text(word("receipts").parentElement!), ink(word("receipts").parentElement!)],
        receipts: [word("receipts.").textContent, ink(word("receipts."))],
      };
    });
    const [muted, bright, signal] = [token("--text-muted"), token("--text-bright"), token("--signal")];
    assert.deepEqual(seen.git, [muted, muted], "Git's sentence is not --text-muted");
    assert.deepEqual(seen.atelier, [bright, "the", bright], "\"Atelier brings the\" is not --text-bright");
    assert.deepEqual(seen.receipts, ["receipts.", signal], "only \"receipts.\" is to be --signal");
  } finally {
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
