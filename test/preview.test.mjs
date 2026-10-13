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
  ["/p/atelier/code", "Code · atelier", "atelier"],
  ["/p/atelier/log", "Log · atelier", "atelier"],
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
  for (const [path, crumb] of [["/p/atelier/tasks", "Tasks"], ["/p/atelier/flow", "Activity"], ["/p/atelier/plans", "Plans"], ["/p/atelier/ship", "Ship"], ["/p/atelier/settings", "Settings"], ["/p/atelier/code", "Code"], ["/p/atelier/log", "Log"], ["/p/atelier/t4", "t4"]]) {
    const html = await (await fetch(base + path)).text();
    assert.ok(html.includes(`<p class="crumb"><a href="/p/atelier">atelier</a> › <span>${crumb}</span></p>`), `${path} does not name ${crumb} in the bar`);
    if (path !== "/p/atelier/t4") assert.ok(!html.includes("<title>Run checks in a Cloudflare container"), `${path} drew task t1's page`);
  }
});

// Every same-origin link on every page the preview serves, followed from the
// bar's destinations, is itself served (codex/gpt-6-astra's and Gemini 4
// Argon's reviews of t604: the Code tab and its Log, the fork's code and log
// from a task, a commit from Flow, and the tasks History and Plans link to
// were 404s). Query strings are kept: ?at=, ?page= and ?state= pages too.
test("every link on every page the preview serves is itself served", async () => {
  const start = ["/", "/decisions", "/home", "/studio", "/flow", "/history", "/models", "/usage", "/login", "/how", "/error", "/p/atelier"];
  const from = new Map(start.map((p) => [p, "(start)"]));
  const queue = [...start];
  const broken = [];
  const done = new Set();
  while (queue.length) {
    const path = queue.shift();
    if (done.has(path)) continue;
    done.add(path);
    const res = await fetch(base + path);
    const html = await res.text();
    if (res.status !== 200) { broken.push(`${path} (${res.status}, linked from ${from.get(path)})`); continue; }
    if (html.includes("<!--shell:")) broken.push(`${path} (shell marker left)`);
    for (const m of html.matchAll(/href="(\/(?!\/)[^"]*)"/g)) {
      const link = m[1].replaceAll("&amp;", "&").split("#")[0];
      if (!from.has(link)) { from.set(link, path); queue.push(link); }
    }
  }
  assert.deepEqual(broken, []);
  // The crawl reached the browsing pages, not only the bar's.
  for (const p of ["/p/atelier/code", "/p/atelier/log", "/p/atelier/t1/code", "/p/atelier/t1/log", "/p/atelier/t5", "/p/atelier/t6"]) assert.ok(done.has(p), `the crawl never reached ${p}`);
  assert.ok([...done].some((p) => /^\/p\/atelier\/t1\/commit\//.test(p)), "the crawl reached no commit page");
  assert.ok([...done].some((p) => /^\/p\/atelier\/(t\d+\/)?history\//.test(p)), "the crawl reached no file history");
});

// The ?state= variants change the task the address names, t4 as much as t1:
// the task is chosen before the state is applied.
test("a task's ?state= variants apply to the task the address names", async () => {
  const LONG = "Review a project with a very long title, extensive agent output, and deeply nested files that must remain readable on a phone";
  for (const id of ["t1", "t4"]) {
    const long = await (await fetch(`${base}/p/atelier/${id}?state=long`)).text();
    assert.ok(long.includes(`<title>${LONG} · Atelier</title>`), `${id}?state=long kept its own title`);
    // The task's status line, as renderItem words each state.
    const plain = await (await fetch(`${base}/p/atelier/${id}`)).text();
    for (const [state, words] of [["accepted", "Ready to merge"], ["merged", "Merged into the project"]]) {
      const html = await (await fetch(`${base}/p/atelier/${id}?state=${state}`)).text();
      assert.ok(html.includes(`>${words}<`), `${id}?state=${state} is not drawn as "${words}"`);
      assert.ok(!plain.includes(`>${words}<`), `${id} is drawn as "${words}" with no state`);
    }
    for (const state of ["failed", "ready", "local", "local-strict", "unavailable", "empty"]) {
      const res = await fetch(`${base}/p/atelier/${id}?state=${state}`);
      assert.equal(res.status, 200, `${id}?state=${state}`);
      assert.ok(!(await res.text()).includes("<!--shell:"));
    }
  }
  for (const path of ["/decisions?state=empty", "/home?state=empty", "/studio?state=empty", "/flow?state=empty", "/usage?state=empty", "/p/atelier/plans?state=empty", "/decisions?task=t4"]) {
    const res = await fetch(base + path);
    assert.equal(res.status, 200, path);
    assert.ok(!(await res.text()).includes("<!--shell:"), path);
  }
});

test("an address the preview does not serve is a 404, not the Decisions page", async () => {
  const res = await fetch(`${base}/no-such-page`);
  assert.equal(res.status, 404);
  assert.equal((await fetch(`${base}/p/atelier/t99`)).status, 404);
  // A name an object inherits is no file (codex/gpt-6-astra's second review
  // of t604: /p/atelier/code/constructor crashed the server).
  for (const name of ["constructor", "toString", "__proto__"]) {
    for (const path of [`/p/atelier/code/${name}`, `/p/atelier/history/${name}`, `/p/atelier/t1/code/${name}`]) {
      assert.equal((await fetch(base + path)).status, 404, path);
    }
  }
  assert.equal((await fetch(`${base}/p/atelier/code`)).status, 200, "the preview still serves after those requests");
});
