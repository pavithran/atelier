// The limits the stage tick, the server's timers and the stuck notices run
// by (Atelier 2.0, G6: "one limits module names the remaining constants").
// Each is an age the tick reads (the tick records no stage.stuck since t518),
// never a trigger for the server to act on a judgment of its own: past a limit nothing is rerouted,
// re-pointed, released or filed. The only automatic actions are the
// standing instructions the developer records (src/standing.ts).
//
// Readers read these through LIMITS at the moment they judge, so a limit
// changed here changes what they do. test/limits.test.mjs lists every one,
// and fails when a limit of the tick's modules is declared anywhere else.

import type { TaskStage } from "./rules.ts";

const MINUTE = 60_000, HOUR = 60 * MINUTE;

export const LIMITS = {
  // How long a task may stay at a stage before the tick records it as stuck
  // (t223). Stages not listed (building, landed, shipped) have no limit.
  stageMs: {
    filed: 24 * HOUR, agreed: 48 * HOUR, queued: 10 * MINUTE, built: 20 * MINUTE,
    checked: 10 * MINUTE, reviewed: 2 * HOUR, landable: 60 * MINUTE,
  } as Partial<Record<TaskStage, number>>,
  // A tick older than this is the first line of `status`.
  tickStaleMs: 15 * MINUTE,
  // The server's timers (src/runtime/timers.mjs): the crons wrangler.jsonc
  // named, */5, */10 and 7 */6 (UTC).
  timers: {
    stageTickMs: 5 * MINUTE,
    stuckEpisodesMs: 10 * MINUTE,
    modelSnapshotsMs: 6 * HOUR,
    modelSnapshotsOffsetMs: 7 * MINUTE,
  },
  // A stuck episode open this long is due a notice (src/stuck/notices.ts),
  // unless the developer's standing notice-delay says otherwise.
  noticeAfterMs: 60 * MINUTE,
  // Under the standing queue-landable instruction, how many more times the
  // tick queues a landing again because main moved (decideLandQueue).
  landRequeuesForMain: 2,
};

// The stage limits, as src/rules.ts has always exported them: the same
// object, so a change through LIMITS is seen here too.
export const STAGE_LIMITS_MS: Readonly<typeof LIMITS.stageMs> = LIMITS.stageMs;
