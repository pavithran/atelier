// The account-free preview (README, "Try it without an account") serves
// every page its bar and tabs link to, each as its own page with the bar
// filled. Gemini 4 Argon's claims audit of 2026-10-13, findings 6 and 11:
// /projects crashed the server (renderProjects was gone), /home, /flow,
// /models and /usage fell through to the Decisions page, every /p/atelier/TAB
// drew task t1, and the bar kept its raw <!--shell:...--> markers.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let child;
let base;

before(async () => {
  child = spawn(process.execPath, ["test/preview.mjs"], { cwd: ROOT, env: { ...process.env, PORT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  child.stderr.on("data", (d) => { err += d; });
  base = await new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
      const m = out.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (m) resolve(m[0]);
    });
    child.on("exit", (code) => reject(new Error(`preview exited ${code} before printing its address: ${err}`)));
  });
});

after(() => { child?.kill(); });

// Each path, and the <title> and <h1> its own page draws.
const PAGES = [
  ["/decisions", "Decisions", "Decisions · 1"],
  ["/home", "Home", "Home"],
  ["/projects", "Home", "Home"],
  ["/flow", "Flow", null],
  ["/models", "Models", "Models"],
  ["/usage", "Usage", "Usage"],
  ["/studio", "Studio", "Studio"],
  ["/history", "History", "History"],
  ["/p/atelier", "atelier", "atelier"],
  ["/p/atelier/tasks", "atelier", "atelier"],
  ["/p/atelier/flow", "Flow · atelier", "atelier"],
  ["/p/atelier/plans", "atelier", "atelier"],
  ["/p/atelier/ship", "Ship · atelier", "atelier"],
  ["/p/atelier/settings", "Settings · atelier", "atelier"],
  ["/p/atelier/t1", "Run checks in a Cloudflare container", null],
  ["/p/atelier/t4", "Test the ledger end to end", null],
];

for (const [path, title, h1] of PAGES) {
  test(`the preview serves ${path} as its own page with the bar filled`, async () => {
    const res = await fetch(base + path);
    const html = await res.text();
    assert.equal(res.status, 200, `${path}: ${html.slice(0, 300)}`);
    assert.ok(!html.includes("<!--shell:"), `${path} left a shell marker unfilled`);
    const shown = html.match(/<title>(.*?) · Atelier<\/title>/)?.[1];
    assert.ok(shown?.includes(title), `${path} has title ${shown}, not one naming ${title}`);
    if (h1) assert.match(html, new RegExp(`<h1[^>]*>${h1}</h1>`), `${path} has no <h1>${h1}</h1>`);
    // The switcher lists the project, as the server's bar does.
    assert.match(html, /data-shell="projects"><a href="\/home">All projects<\/a><a href="\/p\/atelier">atelier/);
  });
}

test("a project tab is drawn as that tab, not as task t1", async () => {
  // The bar's crumb names the page; Plans is held under Tasks and Ship under Settings.
  for (const [path, crumb] of [["/p/atelier/tasks", "Tasks"], ["/p/atelier/flow", "Activity"], ["/p/atelier/plans", "Plans"], ["/p/atelier/ship", "Ship"], ["/p/atelier/settings", "Settings"], ["/p/atelier/t4", "t4"]]) {
    const html = await (await fetch(base + path)).text();
    assert.ok(html.includes(`<p class="crumb"><a href="/p/atelier">atelier</a> › <span>${crumb}</span></p>`), `${path} does not name ${crumb} in the bar`);
    if (path !== "/p/atelier/t4") assert.ok(!html.includes("<title>Run checks in a Cloudflare container"), `${path} drew task t1's page`);
  }
});

test("an address the preview does not serve is a 404, not the Decisions page", async () => {
  const res = await fetch(`${base}/no-such-page`);
  assert.equal(res.status, 404);
  assert.equal((await fetch(`${base}/p/atelier/t99`)).status, 404);
});
