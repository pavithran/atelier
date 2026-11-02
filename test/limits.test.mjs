// Atelier 2.0, G6 criterion 4: one limits module names the constants the
// stage tick, the server's timers and the stuck notices run by, and this test
// lists them. A limit changed in the module changes what its readers do; a
// limit of those modules declared anywhere else fails here.
import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LIMITS, STAGE_LIMITS_MS } from "../src/limits.ts";
import { findStageOverrun } from "../src/stage-tick.ts";
import { dueNotices } from "../src/stuck/notices.ts";
import { decideLandQueue } from "../src/stage-tick.ts";

const MIN = 60_000, HOUR = 60 * MIN;

test("the limits module names every remaining limit, and nothing else", () => {
  assert.deepEqual(LIMITS, {
    stageMs: { filed: 24 * HOUR, agreed: 48 * HOUR, queued: 10 * MIN, built: 20 * MIN, checked: 10 * MIN, reviewed: 2 * HOUR, landable: 60 * MIN },
    tickStaleMs: 15 * MIN,
    timers: { stageTickMs: 5 * MIN, stuckEpisodesMs: 10 * MIN, modelSnapshotsMs: 6 * HOUR, modelSnapshotsOffsetMs: 7 * MIN },
    noticeAfterMs: 60 * MIN,
    landRequeuesForMain: 2,
  });
  assert.equal(STAGE_LIMITS_MS, LIMITS.stageMs, "rules.ts's STAGE_LIMITS_MS is the module's own object");
});

test("a limit changed in the module changes what its readers do", () => {
  const item = { id: "t1", createdAt: "2026-10-28T00:00:00.000Z", lastPushAt: null, dispatch: null };
  const at = new Date(Date.parse(item.createdAt) + 2 * HOUR);
  const was = { filed: LIMITS.stageMs.filed, notice: LIMITS.noticeAfterMs, requeues: LIMITS.landRequeuesForMain };
  try {
    assert.equal(findStageOverrun(item, "filed", undefined, at), null);
    LIMITS.stageMs.filed = HOUR;
    assert.equal(findStageOverrun(item, "filed", undefined, at)?.limitMs, HOUR);

    const opened = [{ project: "p", item: "t1", cause: "c", episode: 1, kind: "opened", at: item.createdAt, reason: "" }];
    assert.equal(dueNotices(opened, new Set(), Date.parse(item.createdAt) + 30 * MIN).length, 0);
    LIMITS.noticeAfterMs = 20 * MIN;
    assert.equal(dueNotices(opened, new Set(), Date.parse(item.createdAt) + 30 * MIN).length, 1);

    const moved = (n) => Array.from({ length: n }, (_, i) => ({ at: new Date(Date.parse(item.createdAt) + i).toISOString(), main: `m${i}`, reason: i ? "main-moved" : "first" }));
    const land = (queued) => decideLandQueue({ item: "t1", accepted: true, fast: false, lease: null, lander: true, queued, main: "new", now: at });
    assert.equal(land(moved(3)).acts, false);
    LIMITS.landRequeuesForMain = 3;
    assert.equal(land(moved(3)).queue, "main-moved");
  } finally {
    LIMITS.stageMs.filed = was.filed;
    LIMITS.noticeAfterMs = was.notice;
    LIMITS.landRequeuesForMain = was.requeues;
  }
});

// The tick's modules: no limit is declared in them but through LIMITS.
const TICK_MODULES = ["src/stage-tick.ts", "src/stuck/notices.ts", "src/runtime/timers.mjs", "src/runtime/server.mjs"];
const DECLARED = /\b(?:const|let|var)\s+([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=\s*(?:\d|\(\s*\d)/g;
const TIME = /\b\d[\d_]*\s*\*\s*(?:60[_0-9]*|MINUTE|HOUR)\b/g;

test("a limit of the tick's modules declared outside the limits module fails", () => {
  for (const file of TICK_MODULES) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
    assert.deepEqual([...text.matchAll(DECLARED)].map((m) => m[1]), [], `${file} declares a limit of its own`);
    assert.deepEqual([...text.matchAll(TIME)].map((m) => m[0]), [], `${file} computes a time limit of its own`);
  }
  // And none of the limits' old names is declared anywhere in the source.
  const old = /\b(?:const|let|var)\s+(STAGE_LIMITS_MS|STAGE_TICK_MS|STAGE_TICK_STALE_MS|NOTICE_AFTER_MS|LAND_REQUEUES_FOR_MAIN|STAGE_CRON|STUCK_CRON)\b/;
  const walk = (dir) => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : /\.(ts|mjs)$/.test(f) ? [p] : []; });
  const root = new URL("..", import.meta.url).pathname;
  for (const file of [...walk(join(root, "src")), ...walk(join(root, "cli"))]) {
    if (file.endsWith("src/limits.ts")) continue;
    assert.doesNotMatch(readFileSync(file, "utf8"), old, file);
  }
});

test("the scan catches a limit declared in a tick module", () => {
  assert.deepEqual([..."const QUEUED_MS = 10 * 60_000;".matchAll(DECLARED)].map((m) => m[1]), ["QUEUED_MS"]);
  assert.deepEqual([..."if (age > 10 * 60_000) stuck();".matchAll(TIME)].map((m) => m[0]), ["10 * 60_000"]);
});
