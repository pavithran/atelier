import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// The design captures (t499) are complete or this fails: every page state
// the brief lists has a full-page screenshot at 1440 and 390 px, named in the
// manifest with the source commit, the fixture, the URL, the viewport and the
// browser that drew it. A state with no screenshot is never a pass, whatever
// else the manifest holds. scripts/design/capture.ts writes both; it needs
// the Chromium build playwright-core caches, which this test does not.

const WIDTHS = [1440, 390];
const brief = readFileSync(resolve("docs/design/brief.md"), "utf8");
const section = brief.split(/^## /m).find((s) => /^(\d+\. )?Page states/.test(s)) ?? "";
const states = [...section.matchAll(/^\| `([a-z0-9-]+)` \|/gm)].map((m) => m[1]);
const manifestPath = resolve("docs/design/screens/manifest.json");

// A PNG's width and height, from its IHDR chunk.
function size(path: string): { width: number; height: number } {
  const b = readFileSync(path);
  assert.equal(b.subarray(1, 4).toString("latin1"), "PNG", `${path} is not a PNG`);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

test("the brief lists the page states it inventories", () => {
  assert.ok(states.length >= 40, `the brief's Page states table lists ${states.length} states`);
  assert.equal(new Set(states).size, states.length, "a state id is listed twice");
});

test("every page state in the brief has a screenshot at 1440 and 390 px, in the manifest", () => {
  assert.ok(existsSync(manifestPath), "docs/design/screens/manifest.json is missing: run npm run design:capture");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { source?: string; browser?: { version?: string }; screens?: Record<string, unknown>[] };
  assert.match(String(manifest.source), /^[0-9a-f]{40}$/, "the manifest names no source commit");
  assert.ok(manifest.browser?.version, "the manifest names no browser version");
  const screens = manifest.screens ?? [];
  const missing: string[] = [];
  for (const id of states) {
    for (const width of WIDTHS) {
      const entry = screens.find((s) => s.id === id && (s.viewport as { width: number }).width === width);
      const file = resolve("docs/design/screens", `${id}-${width}.png`);
      if (!entry || !existsSync(file)) { missing.push(`${id}-${width}.png`); continue; }
      assert.equal(entry.filename, `${id}-${width}.png`);
      assert.match(String(entry.url), /^https:\/\/atelier\.test\//);
      assert.match(String(entry.source), /^[0-9a-f]{40}$/);
      assert.ok((entry.fixture as { file?: string }).file, `${id}-${width} names no fixture`);
      assert.ok((entry.browser as { version?: string }).version, `${id}-${width} names no browser version`);
      // A full-page capture is the viewport's width and at least its height.
      const png = size(file);
      assert.equal(png.width, width, `${id}-${width}.png is ${png.width} px wide`);
    }
  }
  const extra = screens.filter((s) => !states.includes(String(s.id))).map((s) => String(s.filename));
  assert.deepEqual(extra, [], "the manifest holds captures the brief does not list");
  assert.deepEqual(missing, [], `${missing.length} capture(s) missing; run npm run design:capture where playwright-core's Chromium is cached`);
});
