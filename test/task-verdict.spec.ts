import { env } from "./support/workers.ts";
import { afterAll, beforeAll, expect, it, vi } from "./support/vitest.ts";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { seed, type Seeded } from "./fixtures/design/seed.ts";
import { designEnv, draw, pageStates, serveKeys, session } from "./fixtures/design/pages.ts";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import { stamp } from "../src/time.ts";

// The task page's verdict, track and evidence (t586), entered at worker.fetch
// on the design fixture (test/fixtures/design/pages.ts draw). Trust checks, per
// endpoint: GET /p/ledger-core/tN is the owner's page (Access assertion plus
// session; test/access.spec.ts and test/nav-theme.spec.ts hold the refusals).
// No caller names a disclosure level; the one reader sees every project, so
// each state's page shows the same record to the one audience that may open it.
// The page adds no form, button or route.

let seeded: Seeded;
let pages: Env;
let cookie: string;
const lc = () => seeded.byShape["ledger-core"];
const ledger = () => pages.LEDGER.get(pages.LEDGER.idFromName("project:ledger-core"));

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  seeded = await seed(env);
  pages = designEnv(env, seeded);
  serveKeys();
  cookie = await session(pages);
}, { timeout: 600_000 });
afterAll(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function get(id: string): Promise<string> {
  const res = await draw(pages, `/p/ledger-core/${id}`, "owner", cookie);
  expect(res.status).toBe(200);
  return res.text();
}
const verdictOf = (html: string) => html.match(/<div class="verdict" id="verdict">[^]*?<\/div>/)?.[0] ?? "";
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
const evidenceOf = (html: string) => html.slice(html.indexOf('id="evidence-h"'), html.indexOf('id="changes"'));
const track = (html: string) => {
  const ol = html.slice(html.indexOf('<ol class="track'), html.indexOf("</ol>", html.indexOf('<ol class="track')));
  const word: Record<string, string> = { done: "done", now: "current", next: "todo" };
  return [...ol.matchAll(/<li class="st st-(\w+)[^"]*"( aria-current="step")?><span class="node">.*?<\/span><b class="st-name">(\w+)<\/b><span class="st-note">([^<]*)<\/span>/g)]
    .map((m) => ({ step: m[3], state: word[m[1]], current: !!m[2], note: m[4] }));
};

it("criterion 1: the ready task's page leads with title, state, verdict, track, evidence, the builder's summary under Not verified, Changes, then the folds", async () => {
  const html = await get(lc().ready[1]);
  const at = ["<h2>", 'class="decision-status', 'id="verdict"', '<ol class="track', 'id="evidence-h"', "Not verified", "Implements the change and its test; nothing else moved.", "<h3>Changes</h3>", 'class="folds"'].map((m) => [m, html.indexOf(m)] as const);
  for (const [m, i] of at) expect(i, m).toBeGreaterThan(-1);
  expect(at.map(([, i]) => i)).toEqual([...at.map(([, i]) => i)].sort((a, b) => a - b));
  expect(html).toMatch(/Not verified<\/span><\/h3>\s*<blockquote class="said"><p>“Implements[^<]*”<\/p><footer>[a-z-]+\/[\w.-]+, in its own words<\/footer>/);
});

it("criterion 2: each state's verdict names its source", async () => {
  const ready = text(verdictOf(await get(lc().ready[1])));
  expect(ready).toMatch(/^Approved by [\w.-]+ \((OpenAI|Anthropic|Z\.ai|Google|Alibaba)\)\. (\d+) of \2 required checks passed\./);
  const back = text(verdictOf(await get(lc().sentBack[0])));
  expect(back).toMatch(/^Sent back by [\w.-]+ \((OpenAI|Anthropic|Z\.ai|Google|Alibaba)\): The decision line still says Ready after this rejection; keep the state and the line in step\./);
  const protectedPage = text(verdictOf(await get(lc().protected[0])));
  expect(protectedPage).toContain("review by a model of another company than every contributor");
  const blocked = text(verdictOf(await get(lc().blocked[0])));
  expect(blocked).toMatch(/^Blocked by [\w.-]+ \([\w. ]+\) .+: The baseline's test fixture for sessions is missing; the owner must say which login flow is current\./);
});

it("criterion 3: the verdict holds no control or command, and the page adds no form or button to main's", async () => {
  for (const id of [lc().ready[1], lc().sentBack[0], lc().protected[0], lc().blocked[0], lc().accepted[0]]) {
    // The Land form (t594) is the one control the verdict holds, on a task whose owner call is land or accept.
    const v = verdictOf(await get(id)).replace(/<div class="verdict-land">[\s\S]*?<\/form>(<script[\s\S]*?<\/script>)?<\/div>/, "");
    expect(v, id).not.toMatch(/<form|<button|<pre|<code|atelier land|atelier merge/);
  }
  const ready = await get(lc().ready[1]);
  expect(text(verdictOf(ready))).toContain("Ready to land: land it from chat.");
  expect(ready).not.toContain("atelier land");
  expect(ready).not.toContain("atelier merge");
  // The forms and buttons main drew for each state, taken from main (a353247d's parent, 339aa165) with the same fixture.
  const main: Record<string, { forms: string[]; buttons: string[] }> = {
    "open-long": { forms: ["dispatch", "block", "abandon"], buttons: ["Send", "Block", "Close task without merging"] },
    "working": { forms: ["reject", "block", "handoff", "release", "abandon"], buttons: ["Send review", "Block", "Hand off task", "Release task", "Close task without merging"] },
    "stale": { forms: ["reject", "block", "handoff", "release", "abandon"], buttons: ["Send review", "Block", "Hand off task", "Release task", "Close task without merging"] },
    "blocked": { forms: ["unblock", "abandon"], buttons: ["Unblock", "Close task without merging"] },
    "failed": { forms: ["reject", "block", "handoff", "release", "abandon"], buttons: ["Send review", "Block", "Hand off task", "Release task", "Close task without merging"] },
    "unreadable": { forms: ["land", "reject", "block", "handoff", "release", "abandon"], buttons: ["Land", "Send review", "Block", "Hand off task", "Release task", "Close task without merging"] },
    // Land (t594) is drawn first in the verdict block of a task ready to land, "unreadable" (a ready task whose diff cannot be read) too.
    "ready": { forms: ["land", "reject", "block", "handoff", "release", "abandon"], buttons: ["Land", "Send review", "Block", "Hand off task", "Release task", "Close task without merging"] },
    "protected": { forms: ["approve", "override", "allow-override", "reject", "block", "handoff", "release", "abandon"], buttons: ["Approve revision", "Override the review and accept", "Allow an override from the command line", "Send review", "Block", "Hand off task", "Release task", "Close task without merging"] },
    "sent-back": { forms: ["approve", "reject", "block", "handoff", "release", "abandon"], buttons: ["Approve revision", "Send review", "Block", "Hand off task", "Release task", "Close task without merging"] },
    "accepted": { forms: ["accept", "abandon"], buttons: ["Accept this revision again", "Close task without merging"] },
    "scope": { forms: ["approve", "override", "allow-override", "reject", "block", "handoff", "release", "abandon"], buttons: ["Approve revision", "Override the review and accept", "Allow an override from the command line", "Send review", "Block", "Hand off task", "Release task", "Close task without merging"] },
    "merged": { forms: [], buttons: [] },
    "abandoned": { forms: [], buttons: [] },
  };
  for (const p of pageStates(seeded).filter((x) => x.id.startsWith("task-") && x.id !== "task-not-found")) {
    const body = await (await draw(pages, p.path, "owner", cookie)).text();
    const forms = [...body.matchAll(/<form[^>]*action="([^"]+)"/g)].map((m) => m[1].split("/").pop()!).filter((a) => a !== "logout");
    const buttons = [...body.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]).filter((b) => b !== "Sign out");
    expect({ id: p.id, forms, buttons }, p.id).toEqual({ id: p.id, ...main[p.id.slice(5)] });
  }
});

it("criterion 4: the track is one ol of five steps; ready shows Land current, sent-back its rejection's time, blocked and merged as taskProgress says", async () => {
  const ready = await get(lc().ready[1]);
  expect(ready.match(/<ol class="track/g)).toHaveLength(1);
  expect(track(ready).map((s) => `${s.step}:${s.state}${s.current ? "*" : ""}`)).toEqual(["Claim:done", "Branch:done", "Prove:done", "Review:done", "Land:current*"]);
  const back = track(await get(lc().sentBack[0]));
  expect(back.map((s) => `${s.step}:${s.state}${s.current ? "*" : ""}`)).toEqual(["Claim:done", "Branch:done", "Prove:done", "Review:current*", "Land:todo"]);
  const reviews = (await ledger().detail(lc().sentBack[0])).reviews.filter((r: { approve: boolean }) => !r.approve);
  expect(back[3].note).toBe(`Sent back ${stamp(reviews.at(-1)!.at)}`);
  const blocked = track(await get(lc().blocked[0]));
  expect(blocked.filter((s) => s.current).map((s) => `${s.step}:${s.note}`)).toEqual(["Prove:Blocked here"]);
  expect(track(await get(lc().merged[0])).map((s) => `${s.step}:${s.state}${s.current ? "*" : ""}`)).toEqual(["Claim:done", "Branch:done", "Prove:done", "Review:done", "Land:done"]);
});

it("criterion 5: evidence lists each required check as passed, failed or waiting, with where and when, and no empty time", async () => {
  const detail = await ledger().detail(lc().ready[1]);
  const when = (claim: string) => stamp(detail.evidence.filter((e: { claim: string; head: string }) => e.claim === claim && e.head === detail.item.head).at(-1)!.at);
  const ready = text(evidenceOf(await get(lc().ready[1])));
  expect(ready).toContain(`npm test Passed, in a Cloudflare container ${when("npm test")}`);
  expect(ready).toContain(`npm run typecheck Passed, in a Cloudflare container ${when("npm run typecheck")}`);
  const failed = text(evidenceOf(await get(lc().failed[0])));
  expect(failed).toMatch(/npm test Failed, on a runner, in a clean clone \d{4}-\d\d-\d\d/);
  expect(failed).toMatch(/npm run typecheck Passed/);
  const waiting = await get(lc().working[0]);
  const rows = text(evidenceOf(waiting));
  expect(rows).toContain("npm test Waiting: no run at this revision yet no run yet");
  for (const id of [lc().ready[1], lc().failed[0], lc().working[0]]) expect(text(evidenceOf(await get(id))), id).not.toMatch(/NaN|undefined|null|Invalid/);
});

it("criterion 6: each counting review shows reviewer, company, builder, round and time; a blocking finding shows its place, text and verdict", async () => {
  const id = lc().ready[3];
  const l = ledger();
  const d = await l.detail(id);
  await l.addReview({ itemId: id, head: d.item.head!, criteria: await l.criteria(id), by: "codex/gpt-6-astra", approve: false, note: "One thing blocks it.", at: new Date().toISOString(), findings: [{ file: "src/ui.ts", line: 42, severity: "blocking", text: "The <b>guard</b> never runs." }] });
  const before = text(evidenceOf(await get(id)));
  expect(before).toContain("gpt-6-astra OpenAI asked for changes Built by");
  expect(before).toContain("Round 1");
  expect(before).toContain("Blocking src/ui.ts:42 The &lt;b&gt;guard&lt;/b&gt; never runs. Verdict: not judged yet");
  expect(evidenceOf(await get(id))).not.toContain("<b>guard</b>");
  await l.addFinding(id, "owner", d.item.head!, 1, "confirmed", "checked", { reviewer: "codex/gpt-6-astra" });
  expect(text(evidenceOf(await get(id)))).toContain("Verdict: confirmed");
  const reviewed = text(evidenceOf(await get(lc().sentBack[0])));
  expect(reviewed).toMatch(/glm-5\.3 Z\.ai approved Built by gpt-6-astra .*Round 1 · \d{4}-\d\d-\d\d \d\d:\d\d UTC/);
});

it("criterion 6: two reviews at one head with the same finding each take their own verdict, the newer confirmed over the older refuted", async () => {
  const id = lc().ready[2];
  const l = ledger();
  const d = await l.detail(id);
  const findings = [{ file: "src/same.ts", line: 7, severity: "blocking" as const, text: "Twin finding." }];
  const criteria = await l.criteria(id);
  const add = () => l.addReview({ itemId: id, head: d.item.head!, criteria, by: "codex/gpt-6-astra", approve: false, note: "Twin.", at: new Date().toISOString(), findings });
  await add();
  const older = (await l.detail(id)).reviews.at(-1) as { seq: number };
  await add();
  const newer = (await l.detail(id)).reviews.at(-1) as { seq: number };
  expect(newer.seq).toBeGreaterThan(older.seq);
  await l.addFinding(id, "owner", d.item.head!, 1, "refuted", "no", { reviewSeq: older.seq });
  await l.addFinding(id, "owner", d.item.head!, 1, "confirmed", "yes", { reviewSeq: newer.seq });
  const shown = text(evidenceOf(await get(id)));
  expect(shown).toContain("Verdict: confirmed");
  expect(shown).not.toContain("Verdict: refuted");
});

it("the check output fold carries id=checks, the target the graph's check and review links name", async () => {
  const html = await get(lc().ready[1]);
  expect(html.match(/id="checks"/g)).toHaveLength(1);
  expect(html).toMatch(/<details class="fold" id="checks">(?:(?!<\/details>)[^])*Checks and reviews/);
  expect(html).toContain('id="changes"');
  expect(html).toContain('id="history"');
});

it("criterion 7: scope lists the declared globs and each path outside by name, with K of N files inside, or not read", async () => {
  const scope = text(evidenceOf(await get(lc().scope[0])));
  expect(scope).toContain("docs/**");
  expect(scope).toContain("Outside it: src/rules.ts");
  expect(scope).toContain("0 of 1 files inside");
  const unread = text(evidenceOf(await get(lc().ready[0])));
  expect(unread).toContain("not read");
  expect(unread).not.toContain("files inside");
});

it("criterion 9: the thread, rounds, history, brief and technical details are folds, none open, each holding what main draws", async () => {
  const html = await get(lc().ready[1]);
  const folds = html.slice(html.indexOf('class="folds"'));
  const opens = [...folds.matchAll(/<details class="(?:fold|disclosure)"([^>]*)>\s*<summary>(?:<svg.*?<\/svg>)?(?:<span>)?([^<]*)/g)];
  const names = opens.map((m) => m[2]);
  for (const n of ["Thread", "Earlier rounds", "Task history", "Brief and acceptance criteria", "Technical details and handoff"]) {
    const m = opens.find((o) => o[2] === n);
    expect(m, n).toBeTruthy();
    expect(m![1], n).not.toContain("open");
  }
  expect(names.indexOf("Thread")).toBeLessThan(names.indexOf("Earlier rounds"));
  expect(folds).toContain("Submission rounds");
  expect(folds).toContain('class="timeline"');
  for (const verb of ["handoff", "release", "abandon"]) expect(folds).toContain(`/${verb}"`);
  expect(folds).toContain("Close task without merging");
});

it("criterion 10: every task-page state answers main's status and marker", async () => {
  for (const p of pageStates(seeded).filter((x) => x.id.startsWith("task-") || x.id.startsWith("decisions-"))) {
    const res = await draw(pages, p.path, p.audience, cookie);
    expect([p.id, res.status]).toEqual([p.id, p.status]);
    expect([p.id, (await res.text()).includes(p.marker)]).toEqual([p.id, true]);
  }
});

it("criterion 11: an absent figure reads not recorded or is left out, never NaN, undefined or null, on every task state", async () => {
  for (const p of pageStates(seeded).filter((x) => x.id.startsWith("task-") && x.id !== "task-not-found")) {
    const body = await (await draw(pages, p.path, "owner", cookie)).text();
    // Above the folds: the raw event JSON under Task history is main's, and holds null by design.
    const page = body.slice(body.indexOf('class="task-verdict"'), body.indexOf('class="folds"'));
    expect(page.replace(/<script[^]*?<\/script>/g, "").replace(/<[^>]*>/g, " "), p.id).not.toMatch(/\bNaN\b|\bundefined\b|\bnull\b|Invalid Date|\[object/);  // task-accepted names the match below if it fails
  }
  const merged = await get(lc().merged[0]);
  expect(text(merged)).toContain("Summary not recorded");
});

it("criterion 11: the renderer reads only its arguments, the CSS holds no colour literal, and the core files are unchanged", () => {
  const src = readFileSync("src/task-verdict.ts", "utf8");
  const imports = [...src.matchAll(/^import .* from "([^"]+)";/gm)].map((m) => m[1]);
  expect(imports.filter((i) => /ledger|fetch|index/.test(i))).toEqual([]);
  expect(src).not.toMatch(/\bfetch\(|\.detail\(|LEDGER|await /);
  const css = readFileSync("src/task-verdict.css", "utf8");
  expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(\s*\d|\bhsla?\(|\boklch\(|\b(white|black|red|green|blue|gold|orange)\b\s*[;,)]/);
  // src/index.ts and src/ledger.ts are wired by t594 (the Land action), so only the theme stays as it was.
  expect(execFileSync("git", ["diff", "--name-only", "b91b451d", "--", "src/theme.css"], { encoding: "utf8" })).toBe("");
});

// Criterion 12: the committed 390 px shots are of pages that do not scroll sideways. The drawn HTML is loaded
// in Chromium (the build playwright-core names, or ATELIER_CAPTURE_CHROMIUM) with every other request aborted.
it("criterion 12: the ready, sent-back and protected pages have no sideways scroll at 390 px, light and dark", async () => {
  const executablePath = process.env.ATELIER_CAPTURE_CHROMIUM || chromium.executablePath();
  expect(existsSync(executablePath), `no Chromium at ${executablePath}`).toBe(true);
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    for (const [name, id] of [["ready", lc().ready[1]], ["sent-back", lc().sentBack[0]], ["protected", lc().protected[0]]] as const) {
      const body = await get(id);
      for (const scheme of ["light", "dark"] as const) {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: scheme });
        const page = await context.newPage();
        await page.route("**/*", (route) => route.request().url().startsWith("http://page.test/") ? route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body }) : route.abort());
        await page.goto("http://page.test/task");
        const m = await page.evaluate("({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth })") as { client: number; scroll: number };
        expect({ name, scheme, wide: m.scroll > m.client }, `${name} ${scheme}: scrollWidth ${m.scroll}, client ${m.client}`).toEqual({ name, scheme, wide: false });
        expect(m.scroll).toBeLessThanOrEqual(390);
        await context.close();
      }
    }
  } finally { await browser.close(); }
});
