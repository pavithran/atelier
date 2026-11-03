// atelier flow. Forms, flags and help live in src/usage/commands/flow.ts; the
// phases are defined in docs/flow.md and computed by src/flow.ts from the
// events the item route already returns, so no server route is needed.
import { formatScorecard, computeFlow } from "../../src/flow.ts";
import { I, OWNER, P, actor, args, die, project, request } from "../atelier.mjs";

const DEFAULT_SINCE = "7d";
// An ISO date or time, or a span back from now: 3d, 12h.
function sinceMs(text, now) {
  const span = /^(\d+(?:\.\d+)?)([dh])$/.exec(text);
  if (span) return now - Number(span[1]) * (span[2] === "d" ? 86_400_000 : 3_600_000);
  const at = Date.parse(text);
  if (!Number.isFinite(at)) die(`--since ${text} is not an ISO date or time or a span such as 3d or 12h`, 2);
  return at;
}

export default async function flowCommand() {
  const name = project(), as = await actor(OWNER), now = Date.now();
  const since = sinceMs(typeof args.since === "string" ? args.since : DEFAULT_SINCE, now);
  const listed = await request("GET", P(name), undefined, as);
  const chosen = (listed.items ?? []).filter((item) => Date.parse(item.createdAt) >= since);
  // A few reads at a time: each task's events come from its own route.
  const tasks = new Array(chosen.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, chosen.length) }, async () => {
    while (next < chosen.length) {
      const i = next++;
      const d = await request("GET", I(name, chosen[i].id), undefined, as);
      tasks[i] = { id: chosen[i].id, events: d.events ?? [] };
    }
  }));
  const report = computeFlow(tasks, now);
  if (args.json) return console.log(JSON.stringify({ project: name, since: new Date(since).toISOString(), observedAt: new Date(now).toISOString(), ...report }, null, 2));

  for (const line of formatScorecard(report)) console.log(line);
}
