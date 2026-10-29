// The Worker's scheduled() and queue() handlers, removed in Atelier 2.0 task
// 8: the Node server runs the three crons on timers (src/runtime/timers.mjs)
// and records a push from the post-receive hook (observePushed). The Workers
// specs, skipped by name until task 7 rewrites them (test/workers-skipped.txt),
// call these in their place: scheduled() runs the job its cron named, as the
// handler did; queue() is gone and says so.
import { recordStageTicks, recordStuckEpisodes, takeModelSnapshots } from "../src/index.ts";

export async function scheduled(controller: { scheduledTime: number; cron: string }, env: Env): Promise<void> {
  if (controller.cron === "*/5 * * * *") { await recordStageTicks(env, new Date(controller.scheduledTime)); return; }
  if (controller.cron === "*/10 * * * *") { await recordStuckEpisodes(env, new Date(controller.scheduledTime)); return; }
  await takeModelSnapshots(env, controller.scheduledTime);
}

export async function queue(_batch: unknown, _env: unknown): Promise<void> {
  throw new Error("queue() was removed in Atelier 2.0 task 8: a push is recorded by the post-receive hook (test/post-receive.test.mjs)");
}
