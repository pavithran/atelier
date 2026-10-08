import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import type { SpeedRecord } from "../src/models/speed.ts";
import { renderModels, speedSection } from "../src/ui.ts";
import { signIn } from "./signin.ts";

// t260: each model's speed through the Worker's own fetch handler: the
// `speed` field of GET /api/reliability, which `atelier runner --usage`
// prints, and its section on the Models page. The arithmetic is in
// speed.test.ts.

const TOKEN = "speed-test-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const OPUS = "claude-code/opus-5.5", GPT = "codex/gpt-6-astra";
const [H0, H1] = ["0", "1"].map((c) => c.repeat(40));
const L = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));

function call(method: string, path: string, body?: unknown) {
  return worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), testEnv);
}

it("GET /api/reliability carries each model's speed over the stated window, and the Models page shows it", async () => {
  const record = { name: "speed-a", repo: "speed-a", policy: { checks: [], protected: [] }, createdAt: new Date().toISOString() };
  await L("speed-a").setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  const { id } = await L("speed-a").newItem("Work by opus", ["docs/**"], "owner");
  await L("speed-a").claim(id, OPUS);
  await L("speed-a").setFork(id, `speed-a--${id}`, H0, OPUS);
  await L("speed-a").recordPush(id, OPUS, H1, H1);
  await L("speed-a").submit(id, OPUS);
  await call("POST", "/runs", { actor: OPUS, role: "build", outcome: "stalled", project: "speed-a", item: id });

  const res = await call("GET", "/reliability");
  expect(res.status).toBe(200);
  const { speed } = (await res.json()) as { speed: SpeedRecord };
  expect(speed.days).toBe(14);
  expect(speed.minSamples).toBe(3);
  expect(Date.parse(speed.until) - Date.parse(speed.since)).toBe(14 * 86_400_000);
  const opus = speed.models.find((m) => m.model === "opus-5.5")!;
  // One submission and one stalled run: n=1, so no median, and 1 of 2 stalled.
  expect(opus.build).toMatchObject({ n: 1, median: null, runs: 2, stalled: 1 });

  const cookie = await signIn(TOKEN, testEnv);
  const page = await (await worker.fetch(new Request("https://atelier.test/models", { headers: { cookie } }), testEnv)).text();
  expect(page).toContain('aria-label="Speed by model"');
  expect(page).toMatch(/Speed by model · the last 14 days, \d{4}-\d\d-\d\d to \d{4}-\d\d-\d\d/);
  expect(page).toContain("n=1, too few for a median");
  expect(page).toContain("1 of 2 runs stalled (50%)");
});

const SAMPLE: SpeedRecord = {
  days: 14, since: "2026-09-23T12:00:00.000Z", until: "2026-10-07T12:00:00.000Z", minSamples: 3, models: [
    { model: "gpt-6-astra", actors: [GPT], build: { n: 0, median: null, runs: 0, stalled: 0 }, review: { n: 1, median: null, runs: 1, stalled: 0 }, task: { n: 0, median: null } },
    { model: "opus-5.5", actors: [OPUS], build: { n: 3, median: 1200, runs: 4, stalled: 1 }, review: { n: 0, median: null, runs: 0, stalled: 0 }, task: { n: 3, median: 5400 } },
  ],
};

it("the speed section states the window with dates, each median with n, and only n below three", () => {
  const html = speedSection(SAMPLE);
  expect(html).toMatch(/Speed by model · the last 14 days, 2026-09-2\d to 2026-10-0\d/);
  expect(html).toContain('20m<span class="meta">n=3</span><span class="meta">1 of 4 runs stalled (25%)</span>');
  expect(html).toContain('1.5h<span class="meta">n=3</span>');
  expect(html).toMatch(/<code>gpt-6-astra<\/code>[\s\S]*n=1, too few for a median/);
  expect(html).toContain("a model with fewer than 3 shows n and no median");
  expect(speedSection({ ...SAMPLE, models: [] })).toContain("No model built, reviewed or merged anything in the last 14 days");
  // The Models page shows the section when given the record, and not otherwise.
  expect(renderModels([], new Map(), null, "", undefined, new Map(), null, null, SAMPLE)).toContain('aria-label="Speed by model"');
  expect(renderModels([], new Map())).not.toContain("Speed by model");
});
