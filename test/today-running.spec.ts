import "./today-clock.ts";
import { env } from "./support/workers.ts";
import { afterAll, beforeAll, expect, it, vi } from "./support/vitest.ts";
import worker from "../src/index.ts";
import { FIXED_NOW, OWNER, seed, type Seeded } from "./fixtures/design/seed.ts";
import { ORIGIN, TOKEN, assertion, designEnv, serveKeys, session } from "./fixtures/design/pages.ts";
import { machineName } from "../src/runner-names.ts";
import { STALL_MS } from "../src/situation.ts";
import type { ProgressRecord } from "../src/situation.ts";

// Today's Running rows (t578), entered at worker.fetch on the design fixture
// (test/fixtures/design/seed.ts) with progress records added through the
// Ledger's own recordProgress, as a runner's poll does. Trust checks, per
// endpoint: GET / is the owner's page (Access assertion plus session, 303 or
// 401 without; test/today-routes.spec.ts holds those refusals). No caller names
// a disclosure level; the one reader sees every project, and a progress
// record carries no text but a program name, so what a row shows is the same
// at every audience that may see the page at all.

const PROJECT = "open-tool";
const NOW = Date.parse(FIXED_NOW);
const min = (n: number) => n * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const LOG = "/var/atelier/runs/t-private-log-7731/build.progress.jsonl";

let seeded: Seeded;
let pages: Env;
let cookie: string;
const ledger = () => pages.LEDGER.get(pages.LEDGER.idFromName(`project:${PROJECT}`));

interface Made { id: string; record: ProgressRecord | null }
const made: Record<string, Made> = {};

