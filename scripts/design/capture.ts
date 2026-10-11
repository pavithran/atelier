import { spawn } from "node:child_process";
import { chromium } from "playwright-core";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";

async function main() {
  const executablePath = `${os.homedir()}/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
  try {
    await fs.access(executablePath);
  } catch (e) {
    console.error("Missing browser: " + executablePath);
    process.exit(1);
  }

  const child = spawn("npx", ["vitest", "run", "test/fixtures/design/capture.spec.ts", "--no-color"], { stdio: ["ignore", "pipe", "inherit"] });

  const captures: { name: string, url: string, html: string, contentType?: string }[] = [];
  let buffer = "";

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let n;
    while ((n = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, n);
      buffer = buffer.slice(n + 1);
      
      const match = line.match(/^\{"magic":"capture",/);
      if (match) {
        try {
          captures.push(JSON.parse(line));
        } catch (e) {}
      } else {
        process.stdout.write(line + "\n");
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`vitest failed with code ${code}`));
      else resolve();
    });
  });

  if (captures.length === 0) {
    console.error("Missing capture data");
    process.exit(1);
  }

  const browser = await chromium.launch({ executablePath });
  const manifest = [];
  const sourceSHA = (await fs.readFile(".git/refs/heads/main", "utf8").catch(() => "unknown")).trim().substring(0, 7);
  
  await fs.mkdir("docs/design/screens", { recursive: true });

  const assetMap = new Map<string, { contentType: string, body: string }>();
  for (const capture of captures) {
    assetMap.set(capture.url, { contentType: capture.contentType || "text/html", body: capture.html });
  }

  for (const capture of captures) {
    if (capture.name === "live.js") continue; // Not a page
    for (const vp of [{ w: 1440, h: 900 }, { w: 390, h: 844 }]) {
      const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h } });
      
      let assetFailed = false;
      page.on("requestfailed", (req) => { assetFailed = true; console.error("Asset failed:", req.url()); });

      await page.route("**/*", async (route) => {
        const reqUrl = route.request().url();
        if (assetMap.has(reqUrl)) {
          await route.fulfill({ contentType: assetMap.get(reqUrl)!.contentType, body: assetMap.get(reqUrl)!.body });
        } else if (reqUrl.includes("fonts.googleapis.com") || reqUrl.includes("fonts.gstatic.com")) {
          await route.continue();
        } else {
          console.error("Unknown request: " + reqUrl);
          await route.continue();
        }
      });

      await page.goto(capture.url, { waitUntil: "networkidle" });
      if (assetFailed) {
        console.error("Failed on " + capture.url);
        process.exit(1);
      }
      
      const filename = `${capture.name}-${vp.w}.png`;
      await page.screenshot({ path: `docs/design/screens/${filename}`, fullPage: true });
      
      manifest.push({
        sourceSHA, fixture: "seeded", url: capture.url, viewport: vp.w,
        browserVersion: browser.version(), filename
      });
      await page.close();
    }
  }
  
  await browser.close();
  await fs.writeFile("docs/design/screens/manifest.json", JSON.stringify(manifest, null, 2));
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
