import { afterAll, beforeAll, expect, it, vi } from "./support/vitest.ts";
import { env } from "./support/workers.ts";
import worker from "../src/index.ts";
import { signIn } from "./signin.ts";
import { withoutDefaultRunner } from "./support/default-runner.ts";

// Which jobs /rigs draws (t608 fix round), entered at worker.fetch as the owner. GET /rigs keeps the trust
// checks of rigs.spec.ts: the owner's session, as Today answers; no caller names a disclosure level.

const TOKEN = "rigs-token";
const ORIGIN = "https://atelier.test";
const OWNER = "owner";
const T = Date.parse("2026-11-09T18:00:00.000Z");
const min = (n: number) => n * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const L = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
const I = () => env.LEDGER.get(env.LEDGER.idFromName("__index"));
const ids: string[] = [];
let pages: Env;
let cookie: string;
let stalled: string;

async function poll(runner: string): Promise<void> {
  vi.setSystemTime(new Date(T - 30_000));
  const res = await worker.fetch(new Request(`${ORIGIN}/api/queue`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": OWNER, "x-atelier-acting": "claude-code/opus-5.5", "content-type": "application/json" },
    body: JSON.stringify({ runner, kind: "home", jobs: ["build"], agents: [{ agent: "claude-code", models: ["sonnet-5.5"] }] }),
  }), pages);
  expect(res.status, `${runner} poll`).toBe(200);
}

// A task claimed on `runner` whose progress record was last changed `quiet` minutes ago and has not ended.
async function run(title: string, runner: string, quiet: number): Promise<string> {
  const l = L("atelier");
  vi.setSystemTime(new Date(T - min(300)));
  const item = await l.newItem(title, [], OWNER, {});
  await l.claim(item.id, "claude-code/sonnet-5.5", { runner, kind: "home" });
  const at = iso(T - min(quiet));
  vi.setSystemTime(new Date(T - min(quiet)));
  await l.recordProgress(runner, [{ task: item.id, actor: "claude-code/sonnet-5.5", startedAt: at, at, harness: null, telemetry: true, commands: { started: 1, completed: 1 }, commits: 0, changedFiles: 1, childAlive: true, log: "/var/atelier/runs/x/build.progress.jsonl", current: { name: "Bash", summary: "npm test", since: at } }]);
  return item.id;
}

beforeAll(async () => {
  withoutDefaultRunner();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(T - min(400)));
  const record = { name: "atelier", repo: "atelier", title: "atelier", policy: { checks: ["npm test"], protected: [] }, createdAt: iso(T - min(400)) };
  await I().registerProject(record);
  await L("atelier").setProject(record, OWNER);
  pages = { ...env, ATELIER_TOKEN: TOKEN, OWNER_NAME: "Owner", TIMEZONE: "UTC" } as unknown as Env;
  for (let n = 1; n <= 13; n++) {
    const runner = `home:studio-w${String(n).padStart(2, "0")}`;
    await poll(runner);
    ids.push(await run(`Running task ${n}`, runner, 2));
  }
  await poll("home:mini-slow");
  stalled = await run("Long silent command", "home:mini-slow", 45);
  vi.setSystemTime(new Date(T));
  cookie = await signIn(TOKEN, pages);
}, { timeout: 120_000 });
afterAll(() => { vi.useRealTimers(); });

const drawn = async () => (await worker.fetch(new Request(`${ORIGIN}/rigs`, { headers: { cookie } }), pages)).text();

it("fix 1: thirteen running tasks of one project on thirteen live runners each show a train and the working model", async () => {
  const html = await drawn();
  for (const id of ids) expect(html, id).toContain(`class="train" data-task="${id}"`);
  expect(html.match(/data-lamp="busy"/g)?.length).toBeGreaterThanOrEqual(13);
  expect(html.match(/class="train"/g)?.length).toBeGreaterThanOrEqual(13);
});

it("fix 2: a task past the stall limit with an unfinished progress record on a live runner keeps its train and busy lamp", async () => {
  const html = await drawn();
  expect(html).toContain(`class="train" data-task="${stalled}"`);
  const track = html.slice(html.indexOf('data-runner="home:mini-slow"'));
  expect(track.slice(0, track.indexOf("</section>"))).toContain('data-lamp="busy"');
});