// A task claimed by `actor` on `runner`, with the report that runner sent at `reportedAt`.
async function build(key: string, o: { actor: string; runner: string; reportedAt?: number; claimedAt?: number; report?: Record<string, unknown> | null; reportTwice?: boolean }) {
  vi.setSystemTime(new Date(o.claimedAt ?? NOW - min(120)));
  const l = ledger();
  const item = await l.newItem(`Running row ${key}`, [], OWNER, {});
  await l.claim(item.id, o.actor, { runner: o.runner, kind: "home" });
  if (o.report !== null) {
    const started = NOW - min(20);
    const report = { task: item.id, actor: o.actor, startedAt: iso(started), at: iso(started), harness: null, telemetry: true, commands: { started: 5, completed: 4 }, commits: 0, changedFiles: 0, childAlive: true, log: LOG, ...o.report };
    if (o.reportTwice) {
      vi.setSystemTime(new Date(started - min(30)));
      await l.recordProgress(o.runner, [{ ...report, startedAt: iso(started - min(40)), at: iso(started - min(40)) }]);
    }
    vi.setSystemTime(new Date(o.reportedAt ?? NOW));
    await l.recordProgress(o.runner, [report]);
  }
  made[key] = { id: item.id, record: await l.progressOf(item.id) };
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  seeded = await seed(env);
  pages = designEnv(env, seeded);
  serveKeys();
  cookie = await session(pages);
  const T = NOW;
  await build("studio", { actor: "claude-code/sonnet-5.5", runner: "home:studio-atelier-build", reportTwice: true,
    report: { startedAt: iso(T - min(12)), at: iso(T), current: { name: "Bash", summary: "npm", since: iso(T - 40_000) }, last: { name: "Edit", summary: null, at: iso(T - min(2)), error: false }, commits: 0, changedFiles: 1 } });
  await build("mini", { actor: "claude-code/sonnet-5.5", runner: "home:mini-atelier-build",
    report: { startedAt: iso(T - min(18)), at: iso(T), current: null, last: { name: "Edit", summary: null, at: iso(T - min(3)), error: false }, commits: 2, changedFiles: 4 } });
  await build("macbook", { actor: "codex/gpt-6-astra", runner: "home:macbook-atelier-build",
    report: { startedAt: iso(T - min(26)), at: iso(T), current: { name: "Bash", summary: "git", since: iso(T - min(1)) }, last: null, commits: 1, changedFiles: 3 } });
  await build("rack", { actor: "antigravity/gemini-3.1-pro", runner: "home:rack7-build",
    report: { startedAt: iso(T - min(5)), at: iso(T), current: { name: "Bash", summary: "node", since: iso(T - 30_000) }, commits: 1, changedFiles: 2 } });
  await build("opencode", { actor: "opencode/qwen-4", runner: "home:studio-miqra-build",
    report: { startedAt: iso(T - min(40)), at: iso(T), telemetry: false, harness: "opencode", commands: { started: 0, completed: 0 }, current: null, last: null, commits: 3, changedFiles: 6, childAlive: null } });
  await build("zai", { actor: "zcode/glm-5.3", runner: "home:studio-atelier-build", report: { startedAt: iso(T - min(9)), at: iso(T), current: { name: "Edit", summary: null, since: iso(T - min(1)) }, commits: 1, changedFiles: 1 } });
  await build("quiet", { actor: "claude-code/opus-5.5", runner: "home:macbook-atelier-build", reportedAt: T - min(12),
    report: { startedAt: iso(T - min(30)), at: iso(T - min(12)), current: { name: "Bash", summary: "npm", since: iso(T - min(12)) }, commits: 1, changedFiles: 3 } });
  await build("silent-dead", { actor: "claude-code/opus-5.5", runner: "home:mini-atelier-build", report: { childAlive: false, current: { name: "Bash", summary: "npm", since: iso(T - min(3)) } } });
  await build("silent-alive", { actor: "claude-code/opus-5.5", runner: "home:mini-atelier-build", report: { childAlive: true, current: { name: "Bash", summary: "npm", since: iso(T - min(3)) } } });
  await build("silent-unknown", { actor: "claude-code/opus-5.5", runner: "home:mini-atelier-build", report: { childAlive: null, current: { name: "Bash", summary: "npm", since: iso(T - min(3)) } } });
  await build("unreported", { actor: "claude-code/sonnet-5.5", runner: "home:studio-atelier-build", report: null, claimedAt: T - min(5) });
  vi.setSystemTime(new Date(T));
}, { timeout: 600_000 });
afterAll(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const owner = async (path: string) =>
  worker.fetch(new Request(`${ORIGIN}${path}`, { headers: { "cf-access-jwt-assertion": await assertion(), cookie }, redirect: "manual" }), pages);

async function today(at: number): Promise<string> {
  vi.setSystemTime(new Date(at));
  const res = await owner("/");
  expect(res.status).toBe(200);
  return res.text();
}

const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const running = (html: string) => { const from = html.indexOf('id="running"'); return html.slice(from, html.indexOf("</section>", from)); };
// One lane's markup, found by its task id.
function lane(html: string, key: string): string {
  const id = made[key].id;
  const block = running(html);
  const start = block.indexOf(`data-task="${id}"`);
  if (start < 0) throw new Error(`no lane for ${key} (${id}) in the Running section`);
  const from = block.lastIndexOf('<div class="today-lane', start);
  const end = block.indexOf('<div class="today-lane', from + 10);
  return block.slice(from, end < 0 ? undefined : end);
}
const attr = (row: string, name: string) => new RegExp(`${name}="([^"]*)"`).exec(row.slice(0, row.indexOf(">") + 1))?.[1];

// Criterion 1: machine name, runner id, model and attempt come from the record.
it("a Running row shows its machine, runner id, model and attempt when above 1, each equal to the record's", async () => {
  const html = await today(NOW + min(1));
  const table: [string, string, string, string | null][] = [
    ["studio", "Mac Studio", "sonnet-5.5", "attempt 2"], ["mini", "Mac mini", "sonnet-5.5", null], ["macbook", "MacBook Pro", "gpt-6-astra", null],
  ];
  for (const [key, machine, model, attempt] of table) {
    const rec = made[key].record!;
    const row = lane(html, key), words = text(row);
    expect(attr(row, "data-runner"), key).toBe(rec.runner);
    expect(row, key).toContain(`title="${rec.runner}"`);
    expect(words, key).toContain(machine);
    expect(words, key).toContain(rec.runner.replace(/^home:[a-z0-9]+-/, ""));
    expect(words, key).toContain(rec.actor.split("/")[1]);
    expect(model).toBe(rec.actor.split("/")[1]);
    if (attempt) expect(words, key).toContain(attempt); else expect(words, key).not.toMatch(/attempt \d/);
  }
  expect(made.studio.record!.attempt).toBe(2);
});

// Criterion 2: command, its age, run age, commits and files.
it("a Running row shows the current command and how long it has run, the run's age, commits and changed files", async () => {
  const html = await today(NOW + 5_000);
  const studio = text(lane(html, "studio")), mini = text(lane(html, "mini")), mac = text(lane(html, "macbook"));
  expect(studio).toContain("Bash running 45 s");
  expect(studio).toContain("12 min");
  expect(studio).toContain("1 file");
  expect(studio).not.toMatch(/\b0 commits?\b/);
  // No current command: the last one and when.
  expect(mini).toContain("last Edit 3 min ago");
  expect(mini).toContain("18 min");
  expect(mini).toContain("2 commits · 4 files");
  expect(mac).toContain("Bash running 1 min");
  expect(mac).toContain("26 min");
  expect(mac).toContain("1 commit · 3 files");
});

// Criterion 3: the table of machine names.
it("one table names each known host and leaves an unknown runner id as it is", async () => {
  expect([machineName("home:studio-atelier-build"), machineName("home:mini-atelier-review"), machineName("home:macbook-atelier-build")]).toEqual(["Mac Studio", "Mac mini", "MacBook Pro"]);
  expect(machineName("home:rack7-build")).toBe("home:rack7-build");
  expect(machineName("cloud")).toBe("cloud");
  const html = await today(NOW + min(1));
  const rack = lane(html, "rack");
  expect(text(rack)).toContain("home:rack7-build");
  expect(text(rack)).not.toMatch(/Mac Studio|Mac mini|MacBook/);
});

// Criterion 4: live, quiet and stalled as the record and STALL_MS define them.
it("the live dot lasts to 10 minutes of no change, the quiet marker names the minutes, and stalled follows STALL_MS and childAlive", async () => {
  // Reported 12 minutes before the fixture's now: quiet from the first read.
  const shown = lane(await today(NOW), "quiet");
  expect(attr(shown, "data-pulse")).toBe("quiet");
  expect(text(shown)).toContain("no change for 12 min");
  expect(text(shown)).toContain("Bash running 12 min");
  const changed = NOW;
  const live = lane(await today(changed + min(10) - 1000), "studio");
  expect(attr(live, "data-pulse")).toBe("live");
  expect(text(live)).not.toContain("no change for");
  const quiet = lane(await today(changed + min(10)), "studio");
  expect(attr(quiet, "data-pulse")).toBe("quiet");
  expect(text(quiet)).toContain("no change for 10 min");
  expect(text(quiet)).not.toContain("stalled");
  const late = await today(changed + STALL_MS);
  const dead = lane(late, "silent-dead"), alive = lane(late, "silent-alive"), unknown = lane(late, "silent-unknown");
  expect(attr(dead, "data-pulse")).toBe("stalled");
  expect(text(dead)).toContain("stalled");
  for (const row of [alive, unknown]) {
    expect(attr(row, "data-pulse")).toBe("quiet");
    expect(text(row)).toContain("no change for 30 min");
    expect(text(row)).not.toContain("stalled");
  }
  // One millisecond short of STALL_MS, a dead child is not yet a stall.
  const early = lane(await today(changed + STALL_MS - 1000), "silent-dead");
  expect(attr(early, "data-pulse")).toBe("quiet");
  expect(text(early)).not.toContain("stalled");
});

// Criterion 5: no record, no invented figures.
it("a Running task with no progress record shows its stage and no empty, undefined, NaN or 0 figure", async () => {
  const html = await today(NOW + min(1));
  const row = lane(html, "unreported");
  const words = text(row);
  expect(words).toContain("Branch");
  expect(words).not.toMatch(/undefined|NaN|\bnull\b|\b0 (min|s|commits?|files?)\b|attempt/);
  expect(row).not.toMatch(/<span class="today-(how|stg|cnt|cnt2|big|rn|who|where)"><\/span>/);
  expect(words).not.toContain("Mac Studio");
  for (const key of ["studio", "mini", "macbook", "rack", "opencode", "zai"]) expect(text(lane(html, key)), key).not.toMatch(/undefined|NaN|\bnull\b|\b0 (min|s|commits?|files?)\b/);
});

// Criterion 6: telemetry false.
it("a run whose record has telemetry false reads 'sends no commands' with the time of its last change", async () => {
  const html = await today(NOW + min(2));
  const row = text(lane(html, "opencode"));
  expect(row).toContain("opencode sends no commands · changed 2 min ago");
  expect(row).not.toMatch(/running \d|last [A-Z]/);
  expect(row).toContain("3 commits · 6 files");
});

// Criterion 7: edge colour by company, from the theme's variables.
it("each row's edge colour is its actor's company in an existing theme variable, and today.css adds no colour literal", async () => {
  const html = await today(NOW + min(1));
  const css = (await import("node:fs")).readFileSync(new URL("../src/today.css", import.meta.url), "utf8");
  const theme = (await import("node:fs")).readFileSync(new URL("../src/theme.css", import.meta.url), "utf8");
  const edge: Record<string, [string, string]> = { anthropic: ["studio", "--signal-hot"], openai: ["macbook", "--observed"], google: ["rack", "--music-accent"], other: ["opencode", "--text-dim"] };
  for (const [company, [key, variable]] of Object.entries(edge)) {
    expect(attr(lane(html, key), "data-company"), key).toBe(company);
    const rule = new RegExp(`\\.today-lane\\.co-${company}\\s*\\{[^}]*border-left-color:\\s*var\\(${variable}\\)`).exec(css);
    expect(rule, `${company} edge rule`).not.toBeNull();
    expect(theme).toContain(`${variable}:`);
    expect(lane(html, key)).toContain(`co-${company}`);
  }
  expect(attr(lane(html, "zai"), "data-company")).toBe("other");
  const added = css.replace(/\/\*[\s\S]*?\*\//g, "");
  expect(added).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(\s*\d|\bhsla?\(|\boklch\(|\bgradient\(/);
});

// Criterion 9: the log stays on the runner's host.
it("no log path or log text from the progress record is in the page", async () => {
  const html = await today(NOW + min(1));
  expect(made.studio.record!.log).toBe(LOG);
  for (const piece of [LOG, "t-private-log-7731", "build.progress.jsonl", "/var/atelier"]) expect(html).not.toContain(piece);
});

// The screenshots in docs/design/today-running/shots are taken of this page: with ATELIER_TODAY_RUNNING_HTML naming a file, the page as drawn is written there.
it("writes the page for the screenshots when asked", async () => {
  const out = process.env.ATELIER_TODAY_RUNNING_HTML;
  if (!out) return;
  const html = await today(NOW + 1000);
  (await import("node:fs")).writeFileSync(out, html);
  expect(html).toContain('data-pulse="live"');
});
